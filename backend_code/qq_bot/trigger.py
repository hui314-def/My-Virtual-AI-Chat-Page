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
        """核心判定。返回 Decision；放行时会顺便从统计里扣掉冷却/配额。

        @param require_mention: 群聊传 True（没 @ 就不进入判定）；
                                群聊的"非 @ 插话"靠 probability 抖动控制。
        @param is_private: 私聊传 True。私聊里每条消息都是对机器人说的，
                           因此调用方会把 mentioned 置 True —— 既不抖也不受冷却限制，
                           否则用户必须"@机器人"才能收到回复，很反直觉。
                           同时改用独立的 privateHourlyQuota 配额。
        """
        cfg = store.snapshot()
        trig = cfg.get('trigger') or {}
        now = time.time()

        with self._lock:
            self._stats['seen'] += 1

            # ---- 闸门：群聊必须被 @（或回复机器人）才进入判定 ----
            if require_mention and not mentioned:
                return self._drop('not_mentioned', mentioned, '群里没人 @ 它')

            # ---- 第二层：节奏 ----
            # 分两类，语义不同，不能混在一起：
            #   · 配额（hourlyQuota）是**硬上限**：@ 也不能突破，否则热闹群里
            #     被人连点就会烧光额度、还可能被群友拉黑。
            #   · 冷却（cooldown）是**礼貌**：@ 默认无视，否则用户点名时装死很蠢。
            # 私聊用独立配额（privateHourlyQuota）：朋友来私聊不该被群里的额度挤掉。
            if is_private:
                quota = int(trig.get('privateHourlyQuota', 120) or 0)
            else:
                quota = int(trig.get('hourlyQuota', 60) or 0)
            if quota > 0:
                q = self._reply_times[group_key]
                while q and (now - q[0]) > 3600:
                    q.popleft()
                if len(q) >= quota:
                    return self._drop('quota', mentioned, f'本会话每小时上限 {quota} 条已用完')

            bypass_cooldown = bool(trig.get('mentionBypass', True)) and mentioned
            if not bypass_cooldown:
                cooldown = float(trig.get('cooldownSec', 10) or 0)
                last = self._last_reply_group.get(group_key, 0.0)
                if cooldown > 0 and (now - last) < cooldown:
                    return self._drop('cooldown', mentioned, f'同会话冷却中（{cooldown - (now - last):.1f}s）')

                gcooldown = float(trig.get('globalCooldownSec', 3) or 0)
                if gcooldown > 0 and (now - self._last_reply_global) < gcooldown:
                    return self._drop('global_cooldown', mentioned, '全局冷却中')

            # ---- 第三层：随机抖动 ----
            # 只作用于群聊的"非 @ 插话"；@ 与私聊都不抖（点名 / 私聊必答）。
            if not mentioned:
                p = float(trig.get('probability', 0.25))
                p = min(1.0, max(0.0, p))
                if random.random() > p:
                    return self._drop('jitter', mentioned, f'随机抖动未通过（p={p}）')

            # ---- 放行：登记时间戳 ----
            self._last_reply_global = now
            self._last_reply_group[group_key] = now
            self._reply_times[group_key].append(now)
            self._stats['replied'] += 1
            return Decision(True, 'allowed', mentioned, text)

    def _drop(self, key, mentioned, reason):
        self._stats['dropped'][key] += 1
        return Decision(False, key, mentioned, '')

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
