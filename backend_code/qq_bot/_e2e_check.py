"""端到端自检：真正连一次反向 WS，走完整处理链路。

需要桥接服务已在 5052 端口运行。
跑法：python backend_code/qq_bot/_e2e_check.py
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:      # noqa: BLE001
    pass

import requests
from websockets.sync.client import connect

# 目标地址可用环境变量覆盖，便于在不打扰正在运行的服务时另起实例验证：
#   set QQ_BOT_BASE=http://127.0.0.1:5053
BASE = os.getenv('QQ_BOT_BASE', 'http://127.0.0.1:5052').rstrip('/')
WS = BASE.replace('https://', 'wss://').replace('http://', 'ws://') + '/onebot/ws'
FAIL = []

# 每次运行的唯一前缀：服务端有跨运行持久的 message_id 去重（防协议端重放），
# 如果这里写死 ID，**第二次运行的消息会被当成重放直接丢弃**，测试就不可重复了。
RUN_TAG = str(int(time.time() * 1000) % 100000000)

# 假模型服务返回的文本（故意带 Markdown 与链接，验证清洗链路）
STUB_TEXT = ''


class _StubHandler(BaseHTTPRequestHandler):
    """OpenAI 兼容的最小假模型：只实现 /v1/chat/completions。"""

    def do_POST(self):                                  # noqa: N802
        length = int(self.headers.get('Content-Length') or 0)
        self.rfile.read(length)
        body = json.dumps({
            'choices': [{'message': {'role': 'assistant', 'content': STUB_TEXT}}],
            'usage': {'prompt_tokens': 1, 'completion_tokens': 1},
        }).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):                       # 静音
        pass


def check(name, got, want=True):
    ok = got == want
    print(f'  {"PASS" if ok else "FAIL"}  {name}')
    if not ok:
        print(f'        期望: {want!r}  实际: {got!r}')
        FAIL.append(name)


def _free_port():
    """要一个空闲端口给假模型服务用。

    写死端口会踩两个坑：上一轮的监听还没释放时 bind 失败；残留连接让第二次运行
    连不上。让系统分配就永远不会有这个问题，测试也就能重复跑。
    """
    import socket
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


print('=== 1. 服务可达性 ===')
try:
    root = requests.get(f'{BASE}/', timeout=8).json()
    check('服务在线', root.get('service'), 'QQ Bot Bridge')
except Exception as e:      # noqa: BLE001
    print(f'  FAIL  服务不可达：{e}')
    sys.exit(1)

print()
print('=== 2. 中文角色名 UTF-8 往返 ===')
# 用 requests 发（它按 UTF-8 编码，不受 PowerShell 控制台代码页影响）
payload = {
    'version': 1,
    'enabled': True,
    'sourceChatId': 'chat-demo-1',
    'sourceChatTitle': '鲸鱼娘的对话',
    'role': {
        'roleName': '鲸鱼娘',
        'persona': '一只害羞内向的海洋鲸鱼娘，说话常带省略号。',
        'cardExampleMessages': '{{user}}：你好\n{{char}}：呜……你好呀。',
        'temperature': 0.85, 'topP': 0.9, 'maxTokens': 300,
    },
    # 故意指向一个不存在的模型端口：我们要验证"判定放行 → 尝试调模型 → 失败被兜住"
    'model': {'modelHost': 'http://127.0.0.1:59999', 'apiKey': '', 'modelName': 'test-model', 'kind': 'openai'},
    'user': {'name': '访客', 'bio': '喜欢钓鱼'},
    'knowledge': {'enabled': False, 'ids': [], 'apiBase': 'http://localhost:5051'},
    'tts': {'enabled': False, 'apiUrl': '', 'apiKey': '', 'voiceId': 'default'},
    'trigger': {'cooldownSec': 0, 'globalCooldownSec': 0, 'hourlyQuota': 100,
                'mentionBypass': True, 'probability': 0.0, 'maxRepliesPerMessage': 1,
                'replySplitChars': 120},
    '_source': 'e2e-check',
}
r = requests.post(f'{BASE}/qq/config', json=payload, timeout=8).json()
check('推送成功', r.get('ok'))
check('配置就绪', r.get('ready'))

disk_ok = False
# 数据目录与 config_store 的解析规则保持一致（支持 QQ_BOT_DATA_DIR 覆盖）
_data_dir = os.getenv('QQ_BOT_DATA_DIR') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'data')
cfg_path = os.path.join(_data_dir, 'qq_config.json')
try:
    with open(cfg_path, encoding='utf-8') as f:
        disk = json.load(f)
    disk_ok = disk.get('role', {}).get('roleName') == '鲸鱼娘'
except Exception as e:      # noqa: BLE001
    print(f'        读盘失败：{e}')
check('中文角色名在磁盘镜像中无损', disk_ok)
if disk_ok:
    print(f'        落盘角色名：{disk["role"]["roleName"]} · 人设：{disk["role"]["persona"][:16]}…')

print()
print('=== 3. 反向 WS：连接并上报一条 @ 消息 ===')
WS1 = {}
try:
    with connect(WS, open_timeout=8) as ws:
        print(f'  · 已连接 {WS}')

        # 先发 lifecycle，让服务学会 self_id
        ws.send(json.dumps({'post_type': 'meta_event', 'meta_event_type': 'lifecycle',
                            'self_id': 10001, 'time': int(time.time())}))
        time.sleep(0.4)

        # 连接还在时就读一次运行状态——"协议端在线"必须趁热验证，
        # 断开之后 online 自然变回 false（这是正确行为，不是缺陷）。
        mid = requests.get(f'{BASE}/qq/runtime', timeout=8).json()
        check('协议端登记为已在线（连接期间）', mid.get('online'))
        check('机器人 QQ 已被识别', mid.get('selfId'), '10001')

        # 再发一条「@机器人」的群消息 → 应当被判为放行
        ws.send(json.dumps({
            'post_type': 'message', 'message_type': 'group',
            'self_id': 10001, 'group_id': 888888, 'user_id': 20002,
            'message_id': f'{RUN_TAG}1', 'time': int(time.time()),
            'sender': {'user_id': 20002, 'nickname': '小明', 'card': '小明'},
            'message': [
                {'type': 'at', 'data': {'qq': '10001'}},
                {'type': 'text', 'data': {'text': ' 你好呀'}},
            ],
        }))
        # 给服务一点时间：判定 → 调模型（会失败）→ 记录日志
        time.sleep(2.5)
        # 把服务可能推回来的动作读干净（这一版服务不回动作，读到超时即止）
        try:
            while True:
                msg = ws.recv(timeout=0.4)
                if not msg:
                    break
                WS1.setdefault('actions', []).append(msg)
        except Exception:       # noqa: BLE001 - 超时即视为读干净
            pass
except Exception as e:      # noqa: BLE001
    print(f'  FAIL  WS 连接失败：{type(e).__name__}: {e}')
    FAIL.append('WS 连接')

print()
print('=== 4. 服务侧运行状态（含被拦统计与日志）===')
rt = requests.get(f'{BASE}/qq/runtime', timeout=8).json()
check('断开后协议端状态回到未连接（符合预期）', rt.get('online'), False)
check('角色名正确回传', rt.get('roleName'), '鲸鱼娘')

stats = rt.get('stats') or {}
print(f'        收到 {stats.get("seen")} 条 · 放行 {stats.get("replied")} 条'
      f' · 拦下 {stats.get("dropped")}')
check('@ 消息被放行（未判定丢弃）', (stats.get('replied') or 0) >= 1)

logs = rt.get('logs') or []
joined = ' | '.join(l.get('text', '') for l in logs)
print('        最近日志：')
for l in logs[-6:]:
    print(f'          {l.get("text")}')
# 模型地址是假的，所以应当看到"处理消息出错"而不是静默失败——
# 这恰好证明"放行之后确实去调了模型"，且异常被兜住了
has_model_attempt = ('处理消息出错' in joined) or ('回复' in joined)
check('放行后确实走到了调模型这一步（失败已被兜住）', has_model_attempt)

print()
print('=== 5. 正向链路：用假模型服务验证「真的把回复发回了 QQ」 ===')
# 起一个假模型端点，模拟模型**按分隔符主动分条**的回复：
# 同时验证「清洗 + 按分隔符切分 + 依次发回」这一整段——这是最容易出问题的一段。
STUB_PORT = _free_port()
STUB_TEXT = (
    '## 标题\n'
    '**第一段**内容呀。详情见 https://example.com/x 哦。'
    '|||这是模型的第二条消息。'
    '|||这是模型的第三条消息。'
)

stub = HTTPServer(('127.0.0.1', STUB_PORT), _StubHandler)
threading.Thread(target=stub.serve_forever, daemon=True).start()
print(f'  · 假模型服务已启动 :{STUB_PORT}')

# 把模型指向假服务，并把冷却/配额放宽（我们只验证正向链路本身）
payload2 = json.loads(json.dumps(payload))
payload2['model'] = {'modelHost': f'http://127.0.0.1:{STUB_PORT}', 'apiKey': '',
                     'modelName': 'stub-model', 'kind': 'openai'}
payload2['trigger']['cooldownSec'] = 0
payload2['trigger']['globalCooldownSec'] = 0
payload2['_source'] = 'e2e-check-stub'
requests.post(f'{BASE}/qq/config', json=payload2, timeout=8)

sent = []
try:
    with connect(WS, open_timeout=8) as ws:
        ws.send(json.dumps({'post_type': 'meta_event', 'meta_event_type': 'lifecycle',
                            'self_id': 10001, 'time': int(time.time())}))
        time.sleep(0.3)
        ws.send(json.dumps({
            'post_type': 'message', 'message_type': 'group',
            'self_id': 10001, 'group_id': 777777, 'user_id': 20005,
            'message_id': f'{RUN_TAG}3', 'time': int(time.time()),
            'sender': {'user_id': 20005, 'nickname': '小鱼'},
            'message': [
                {'type': 'at', 'data': {'qq': '10001'}},
                {'type': 'text', 'data': {'text': ' 说点什么吧'}},
            ],
        }))
        # 等待服务把动作推回来：模型分了几条，就应当收到几个动作
        deadline = time.time() + 10
        while time.time() < deadline and len(sent) < 3:
            try:
                raw = ws.recv(timeout=1.0)
            except Exception:       # noqa: BLE001 - 超时继续等
                continue
            if not raw:
                continue
            sent.append(json.loads(raw))
except Exception as e:      # noqa: BLE001
    print(f'  连接异常：{type(e).__name__}: {e}')

# 注意：stub 先不关——第 7 节还要用（见该节注释）
print(f'  · 桥接服务推回的动作数：{len(sent)}（模型给了 3 条，期望收到 3 个）')
check('三条回复被拆成三次发送', len(sent), 3)


def _text_of(action):
    segs = (action.get('params') or {}).get('message') or []
    return ''.join(s.get('data', {}).get('text', '') for s in segs if s.get('type') == 'text')


if sent:
    action = sent[0]
    check('动作类型正确', action.get('action'), 'send_group_msg')
    check('发到正确的群', str((action.get('params') or {}).get('group_id')), '777777')

    texts = [_text_of(a) for a in sent]
    for i, t in enumerate(texts, 1):
        print(f'        第 {i} 条：{t}')

    joined = ''.join(texts)
    check('分隔符本身没有被发出去', '|||' not in joined)
    check('三条内容都在', all(k in joined for k in ('第一段', '第二条消息', '第三条消息')), True)
    check('分条顺序正确',
          texts[0].find('第一段') >= 0 and '第二条消息' in texts[1] and '第三条消息' in texts[2], True)
    check('Markdown 标题符号被清掉', '##' not in joined)
    check('加粗星号被清掉', '**' not in joined)
    check('链接被清掉', 'http' not in joined)
    check('每一条都不超长', all(len(t) <= 100 for t in texts), True)

print()
print('=== 6. 频控：非 @ 消息不应触发 ===')
before = (requests.get(f'{BASE}/qq/runtime', timeout=8).json().get('stats') or {}).get('replied', 0)
try:
    with connect(WS, open_timeout=8) as ws:
        ws.send(json.dumps({'post_type': 'meta_event', 'meta_event_type': 'lifecycle',
                            'self_id': 10001, 'time': int(time.time())}))
        time.sleep(0.3)
        # probability=0 且没有 @ → 必须被抖动层拦下
        ws.send(json.dumps({
            'post_type': 'message', 'message_type': 'group',
            'self_id': 10001, 'group_id': 888888, 'user_id': 20003,
            'message_id': f'{RUN_TAG}2', 'time': int(time.time()),
            'sender': {'user_id': 20003, 'nickname': '小红'},
            'message': [{'type': 'text', 'data': {'text': '大家好啊'}}],
        }))
        time.sleep(1.5)
except Exception as e:      # noqa: BLE001
    print(f'  连接异常（忽略）：{e}')

after_rt = requests.get(f'{BASE}/qq/runtime', timeout=8).json()
after = (after_rt.get('stats') or {}).get('replied', 0)
check('非 @ 消息未被放行', after, before)
print(f'        放行计数：{before} → {after}（应保持不变）')
print(f'        被拦分类：{(after_rt.get("stats") or {}).get("dropped")}')

print()
print('=== 7. 私聊链路：不带 @ 也必须收到回复（曾经的 bug）===')
# 这一段是回归测试：第一版把 message_type='private' 的消息整段丢弃，
# 症状正是「服务端正常接收、但私聊永远没回应」。
# 注意：假模型服务必须一直活着到私聊跑完——提前 shutdown 会让模型调用
# 命中"连接被重置"，于是收不到动作，看起来像功能坏了。
private_actions = []
try:
    with connect(WS, open_timeout=8) as ws:
        ws.send(json.dumps({'post_type': 'meta_event', 'meta_event_type': 'lifecycle',
                            'self_id': 10001, 'time': int(time.time())}))
        time.sleep(0.3)
        # 私聊不带任何 @，也不带 group_id
        ws.send(json.dumps({
            'post_type': 'message', 'message_type': 'private',
            'self_id': 10001, 'user_id': 20007,
            'message_id': f'{RUN_TAG}4', 'time': int(time.time()),
            'sender': {'user_id': 20007, 'nickname': '小鱼儿'},
            'message': [{'type': 'text', 'data': {'text': '在吗，聊两句'}}],
        }))
        deadline = time.time() + 10
        while time.time() < deadline and len(private_actions) < 3:
            try:
                raw = ws.recv(timeout=1.0)
            except Exception:       # noqa: BLE001 - 超时继续等
                continue
            if not raw:
                continue
            private_actions.append(json.loads(raw))
except Exception as e:      # noqa: BLE001
    print(f'  连接异常：{type(e).__name__}: {e}')

print(f'  · 私聊推回的动作数：{len(private_actions)}')
check('私聊也发出了消息动作', len(private_actions) >= 1)
if private_actions:
    act = private_actions[0]
    check('私聊用的是 send_private_msg', act.get('action'), 'send_private_msg')
    check('私聊发给正确的用户', str((act.get('params') or {}).get('user_id')), '20007')
    check('私聊的三个动作都是发给同一个人',
          all(a.get('action') == 'send_private_msg' for a in private_actions), True)
    ptexts = [_text_of(a) for a in private_actions]
    for i, t in enumerate(ptexts, 1):
        print(f'        私聊第 {i} 条：{t}')
    pjoined = ''.join(ptexts)
    check('私聊内容非空', len(pjoined) > 5)
    check('私聊输出同样被清洗', 'http' not in pjoined and '**' not in pjoined)
    check('私聊也不把分隔符发出去', '|||' not in pjoined)

# 私聊上下文与群聊上下文必须互相隔离
rt7 = requests.get(f'{BASE}/qq/runtime', timeout=8).json()
check('私聊会话被单独跟踪', (rt7.get('stats') or {}).get('trackedGroups', 0) >= 1)

print()
print('=== 8. 多连接：响应必须发回"带来事件的那条连接" ===')
# 背景：NapCat 可能重连、也可能同时开多条反向 WS。早期实现只留"一个槽位"记录连接，
# 谁最后连上谁覆盖它 —— 那样动作可能被发到一条已经死掉的连接上。
# 这里同时开两条连接，从**第二条**发事件，验证动作落回第二条而不是第一条。
_chan_a, _chan_b = [], []
try:
    with connect(WS, open_timeout=8) as ws_a:
        ws_a.send(json.dumps({'post_type': 'meta_event', 'meta_event_type': 'lifecycle',
                              'self_id': 10001, 'time': int(time.time())}))
        time.sleep(0.3)
        with connect(WS, open_timeout=8) as ws_b:
            ws_b.send(json.dumps({'post_type': 'meta_event', 'meta_event_type': 'lifecycle',
                                  'self_id': 10001, 'time': int(time.time())}))
            time.sleep(0.3)

            rt8 = requests.get(f'{BASE}/qq/runtime', timeout=8).json()
            check('两条连接都被登记', rt8.get('channelCount'), 2)

            # 从 B 发事件
            ws_b.send(json.dumps({
                'post_type': 'message', 'message_type': 'group',
                'self_id': 10001, 'group_id': 666001, 'user_id': 20008,
                'message_id': f'{RUN_TAG}5', 'time': int(time.time()),
                'sender': {'user_id': 20008, 'nickname': '双通道测试'},
                'message': [{'type': 'at', 'data': {'qq': '10001'}},
                            {'type': 'text', 'data': {'text': ' 在吗'}}],
            }))

            deadline = time.time() + 10
            while time.time() < deadline and not _chan_b:
                try:
                    raw = ws_b.recv(timeout=1.0)
                except Exception:       # noqa: BLE001
                    continue
                if raw:
                    _chan_b.append(json.loads(raw))

            # A 不应该收到任何东西（事件不是从它来的）
            try:
                while True:
                    raw = ws_a.recv(timeout=0.4)
                    if not raw:
                        break
                    _chan_a.append(json.loads(raw))
            except Exception:       # noqa: BLE001 - 超时即视为没收到
                pass
except Exception as e:      # noqa: BLE001
    print(f'  连接异常：{type(e).__name__}: {e}')

print(f'  · 连接 B 收到 {len(_chan_b)} 个动作，连接 A 收到 {len(_chan_a)} 个')
check('事件来源连接收到了响应', len(_chan_b) >= 1)
check('另一条连接没有收到响应（没有发错连接）', len(_chan_a), 0)

print()
print('=== 9. 接口应答帧不应被当成异常 ===')
# 发消息之后协议端会回一个 {"status":"ok","retcode":0,"data":{...}} 的应答帧，
# 和事件共用同一条 WS。早期版本会打 warn 说"事件缺少 post_type"——那是误报。
try:
    with connect(WS, open_timeout=8) as ws_ack:
        ws_ack.send(json.dumps({'post_type': 'meta_event', 'meta_event_type': 'lifecycle',
                                'self_id': 10001, 'time': int(time.time())}))
        time.sleep(0.3)
        ws_ack.send(json.dumps({'status': 'ok', 'retcode': 0,
                                'data': {'message_id': 1338174280},
                                'message': '', 'wording': '', 'echo': 'probe1', 'stream': 'normal-action'}))
        time.sleep(1.2)
except Exception as e:      # noqa: BLE001
    print(f'  连接异常：{type(e).__name__}: {e}')

# 只看最近的日志窗口——服务端日志是环形缓冲，取尾部即可
rt9 = requests.get(f'{BASE}/qq/runtime?full=1', timeout=8).json()
texts = [l.get('text', '') for l in (rt9.get('logs') or [])[-25:]]
warned = [t for t in texts if '无法识别的帧' in t or '缺少 post_type' in t]
trace_ack = [t for t in texts if '接口应答' in t]
print(f'  · 相关日志：{trace_ack or "（无）"}')
check('应答帧被识别为应答', len(trace_ack) >= 1)
check('应答帧不再被报警', len(warned), 0)

# 到这里假模型服务不再需要了
stub.shutdown()

print()
if FAIL:
    print(f'[FAILED] {len(FAIL)} 项未通过：{FAIL}')
    sys.exit(1)
print('[OK] 端到端全部通过')
