"""配置存储：内存态 + JSON 常驻镜像 + 运行时状态。

网页推来的配置是「已解析好的完整快照」（角色名、人设、模型参数、连接信息都算好了），
本服务不再回头去猜——只负责存、取、报告新鲜度。
"""
import json
import os
import threading
import time

# 数据目录可用环境变量覆盖（QQ_BOT_DATA_DIR）：
# 便于在同一台机器上另起一个实例做验证，而不污染正在用的那份配置。
DATA_DIR = os.getenv('QQ_BOT_DATA_DIR') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'data')
AUDIO_DIR = os.path.join(DATA_DIR, 'audio')

_LOCK = threading.RLock()


def _defaults():
    """当前生效配置。存的是**网页已解析过的快照**。"""
    return {
        'version': 1,
        'enabled': False,
        'sourceChatId': None,        # 选中的角色来自哪个对话
        'sourceChatTitle': '',
        'sourceDbName': '',          # 网页侧的 IndexedDB 库名（仅用于排错展示）
        'role': {},                  # ROLE_LEVEL_KEYS 子集：roleName/persona/温度等
        'model': {},                 # {modelHost, apiKey, modelName, kind}
        'knowledge': {'enabled': False, 'ids': [], 'apiBase': '', 'topK': 3, 'minScore': 0.4},
        'tts': {'enabled': False, 'apiUrl': '', 'apiKey': '', 'voiceId': ''},
        'trigger': {
            'cooldownSec': 10,       # 同会话冷却
            'globalCooldownSec': 3,  # 全局冷却（防止多群同时刷）
            'hourlyQuota': 60,       # 每个群每小时回复上限
            'privateHourlyQuota': 120,  # 每个私聊会话每小时回复上限（独立配额）
            'mentionBypass': True,   # @ 是否无视冷却
            'probability': 0.25,     # 群聊里非 @ 消息的通过概率（抖动）
            # ---- 分条发送 ----
            'replyPartMaxChars': 80,   # 单条消息建议字数上限（超出按句切分）
            'replyPartsMax': 3,        # 群聊最多分几条（私聊自动 +1）
            'partSendDelayMs': 400,    # 分条之间的停顿，模拟真人连发
            # 旧字段保留：作为新字段缺失时的回退，别删（老配置里只有它们）
            'replySplitChars': 120,
            'maxRepliesPerMessage': 1,
        },
        'context': {'historyLimit': 12, 'groupScope': 'per_group'},
        # ---- 引用回复（出站消息带上 reply 段，指向触发它的那条消息）----
        'reply': {
            'enabled': True,          # 群聊里是否引用回复（私聊恒开：一对一里引用不啰嗦）
            'showOriginal': True,     # 让协议端顺带展示被引用的原文
        },
        # ---- 戳一戳 ----
        'poke': {
            'enabled': True,          # 被戳时是否回应
            'cooldownSec': 60,        # 同会话内两次回应之间的最短间隔
            'hourlyQuota': 20,        # 每小时上限（与消息配额相互独立，另算一本账）
            'content': '',            # 固定回复文本；留空 = 走模型生成（更符合人设）
            'sendPokeBack': False,    # 回应时是否反戳一下（NapCat 支持出站 poke 段）
        },
        'updatedAt': 0,
        'updatedBy': '',             # 推送来源描述（便于排错）
    }


class ConfigStore:
    """配置的读写与持久化。所有公开方法都加锁，供多线程（WS 事件 + HTTP）共用。"""

    def __init__(self, path=None):
        self.path = path or os.path.join(DATA_DIR, 'qq_config.json')
        self._cfg = _defaults()
        self.last_push_at = 0
        self.push_count = 0
        os.makedirs(DATA_DIR, exist_ok=True)
        os.makedirs(AUDIO_DIR, exist_ok=True)
        self._load()

    # ---------- 持久化 ----------

    def _load(self):
        """启动时读镜像。文件缺失 / 损坏都不致命，退回默认值即可。"""
        with _LOCK:
            if not os.path.exists(self.path):
                return
            try:
                with open(self.path, 'r', encoding='utf-8') as f:
                    disk = json.load(f)
                if isinstance(disk, dict):
                    self._cfg = self._merge(_defaults(), disk)
            except Exception as e:      # noqa: BLE001 - 配置损坏绝不能拖垮服务
                print(f'[QQ] 配置文件读取失败，使用默认配置：{e}')

    def _save(self):
        """原子写：先写临时文件再替换，避免断电留下半截 JSON。"""
        tmp = self.path + '.tmp'
        try:
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self._cfg, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)
        except Exception as e:          # noqa: BLE001
            print(f'[QQ] 配置写入失败：{e}')

    @staticmethod
    def _merge(base, patch):
        """一层深合并：嵌套字典逐键覆盖，其余整体替换。"""
        out = dict(base)
        for k, v in (patch or {}).items():
            if isinstance(v, dict) and isinstance(out.get(k), dict):
                out[k] = ConfigStore._merge(out[k], v)
            else:
                out[k] = v
        return out

    # ---------- 对外接口 ----------

    def snapshot(self):
        with _LOCK:
            return json.loads(json.dumps(self._cfg))   # 深拷贝，防止调用方改到内部状态

    def update(self, patch, source='web'):
        """网页推送配置。整包覆盖式合并——网页每次推的都是完整快照。"""
        with _LOCK:
            self._cfg = self._merge(self._cfg, patch or {})
            self._cfg['updatedAt'] = int(time.time())
            self._cfg['updatedBy'] = source
            self.last_push_at = time.time()
            self.push_count += 1
            self._save()
            return self.snapshot()

    def is_ready(self):
        """是否具备「能回话」的最小条件：开启 + 有角色名 + 有模型地址与模型名。"""
        with _LOCK:
            if not self._cfg.get('enabled'):
                return False, '未开启 QQ 接入'
            role = self._cfg.get('role') or {}
            model = self._cfg.get('model') or {}
            if not (role.get('roleName') or '').strip():
                return False, '未选择接入角色（角色名为空）'
            if not (model.get('modelHost') or '').strip():
                return False, '模型地址为空'
            if not (model.get('modelName') or '').strip():
                return False, '模型名为空'
            return True, 'ok'

    def config_age_sec(self):
        """配置距今多久没更新了。网页把配置推过来之后才有意义。"""
        if not self.last_push_at:
            return None
        return int(time.time() - self.last_push_at)


# 进程内单例：WS 事件、HTTP 接口共用同一份状态
store = ConfigStore()
