"""触发策略（第一版：@触发 + 冷却 / 配额 / 随机抖动）。

**刻意不做语义判断**——热闹群里真正省钱、也真正防骚扰的是「闸门 + 节奏」，
而不是拿辅助模型去筛每一条消息（那样成本反而更高）。
等这版在真实群里跑稳了，再决定要不要叠加 auxModel 的语义层。

消息流经这里只有两种命运：被丢弃（只记入上下文）或被放行（去调模型）。
"""
import random
import threading
import time
from collections import defaultdict, deque

from .config_store import store

# 每个群保留的最近消息条数上限（防止冷群无限堆积）
MAX_TRACKED_GROUPS = 200


class Decision:
    """一次触发判定的结果。allowed=False 时 reason 说明被哪一层拦下。"""

    __slots__ = ('allowed', 'reason', 'mentioned', 'stripped')

    def __init__(self, allowed, reason, mentioned=False, stripped=''):
        self.allowed = allowed
        self.reason = reason
        self.mentioned = mentioned
        self.stripped = stripped

    def __repr__(self):
        return f'<Decision allowed={self.allowed} reason={self.reason} mentioned={self.mentioned}>'


class TriggerGate:
    """三层拦截：@闸门 → 节奏（冷却/配额）→ 随机抖动。"""

    def __init__(self):
        self._lock = threading.RLock()
        self._last_reply_global = 0.0            # 全局上次回复时间
        self._last_reply_group = {}              # group_key -> 上次回复时间
        self._reply_times = defaultdict(deque)   # group_key -> [时间戳]（滑动窗口算配额）
        self._history = defaultdict(deque)       # group_key -> [(time, sender, text)]
        self._stats = {'seen': 0, 'replied': 0, 'dropped': defaultdict(int)}

    # ---------- 上下文记录 ----------

    def remember(self, group_key, sender, text):
        """无论回不回，都把消息记进上下文——不然模型看不到别人在聊什么。"""
        h = self._history[group_key]
        h.append((time.time(), sender, text))
        limit = int((store.snapshot().get('context') or {}).get('historyLimit', 12) or 12)
        # 多留一些余量，供编排 / 排错时回看
        while len(h) > max(limit * 2, 24):
            h.popleft()
        with self._lock:
            if len(self._history) > MAX_TRACKED_GROUPS:
                oldest = min(self._history.items(), key=lambda kv: kv[1][-1][0] if kv[1] else 0)
                self._history.pop(oldest[0], None)

    def history(self, group_key, limit=None):
        cfg = store.snapshot()
        n = int(limit or (cfg.get('context') or {}).get('historyLimit', 12) or 12)
        return list(self._history.get(group_key, []))[-n:]

    # ---------- 判定 ----------

    def should_reply(self, group_key, mentioned, text, sender_id='', bot_id='',
                     require_mention=True, is_private=False):
        """群聊 / 私聊消息的判定。返回 Decision。

        @param require_mention: 群聊传 True（没 @ 就不进入判定）；
                                群聊的"非 @ 插话"靠 probability 抖动控制。
        @param is_private: 私聊传 True。私聊里每条消息都是对机器人说的，
                           调用方会把 mentioned 置 True —— 既不抖也不受冷却限制，
                           否则用户必须"@机器人"才能收到回复，很反直觉。
                           同时改用独立的 privateHourlyQuota 配额。
        """
        allowed, reason = self.respond(
            group_key, mentioned=mentioned,
            require_mention=require_mention, is_private=is_private,
        )
        return Decision(allowed, 'allowed' if allowed else reason, mentioned, text)

    def respond(self, group_key, mentioned=False, require_mention=False,
                is_private=False, cooldown=None, quota=None, jitter=None,
                extra_bypass=False, honor_cooldown=False):
        """通用限流闸门：消息与戳一戳共用。返回 (allowed, reason)。

        三种限制的**语义分工**（整套策略的核心，改动前先想清楚）：
          · 配额（hourlyQuota / privateHourlyQuota）是**硬上限**——被点名也突破不了。
            否则热闹群里被人连点就会烧光额度、还可能被群友拉黑。
          · 冷却（cooldown）是**礼貌**——被点名时可以无视，否则用户点名时装死很蠢。
          · 抖动（jitter / probability）只用于"允许非点名插话"的场景。

        @param mentioned: 是否被点名（@ 了机器人 / 回复了机器人 / 私聊）。
        @param cooldown: 本次使用的冷却秒数；None = 用全局 trigger.cooldownSec。
        @param quota:    本次使用的每小时配额；None = 按 is_private 取全局配置。
        @param jitter:   本次使用的通过概率；None = 用全局 trigger.probability。
        @param extra_bypass: 额外的无视冷却开关。
        @param honor_cooldown: 即使被点名也**强制走冷却**。
            戳一戳需要这个：它用 mentioned=True 只是为了跳过抖动（被戳就该答），
            但戳的频率天然高，如果连冷却也一起绕过，戳的冷却就形同虚设了。
        """
        cfg = store.snapshot()
        trig = cfg.get('trigger') or {}
        now = time.time()

        with self._lock:
            self._stats['seen'] += 1

            # ---- 闸门：要求点名却没被点名 ----
            if require_mention and not mentioned:
                return self._deny('not_mentioned')

            # ---- 第二层：节奏 ----
            if quota is None:
                quota = (int(trig.get('privateHourlyQuota', 120) or 0) if is_private
                         else int(trig.get('hourlyQuota', 60) or 0))
            if quota > 0:
                q = self._reply_times[group_key]
                while q and (now - q[0]) > 3600:
                    q.popleft()
                if len(q) >= quota:
                    return self._deny('quota')

            bypass_cooldown = bool(trig.get('mentionBypass', True)) and mentioned
            if honor_cooldown:
                bypass_cooldown = False
            if extra_bypass:
                bypass_cooldown = True
            if not bypass_cooldown:
                cd = float(cooldown if cooldown is not None
                           else (trig.get('cooldownSec', 10) or 0))
                last = self._last_reply_group.get(group_key, 0.0)
                if cd > 0 and (now - last) < cd:
                    return self._deny('cooldown')

                gcd = float(trig.get('globalCooldownSec', 3) or 0)
                if gcd > 0 and (now - self._last_reply_global) < gcd:
                    return self._deny('global_cooldown')

            # ---- 第三层：随机抖动 ----
            # 只作用于"非点名的插话"；@ 与私聊都不抖（点名 / 私聊必答）。
            if not mentioned:
                p = float(jitter if jitter is not None
                          else trig.get('probability', 0.25))
                p = min(1.0, max(0.0, p))
                if random.random() > p:
                    return self._deny('jitter')

            # ---- 放行：登记时间戳 ----
            self._last_reply_global = now
            self._last_reply_group[group_key] = now
            self._reply_times[group_key].append(now)
            self._stats['replied'] += 1
            return True, 'allowed'

    def record_poke(self, group_key, cooldown=60, quota=20):
        """戳一戳判定：独立冷却与独立上限，**不与消息配额互相挤占**。

        为什么必须独立：戳一戳是"轻互动"，频率天然比消息高；若共用消息配额，
        群里几个人戳几下就能把当天的聊天额度耗光——那显然不合理。

        `mentioned=True` 只用于跳过抖动（被戳就该答）；冷却用 honor_cooldown
        强制生效，否则 mentionBypass 会把戳的冷却一起放行掉。
        """
        return self.respond(group_key, mentioned=True, require_mention=False,
                            cooldown=cooldown, quota=quota, honor_cooldown=True)

    def _deny(self, key):
        """记一笔"被拦下"的统计并返回失败原因。"""
        self._stats['dropped'][key] += 1
        return False, key

    def _drop(self, key, mentioned, reason):
        self._stats['dropped'][key] += 1
        return Decision(False, key, mentioned, '')

    # ---------- 状态重置 ----------

    def reset(self):
        """清空全部运行时状态：上下文历史、冷却计时、每小时配额、统计。

        用途：
          · 自检脚本要可重复运行（否则上一轮的历史会污染下一轮）
          · 运营排错：改完配置想从干净状态重新观察时，不用重启整个服务
        不触碰配置（配置由网页推送，另有 /qq/config）。
        """
        with self._lock:
            self._last_reply_global = 0.0
            self._last_reply_group.clear()
            self._reply_times.clear()
            self._history.clear()
            self._stats['seen'] = 0
            self._stats['replied'] = 0
            self._stats['dropped'].clear()

    # ---------- 运行状态 ----------

    def stats(self):
        with self._lock:
            return {
                'seen': self._stats['seen'],
                'replied': self._stats['replied'],
                'dropped': dict(self._stats['dropped']),
                'trackedGroups': len(self._history),
            }


gate = TriggerGate()
