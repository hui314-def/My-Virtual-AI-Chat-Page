"""QQ 接入桥接服务（FastAPI + OneBot 11）。

启动（在 backend_code 目录下）：
    python qq_bot/qq_bot_api.py

NapCat 侧配置「WebSocket 客户端」指向：
    ws://127.0.0.1:5052/onebot/ws      ← 反向 WS（推荐）
或把上报地址设为：
    http://127.0.0.1:5052/onebot/http  ← HTTP 上报（备用）

处理链路：
    OneBot 事件 → @闸门/冷却/配额/抖动 → 拼提示词 →（可选知识库）→ 调模型
    → 清洗 + 切分 →（可选语音）→ 发回 QQ
"""
import asyncio
import contextvars
import itertools
import os
import sys
import time
import threading

# 允许 `python qq_bot/qq_bot_api.py` 直接启动：把 backend_code 加进模块搜索路径，
# 这样相对导入（from .config_store import ...）才能正常解析。
if __package__ in (None, ''):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    __package__ = 'qq_bot'

import uvicorn
import requests
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from dotenv import load_dotenv

from .config_store import store, AUDIO_DIR
from .trigger import gate
from .prompt_builder import (
    build_roleplay_prompt, build_private_prompt, call_model, clean_reply, split_reply,
    retrieve_knowledge, synthesize_voice, audio_path, _part_limits,
)

load_dotenv()

PORT = int(os.getenv('QQ_BOT_PORT', '5052'))
PUBLIC_BASE = os.getenv('QQ_BOT_PUBLIC_BASE', f'http://127.0.0.1:{PORT}').rstrip('/')

app = FastAPI(title='QQ Bot Bridge API', version='1.0.0')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=False,
    allow_methods=['*'],
    allow_headers=['*'],
)

# ==================== 运行日志（环形，供 GUI 展示） ====================

_LOG = []
_LOG_LOCK = threading.Lock()
LOG_MAX = 200


def log(msg, level='info'):
    line = f'{time.strftime("%H:%M:%S")} {msg}'
    with _LOG_LOCK:
        # 全量留痕（含 trace）；要不要展示给用户由 /qq/runtime 决定
        _LOG.append({'time': time.time(), 'level': level, 'text': line})
        if len(_LOG) > LOG_MAX:
            del _LOG[:-LOG_MAX]
    if level != 'trace':
        print(f'[QQ] {msg}')


# ==================== OneBot 连接管理 ====================

# 当前正在处理的事件来自哪条连接。
# 为什么需要它：响应必须发回**带来这条事件的那条连接**。只保留"最后连上来的那条"
# 是错的——协议端重连或开第二条连接时，任务可能正发到一条快死掉的连接上。
_current_channel = contextvars.ContextVar('qq_current_channel', default=None)


class Channel:
    """一条 OneBot 反向 WS 连接。

    ⚠ 线程模型的坑（踩过一次）：事件处理跑在 worker 线程里（模型调用是阻塞的），
    而 FastAPI 的 `WebSocket.send_json` 是**协程**、且必须由持有该连接的事件循环来跑。
    在 worker 线程里直接 `ws.send_json(...)` 只会得到
    "coroutine 'WebSocket.send_json' was never awaited" —— 消息静默发不出去。
    所以这里必须：捕获连接时的事件循环 → 用 run_coroutine_threadsafe 投递 → 等结果。
    """

    def __init__(self, cid, ws, loop):
        self.id = cid
        self.ws = ws
        self.loop = loop
        self.alive = True
        self.connected_at = time.time()
        self.peer = f'{ws.client.host}:{ws.client.port}' if getattr(ws, 'client', None) else '未知'
        self.send_lock = threading.RLock()   # 串行化同一连接的写入
        self.pending = {}                    # echo -> threading.Event

    def close(self):
        self.alive = False
        for ev in list(self.pending.values()):
            ev.set()                         # 唤醒所有等待者，避免永久阻塞

    @staticmethod
    async def _await_as_task(coro):
        """包一层，让 run_coroutine_threadsafe 拿到的 future 能反映真实成败。"""
        return await asyncio.ensure_future(coro)

    def send(self, payload, timeout=15):
        """向本条连接发一个动作。返回 (ok, detail)。"""
        if not self.alive:
            return False, '连接已关闭'
        with self.send_lock:
            coro = self.ws.send_json(payload)
            try:
                try:
                    running = asyncio.get_running_loop()
                except RuntimeError:
                    running = None
                if running is not None and running is self.loop:
                    # 就在本连接的事件循环线程里 → 派发成任务即可
                    self.loop.create_task(self._await_as_task(coro))
                    return True, 'ws:task'
                if self.loop is None or self.loop.is_closed():
                    coro.close()
                    return False, 'WS 事件循环不可用'
                fut = asyncio.run_coroutine_threadsafe(self._await_as_task(coro), self.loop)
                fut.result(timeout=timeout)
                return True, 'ws'
            except Exception as e:      # noqa: BLE001
                try:
                    coro.close()
                except Exception:       # noqa: BLE001
                    pass
                return False, f'WS 发送失败：{type(e).__name__}: {e}'


class OneBotClient:
    """管理到协议端的连接，并把动作（发消息）送到正确的连接上。

    连接按 id 登记，不再是"一个槽位"。发送时优先用**处理该事件的连接**（contextvar），
    它失败了才退到任意一条活连接，最后才退到 HTTP API。
    """

    def __init__(self):
        self.channels = {}
        self.lock = threading.RLock()
        self.connected_at = 0
        self.self_id = ''
        self.echo_seq = 0
        self._seq_lock = threading.Lock()

    # ---------- 连接登记 ----------

    def add(self, channel):
        with self.lock:
            self.channels[channel.id] = channel
            self.connected_at = time.time()
        return channel

    def remove(self, channel):
        channel.close()
        with self.lock:
            if self.channels.get(channel.id) is channel:
                self.channels.pop(channel.id, None)
            self.connected_at = max((c.connected_at for c in self.channels.values()), default=0)

    def _alive(self):
        with self.lock:
            return [c for c in self.channels.values() if c.alive]

    def is_online(self):
        return bool(self._alive())

    def channel_count(self):
        return len(self._alive())

    def status(self):
        return [{'id': c.id, 'peer': c.peer, 'connectedAt': c.connected_at}
                for c in self._alive()]

    # ---------- 发送 ----------

    def call(self, action, params, timeout=30):
        """发送一个 OneBot 动作。返回 (ok, detail)。

        不强制要求 echo——OneBot 允许不带，带了只是多一种关联手段。
        """
        payload = {'action': action, 'params': params or {}}

        # 1) 优先发回"带来当前事件的那条连接"
        candidates = []
        channel = _current_channel.get()
        if channel is not None and channel.alive:
            candidates.append(channel)
        # 2) 退到任意一条活连接
        candidates.extend([c for c in self._alive() if c not in candidates])

        last_detail = '没有可用的 WS 连接'
        for ch in candidates:
            ok, detail = ch.send(payload, timeout)
            if ok:
                return True, f'{detail}@{ch.id}'
            last_detail = detail

        # 3) 最后退到 HTTP API（地址由网页配置推送）
        cfg = store.snapshot()
        base = ((cfg.get('onebot') or {}).get('apiBase') or '').rstrip('/')
        if not base:
            return False, f'{last_detail}，且未配置 OneBot HTTP 地址'
        try:
            r = requests.post(f'{base}/{action}', json=params or {}, timeout=timeout)
            return r.status_code < 400, f'http {r.status_code}'
        except Exception as e:          # noqa: BLE001
            return False, f'{last_detail}；HTTP 回退也失败：{e}'


onebot = OneBotClient()

# 连接 id 自增序号（多设备 / 重连时可从日志区分是哪条连接）
_cid_seq = itertools.count(1)

# 已处理过的 message_id 集合：OneBot 断线重连可能重放事件，去重防止重复回话
_seen_msg_ids = set()
_seen_lock = threading.Lock()
SEEN_MAX = 500


def _seen(message_id):
    """返回 True 表示这条消息已经处理过（应当跳过）。"""
    if not message_id:
        return False
    with _seen_lock:
        if message_id in _seen_msg_ids:
            return True
        _seen_msg_ids.add(message_id)
        if len(_seen_msg_ids) > SEEN_MAX:
            _seen_msg_ids.clear()      # 简单粗暴：满了整体清空，去重只防重放不追求精确
        return False


# ==================== 事件解析 ====================

def _segments(message):
    """把 OneBot 的 message 字段统一成数组形式。"""
    if isinstance(message, list):
        return message
    if isinstance(message, str):
        return [{'type': 'text', 'data': {'text': message}}]
    return []


def _extract(message, self_id=None):
    """从消息段里取出「纯文本」与「是否 @ 了机器人」。

    图片 / 语音 / 表情等非文本段直接丢弃——第一版不处理多模态输入。
    """
    bot_id = str(self_id or onebot.self_id or '')
    text_parts, mentioned = [], False
    for seg in _segments(message):
        if not isinstance(seg, dict):
            continue
        stype = seg.get('type')
        data = seg.get('data') or {}
        if stype == 'text':
            text_parts.append(str(data.get('text') or ''))
        elif stype == 'at':
            qq = str(data.get('qq') or '')
            # OneBot 用 qq='all' 表示 @全体成员；也兼容 self_id 是数字的情况
            if qq == 'all' or (bot_id and qq == bot_id):
                mentioned = True
    return ''.join(text_parts).strip(), mentioned


def _strip_leading_at(text):
    """去掉 @ 之后残留的前导空格。"""
    return (text or '').lstrip(' \u3000').strip()


def _sender_name(event):
    sender = event.get('sender') or {}
    return (sender.get('card') or sender.get('nickname') or
            str(event.get('user_id') or '某位群友')).strip()


# ==================== 核心处理 ====================

def handle_event(event, channel=None):
    """处理一条 OneBot 事件。任何异常都在这里被兜住——绝不能让机器人进程崩掉。

    @param channel: 这条事件是从哪条连接来的。响应会发回同一条连接
                    （见 OneBotClient.call 的候选顺序）。
    """
    post_type = event.get('post_type')
    if post_type == 'meta_event':
        if event.get('meta_event_type') == 'lifecycle':
            sid = str(event.get('self_id') or '')
            onebot.self_id = sid
            if channel is not None and sid:
                channel.self_id = sid
            log(f'协议端上线，机器人 QQ：{sid or "未知"}'
                f'{f"（连接 {channel.id}）" if channel else ""}')
        return
    if post_type != 'message':
        return
    log(f'进入消息处理：{event.get("message_type")} group={event.get("group_id")} '
        f'user={event.get("user_id")} msgid={event.get("message_id")}', 'trace')

    self_id = str(event.get('self_id') or '')
    if self_id and not onebot.self_id:
        onebot.self_id = self_id
    if str(event.get('user_id') or '') == self_id:
        log('跳过：这是机器人自己发的消息', 'trace')
        return                          # 自己的消息，忽略（防自回环）

    raw_type = event.get('message_type')
    group_id = event.get('group_id')
    is_group = raw_type == 'group' or (raw_type is None and group_id)
    # 私聊：OneBot 11 里 message_type 为 'private'。第一版曾在这里直接 return，
    # 导致私聊消息被静默丢弃（服务端"正常接收"却永远不回）——现在两条路都走。
    is_private = raw_type == 'private'
    if not is_group and not is_private:
        return                          # 其他类型（如频道）暂不支持

    if _seen(event.get('message_id')):
        log(f'跳过：message_id {event.get("message_id")} 已处理过（防协议端重放）', 'trace')
        return

    cfg = store.snapshot()
    if not cfg.get('enabled'):
        return

    user_id = event.get('user_id')
    # 会话键：群聊按群隔离，私聊按人隔离 —— 两种上下文互不串味
    group_key = f'group_{group_id}' if is_group else f'private_{user_id}'
    sender = _sender_name(event)
    text, mentioned = _extract(event.get('message'), self_id)
    text = _strip_leading_at(text)

    # 私聊里每条消息都是对机器人说的 → 视为已点名。
    # 这样既不参与「非 @ 抖动」，也不受同会话冷却限制（否则用户必须 @ 才能收到回复）。
    if is_private:
        mentioned = True

    # 无论回不回，都先记进上下文——否则模型看不到前面聊了什么
    if text:
        gate.remember(group_key, sender, text)

    decision = gate.should_reply(group_key, mentioned, text, user_id, self_id,
                                 require_mention=is_group, is_private=is_private)
    if not decision.allowed:
        return

    ok, why = store.is_ready()
    if not ok:
        log(f'跳过：{why}', 'warn')
        return

    # 只 @ 了机器人、没带正文：给个兜底话头，否则模型没有指令可依
    prompt_text = text or '（对方只是喊了你一声，没有说别的）'

    try:
        knowledge = retrieve_knowledge(cfg, prompt_text)

        history = gate.history(group_key)
        # 历史里最近一条就是本条消息，转录时去掉，避免与「请你回复」重复
        transcript = [(name, t) for _, name, t in history]
        if transcript and transcript[-1][1] == text:
            transcript = transcript[:-1]

        role_cfg = cfg.get('role') or {}
        role_name = (role_cfg.get('roleName') or '').strip()
        user_bio = (cfg.get('user') or {}).get('bio') or ''

        if is_private:
            messages = build_private_prompt(cfg, transcript, sender, user_bio, knowledge)
        else:
            members = sorted({name for _, name, _ in history
                              if name and name != role_cfg.get('roleName')})
            messages = build_roleplay_prompt(cfg, members, transcript, sender, user_bio, knowledge)

        raw = call_model(cfg, messages)
        cleaned = clean_reply(raw, role_name)
        if not cleaned:
            log('模型回复清洗后为空，已跳过', 'warn')
            return

        trig = cfg.get('trigger') or {}
        # 分条发送：优先按模型自己写的 `|||` 分条（它最懂断句），
        # 超长段再按句兜底切分；条数上限群聊比私聊保守。
        per_chars, max_parts = _part_limits(cfg, is_private=is_private)
        parts = split_reply(cleaned, per_chars, max_parts)
        if len(parts) > 1:
            log(f'本次回复拆成 {len(parts)} 条发送', 'trace')

        # 群聊 / 私聊只差动作名与目标参数，其余（语音、切分、失败留痕）完全共用
        if is_group:
            send_action = 'send_group_msg'
            target = {'group_id': group_id}
        else:
            send_action = 'send_private_msg'
            target = {'user_id': user_id}

        tts_cfg = cfg.get('tts') or {}
        send_failures = []
        # 分条之间的停顿：真人连发是有间隔的，同理也能避免过于密集触发频控。
        # 只在"确实分了多条"且不是最后一条时等待。
        gap_ms = max(0, min(3000, int(trig.get('partSendDelayMs', 400) or 0)))
        for idx, part in enumerate(parts):
            if idx > 0 and gap_ms:
                time.sleep(gap_ms / 1000.0)
            sent_voice = False
            if tts_cfg.get('enabled'):
                audio_name = synthesize_voice(cfg, part)
                if audio_name:
                    url = f'{PUBLIC_BASE}/audio/{audio_name}'
                    ok_send, detail = onebot.call(send_action, dict(target, message=[
                        {'type': 'record', 'data': {'file': url}},
                    ]))
                    sent_voice = ok_send
                    if not ok_send:
                        log(f'语音发送失败（{detail}），退回文本', 'warn')
            if not sent_voice:
                ok_send, detail = onebot.call(send_action, dict(target, message=[
                    {'type': 'text', 'data': {'text': part}},
                ]))
                # 发送失败必须留痕：否则会出现"日志说回复了，对方却没收到"的鬼故事
                if not ok_send:
                    send_failures.append(detail)
            # 机器人自己的发言也要进上下文，否则它会"忘记刚才说过什么"
            gate.remember(group_key, role_name or '我', part)

        scope = '私聊' if is_private else '群聊'
        if send_failures:
            log(f'[{group_key}]（{scope}）消息发送失败：{send_failures[0]}', 'error')
        else:
            log(f'[{group_key}]（{scope}）回复 {sender}：{cleaned[:60]}'
                f'{"…" if len(cleaned) > 60 else ""}'
                f'{"（含语音）" if tts_cfg.get("enabled") else ""}')
    except Exception as e:              # noqa: BLE001
        log(f'处理消息出错：{type(e).__name__}: {e}', 'error')


# ==================== HTTP 接口 ====================

@app.get('/')
def root():
    ok, why = store.is_ready()
    return {
        'service': 'QQ Bot Bridge',
        'online': onebot.is_online(),
        'ready': ok,
        'readyDetail': why,
        'port': PORT,
    }


@app.post('/qq/config')
async def push_config(request: Request):
    """网页推送配置。整包覆盖式合并（网页每次推的都是完整快照）。"""
    try:
        patch = await request.json()
    except Exception:                   # noqa: BLE001
        return JSONResponse({'ok': False, 'error': '请求体不是合法 JSON'}, status_code=400)
    if not isinstance(patch, dict):
        return JSONResponse({'ok': False, 'error': '配置必须是对象'}, status_code=400)

    snap = store.update(patch, source=str(patch.pop('_source', 'web') if isinstance(patch, dict) else 'web'))
    ok, why = store.is_ready()
    role = snap.get('role') or {}
    log(f'收到网页配置：{"启用" if snap.get("enabled") else "关闭"}'
        f' · 角色「{role.get("roleName") or "未选择"}」'
        f' · 知识库{"开" if (snap.get("knowledge") or {}).get("enabled") else "关"}'
        f' · 语音{"开" if (snap.get("tts") or {}).get("enabled") else "关"}')
    return {'ok': True, 'ready': ok, 'readyDetail': why, 'config': snap}


@app.get('/qq/runtime')
async def runtime(full: int = 0):
    """运行状态：前端「测试连接」按钮和排错用。

    @param full: full=1 时连 trace 级日志一起返回（排错用）。
                 `_extract` 里对每条消息都留了 trace，正常使用时不必看到。
    """
    ok, why = store.is_ready()
    cfg = store.snapshot()
    role = cfg.get('role') or {}
    logs = list(_LOG)
    if not full:
        logs = [l for l in logs if l.get('level') != 'trace']
    return {
        'ok': True,
        'online': onebot.is_online(),
        'connectedAt': onebot.connected_at,
        'selfId': onebot.self_id,
        'channelCount': onebot.channel_count(),
        'channels': onebot.status(),
        'ready': ok,
        'readyDetail': why,
        'enabled': bool(cfg.get('enabled')),
        'roleName': role.get('roleName') or '',
        'modelName': (cfg.get('model') or {}).get('modelName') or '',
        'configAgeSec': store.config_age_sec(),
        'pushCount': store.push_count,
        'trigger': (cfg.get('trigger') or {}),
        'stats': gate.stats(),
        'logs': logs[-40:],
    }


@app.get('/audio/{name}')
def serve_audio(name: str):
    """把合成的语音暴露成 HTTP 地址，让 NapCat 去拉取（跨机部署也能用）。"""
    path = audio_path(name)
    if not path:
        return JSONResponse({'ok': False, 'error': '文件不存在'}, status_code=404)
    return FileResponse(path, media_type='audio/wav')


@app.post('/onebot/http')
async def onebot_http(request: Request):
    """HTTP 上报备用通道（NapCat 里配置 HTTP 上报时用）。

    注意：走这条通道时，响应没有"原路"可回，会落到任意一条活 WS 连接
    或 HTTP API 上（见 OneBotClient.call 的候选顺序）。
    """
    try:
        payload = await request.json()
    except Exception:                   # noqa: BLE001
        return JSONResponse({'status': 'bad request'}, status_code=400)
    if _is_api_response(payload):
        log(f'HTTP 上报通道收到接口应答（已忽略）：{_brief(payload)}', 'trace')
        return {'status': 'ok', 'retcode': 0}
    threading.Thread(target=handle_event, args=(payload,), daemon=True).start()
    return {'status': 'ok', 'retcode': 0}


def _is_api_response(payload):
    """判断一帧是不是「接口调用应答」而不是「事件」。

    OneBot 里两者共用同一条 WS：
      · 事件帧   一定有 post_type（message / notice / request / meta_event）
      · 应答帧   没有 post_type，而是带 status/retcode，且通常带 echo
    发消息之后协议端就会回一个 {"status":"ok","retcode":0,"data":{"message_id":...}}，
    这是**正常应答**，不是异常数据——早期版本把它当成可疑帧打 warn，属于误报。
    """
    if not isinstance(payload, dict):
        return False
    if 'post_type' in payload:
        return False
    return ('status' in payload or 'retcode' in payload or 'echo' in payload
            or 'wording' in payload)


def _brief(payload):
    d = payload if isinstance(payload, dict) else {}
    return (f'status={d.get("status")} retcode={d.get("retcode")} '
            f'echo={d.get("echo") or "-"} data={str(d.get("data"))[:80]}')


@app.websocket('/onebot/ws')
async def onebot_ws(websocket: WebSocket):
    """OneBot 11 反向 WebSocket：NapCat 主动连过来，事件从这里进来。"""
    await websocket.accept()
    # 每条连接单独登记（不再"一个槽位"）：响应要发回带来事件的那条连接。
    channel = onebot.add(Channel(
        f'ws{next(_cid_seq)}',
        websocket,
        asyncio.get_running_loop(),
    ))
    log(f'协议端已连接（{channel.peer}，连接 {channel.id}）')
    try:
        while True:
            payload = await websocket.receive_json()
            if not isinstance(payload, dict):
                log(f'收到非字典帧，已忽略：{type(payload).__name__}', 'warn')
                continue

            # 接口应答帧：正常现象，trace 留痕即可（早期误报成 warn，噪音很大）
            if _is_api_response(payload):
                log(f'接口应答：{_brief(payload)}', 'trace')
                echo = payload.get('echo')
                if echo:
                    waiting = channel.pending.pop(echo, None)
                    if waiting:
                        waiting.set()
                continue

            if 'post_type' not in payload:
                # 既不是事件也不是已知应答：这才是真正需要关注的可疑帧
                log(f'无法识别的帧（既无 post_type 也无 status/retcode）：'
                    f'{str(payload)[:160]}', 'warn')
                continue

            # 事件到达与处理是两条独立的记录：出问题时能一眼区分
            # "没收到" 和 "收到了但被判定跳过"——这两种情况的排查方向完全不同。
            log(f'收到事件 {payload.get("post_type")}/{payload.get("message_type") or payload.get("meta_event_type") or ""}'
                f'{"·群 " + str(payload.get("group_id")) if payload.get("group_id") else ""}'
                f'{"·用户 " + str(payload.get("user_id")) if payload.get("user_id") else ""}', 'trace')
            threading.Thread(target=_run_in_channel, args=(payload, channel), daemon=True).start()
    except WebSocketDisconnect:
        log(f'协议端断开连接（连接 {channel.id}）', 'warn')
    except Exception as e:              # noqa: BLE001
        log(f'协议端连接异常（连接 {channel.id}）：{type(e).__name__}: {e}', 'warn')
    finally:
        onebot.remove(channel)


def _run_in_channel(event, channel):
    """在 worker 线程里处理事件，并把"当前连接"写进 contextvar。

    这样事件处理链路里任何一次 onebot.call(...) 都会优先发回**这条连接**，
    而不是"最后连上来的那条"。
    """
    token = _current_channel.set(channel)
    try:
        handle_event(event, channel)
    finally:
        _current_channel.reset(token)


if __name__ == '__main__':
    os.makedirs(AUDIO_DIR, exist_ok=True)
    ok, why = store.is_ready()
    print('=' * 60)
    print(f'  QQ 接入桥接服务 · 端口 {PORT}')
    print(f'  NapCat 反向 WS 地址：ws://127.0.0.1:{PORT}/onebot/ws')
    print(f'  NapCat HTTP 上报地址：http://127.0.0.1:{PORT}/onebot/http')
    print(f'  当前配置：{"就绪" if ok else "未就绪 — " + why}')
    print('  配置由网页「个性化设置 → QQ 接入」推送，先在网页上开启即可。')
    print('=' * 60)
    uvicorn.run(app, host='0.0.0.0', port=PORT)
