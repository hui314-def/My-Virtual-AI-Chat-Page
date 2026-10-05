"""阶段自检：不依赖 fastapi / requests，只验证纯逻辑。

跑法：python backend_code/qq_bot/_selfcheck.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Windows 控制台默认 GBK，输出中文与符号可能炸；统一按 UTF-8 输出
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:      # noqa: BLE001
    pass

# 自检**不碰真实配置**：换成临时文件，避免把 data/qq_config.json 里的真实设置改掉，
# 也避免被上一次运行的状态污染导致结论不可复现。
from qq_bot import config_store as _cs         # noqa: E402

_probe_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_selfcheck_tmp')
os.makedirs(_probe_dir, exist_ok=True)
# 每次运行都从干净配置开始：上次运行结束时的 enabled=True 会残留到磁盘，
# 不删掉的话「默认未启用」这条断言第二次跑就会失败（自检必须可重复运行）。
_probe_cfg = os.path.join(_probe_dir, 'cfg.json')
if os.path.exists(_probe_cfg):
    os.remove(_probe_cfg)
_cs.store = _cs.ConfigStore(path=_probe_cfg)

from qq_bot.config_store import store          # noqa: E402
from qq_bot.trigger import gate                # noqa: E402
from qq_bot.prompt_builder import (            # noqa: E402
    render_macros, build_roleplay_prompt, build_private_prompt, build_poke_prompt,
    clean_reply, split_reply, _is_ollama,
)
from qq_bot import qq_bot_api as api           # noqa: E402

FAIL = []


def check(name, got, want):
    ok = got == want
    print(f'  {"PASS" if ok else "FAIL"}  {name}')
    if not ok:
        print(f'        期望: {want!r}')
        print(f'        实际: {got!r}')
        FAIL.append(name)


print('=== 1. 配置存储 ===')
snap = store.snapshot()
check('默认未启用', snap['enabled'], False)
ready, why = store.is_ready()
check('未启用时不就绪', ready, False)
print(f'        原因：{why}')

store.update({
    'enabled': True,
    'role': {'roleName': '鲸鱼娘', 'persona': '一只害羞的鲸鱼娘。', 'temperature': 0.85, 'maxTokens': 300},
    'model': {'modelHost': 'http://localhost:11434', 'modelName': 'qwen3.5:9b'},
    'knowledge': {'enabled': False, 'ids': ['kb1'], 'apiBase': 'http://localhost:5051'},
    'tts': {'enabled': False, 'apiUrl': 'http://localhost:5000', 'voiceId': 'default'},
    'trigger': {'cooldownSec': 5, 'globalCooldownSec': 0, 'hourlyQuota': 3,
                'mentionBypass': True, 'probability': 0.0, 'maxRepliesPerMessage': 1,
                'replySplitChars': 120},
})
ready, why = store.is_ready()
check('配置齐备后就绪', ready, True)
check('角色名继承', store.snapshot()['role']['roleName'], '鲸鱼娘')

print()
print('=== 2. 模型类型判定 ===')
check('ollama 端口识别', _is_ollama('http://localhost:11434'), True)
check('OpenAI 兼容识别', _is_ollama('https://api.deepseek.com/v1'), False)
check('kind 显式覆盖', _is_ollama('http://x', 'openai'), False)

print()
print('=== 3. SillyTavern 宏 ===')
check('{{char}}', render_macros('我是{{char}}', {'roleName': '鲸鱼娘'}), '我是鲸鱼娘')
check('{{user}}', render_macros('你好{{user}}', {'userName': '小明'}), '你好小明')
check('未知宏原样保留', render_macros('{{roll:1d20}}'), '{{roll:1d20}}')
check('无宏时不变', render_macros('普通文本'), '普通文本')

print()
print('=== 4. 提示词构建 ===')
cfg = store.snapshot()
msgs = build_roleplay_prompt(
    cfg,
    members=['小明', '小红'],
    transcript=[('小明', '今天好累啊')],
    speaker_name='小明',
    user_bio='喜欢钓鱼',
    user_text='晚饭吃什么好呢',
)
check('返回两条消息', len(msgs), 2)
check('第一条是 system', msgs[0]['role'], 'system')
system = msgs[0]['content']
check('人设已注入', '害羞的鲸鱼娘' in system, True)
check('角色名已注入', '鲸鱼娘' in system, True)
check('含 QQ 群聊规则', '【QQ 群聊规则】' in system, True)
check('含禁链接要求', '链接' in system, True)
check('含群成员', '小明' in system, True)
check('知识库未启用时不注入', '知识库资料' in system, False)
check('user 含转录', '小明：今天好累啊' in msgs[1]['content'], True)

# ★ 回归：本条消息必须传进 user 消息（曾经整段漏掉，模型看不到用户说了什么）
user_msg = msgs[1]['content']
check('user 含【本条消息】区块', '【本条消息】' in user_msg, True)
check('本条消息正文已传入', '晚饭吃什么好呢' in user_msg, True)
check('本条消息带发言人', '小明：晚饭吃什么好呢' in user_msg, True)
check('本条消息只出现一次', user_msg.count('晚饭吃什么好呢'), 1)

# 只 @ 了机器人、没带正文时的兜底
msgs_nb = build_roleplay_prompt(cfg, [], [], '小明', '', user_text='')
check('无正文时有兜底说明', '没有说别的' in msgs_nb[1]['content'], True)

cfg2 = store.snapshot()
msgs2 = build_roleplay_prompt(cfg2, [], [], '小明', '', knowledge_text='- （来自《手册》）测试内容')
check('知识库启用后注入', '知识库资料' in msgs2[0]['content'], True)

print()
print('=== 5. 回复清洗 ===')
check('去 think 标签',
      clean_reply('<think>内心戏</think>你好呀'), '你好呀')
check('去 soul 标签',
      clean_reply('<soul>秘密</soul>我在呢'), '我在呢')
check('去加粗星号',
      clean_reply('这是**很重要**的事'), '这是很重要的事')
check('去标题井号',
      clean_reply('## 标题\n正文'), '标题\n正文')
check('去链接',
      clean_reply('详见 https://example.com/a 哦'), '详见 哦')
check('去代码围栏',
      clean_reply('```python\nprint(1)\n```'), 'print(1)')
check('去名字前缀',
      clean_reply('鲸鱼娘：你好呀', '鲸鱼娘'), '你好呀')
check('保留括号动作',
      clean_reply('（轻轻叹气）我相信你。'), '（轻轻叹气）我相信你。')

print()
print('=== 6. 长回复切分 ===')
parts = split_reply('第一句。第二句。第三句。', 120)
check('短文本不切', parts, ['第一句。第二句。第三句。'])
long_text = '。'.join([f'这是第{i}个用来测试切分的长句子内容' for i in range(20)]) + '。'
parts = split_reply(long_text, 60)
check('长文本被切分', len(parts) > 1, True)
check('每段不超过上限太多', all(len(p) <= 70 for p in parts), True)
print(f'        切成 {len(parts)} 段，首段：{parts[0][:40]}…')

print()
print('=== 6.5 分条发送（模型用分隔符主动分条）===')
# 模型配合时：按它自己的断句分，不要被二次按句号拆碎
parts = split_reply('你好呀。|||今天过得怎么样？|||我一直在等你。', 80, 5)
check('按分隔符分成三条', len(parts), 3)
check('第一条内容正确', parts[0], '你好呀。')
check('第三条内容正确', parts[2], '我一直在等你。')
check('分隔符本身没被发出', all('|||' not in p for p in parts), True)

# 容错：模型用错变体分隔符
check('容错 || 变体', len(split_reply('第一句||第二句', 80, 5)), 2)
check('容错全角斜杠变体', len(split_reply('第一句／／第二句', 80, 5)), 2)
check('单独成行的 // 也算分隔符', len(split_reply('第一句\n//\n第二句', 80, 5)), 2)
# 行内的 // 不应当被误切（可能是路径、也可以是正文，误切比不切更糟）
check('行内 // 不误切', len(split_reply('这句话里有个 // 竖杠斜杠', 80, 5)), 1)
check('空段被丢弃', len(split_reply('第一句||||||第二句', 80, 5)), 2)
check('结尾多余分隔符不产生空消息', len(split_reply('只有一句话。|||', 80, 5)), 1)

# 条数上限：多出来的内容合并进最后一条，而不是丢掉
parts = split_reply('甲。|||乙。|||丙。|||丁。|||戊。', 80, 3)
check('超出条数上限会合并', len(parts), 3)
check('内容没有被丢弃', ''.join(parts).count('。'), 5)

# 模型不配合时：仍按句兜底切分，不会发出一整坨
parts = split_reply('。'.join(['这是一个很长的句子用来验证兜底切分'] * 6) + '。', 50, 9)
check('未用分隔符也能切分', len(parts) > 1, True)
check('兜底切分每段不超限', all(len(p) <= 50 for p in parts), True)

# 单条上限为 0/非法值时不崩（回退到默认）
check('非法上限不崩溃', len(split_reply('测试。', 0, 3)) >= 1, True)

print()
print('=== 7. 触发闸门（第一版策略）===')
gate._history.clear()
gate._reply_times.clear()
gate._last_reply_group.clear()
gate._last_reply_global = 0.0

# 未 @ 的群消息：现在会先被"点名闸门"拦下（这是修复后的正确行为）。
# 抖动层是给"允许非 @ 插话"的场景用的，用 require_mention=False 单独验证。
d = gate.should_reply('group_1', False, '随便聊聊')
check('群聊没 @ 被闸门拦下', d.allowed, False)
check('拦下原因是未被点名', d.reason, 'not_mentioned')
d = gate.should_reply('group_1', False, '允许插话的场景', require_mention=False)
check('允许插话但概率为0 → 抖动拦下', d.allowed, False)
check('拦下原因是抖动', d.reason, 'jitter')

# @ → 无视概率直接放行
d = gate.should_reply('group_1', True, '@机器人 你好')
check('@ 直接放行', d.allowed, True)
check('放行原因为 allowed', d.reason, 'allowed')

# 冷却：5 秒内再 @ 也要拦（mentionBypass=true 时会绕过冷却）
d = gate.should_reply('group_1', True, '@机器人 再来一句')
check('@ 绕过冷却（mentionBypass）', d.allowed, True)

# 关掉 bypass 再验证冷却生效
store.update({'trigger': {'mentionBypass': False}})
d = gate.should_reply('group_1', True, '@机器人 第三句')
check('关掉 bypass 后冷却生效', d.allowed, False)
check('拦下原因是冷却', d.reason, 'cooldown')

# 另一个群不受同群冷却影响（全局冷却为 0）
d = gate.should_reply('group_2', True, '@机器人 换个群')
check('换群不受同群冷却影响', d.allowed, True)

# 配额：硬上限——先清干净计时，再验证「@ 也突破不了」
gate._reply_times.clear()
gate._last_reply_group.clear()
gate._last_reply_global = 0.0
store.update({'trigger': {'cooldownSec': 0, 'globalCooldownSec': 0, 'hourlyQuota': 3, 'mentionBypass': True}})
for i in range(3):
    gate.should_reply('group_2', True, f'第{i + 1}次')
d = gate.should_reply('group_2', True, '第四次（仍然 @ 了）')
check('配额是硬上限：@ 也突破不了', d.allowed, False)
check('拦下原因是配额', d.reason, 'quota')
check('配额按群独立统计', gate.should_reply('group_other', True, '别的群照常').allowed, True)

print()
print('=== 7.5 私聊链路（曾经被整段丢弃，现在必须走通）===')
# 私聊提示词：共用角色锚定，但外壳必须是一对一
pmsgs = build_private_prompt(
    store.snapshot(),
    transcript=[('小明', '你在吗'), ('鲸鱼娘', '呜……我在的。')],
    speaker_name='小明',
    user_bio='喜欢钓鱼',
    user_text='那我先走了',
)
check('私聊返回两条消息', len(pmsgs), 2)
psystem = pmsgs[0]['content']
check('私聊仍继承人设', '害羞的鲸鱼娘' in psystem, True)
check('私聊含私聊规则', '【QQ 私聊规则】' in psystem, True)
check('私聊含禁链接要求', '链接' in psystem, True)
check('私聊不出现群聊外壳', '群聊规则' in psystem, False)
check('私聊不出现"群里其他人"', '群里正在聊天的人有' in psystem, False)
check('私聊 user 含对话记录', '你在吗' in pmsgs[1]['content'], True)
# ★ 同一回归：私聊的本条消息也必须传进去
check('私聊含【本条消息】区块', '【本条消息】' in pmsgs[1]['content'], True)
check('私聊本条消息已传入', '那我先走了' in pmsgs[1]['content'], True)
check('私聊本条消息只出现一次', pmsgs[1]['content'].count('那我先走了'), 1)
check('私聊无正文时有兜底', '没有说别的' in build_private_prompt(
    store.snapshot(), [], '小明', '', user_text='')[1]['content'], True)

# 私聊判定：不 @ 也必须放行（私聊里每句话都是对机器人说的）
gate._reply_times.clear()
gate._last_reply_group.clear()
gate._last_reply_global = 0.0
store.update({'trigger': {'cooldownSec': 30, 'globalCooldownSec': 0, 'hourlyQuota': 5,
                          'privateHourlyQuota': 3, 'mentionBypass': True, 'probability': 0.0}})
# 调用方对私聊会把 mentioned 置 True → 不抖、不受冷却限制
d = gate.should_reply('private_20002', True, '在吗', require_mention=False, is_private=True)
check('私聊不 @ 也放行', d.allowed, True)
d = gate.should_reply('private_20002', True, '再问一句', require_mention=False, is_private=True)
check('私聊不受群冷却限制', d.allowed, True)

# 私聊用独立配额（privateHourlyQuota=3）：用满后第 4 次必须拦
gate.should_reply('private_20002', True, '第三次', require_mention=False, is_private=True)
d = gate.should_reply('private_20002', True, '第四次', require_mention=False, is_private=True)
check('私聊配额独立且是硬上限', d.allowed, False)
check('私聊拦截原因是配额', d.reason, 'quota')
# 群配额（hourlyQuota=5）不应被私聊消耗掉
check('私聊不消耗群配额', gate.should_reply('group_fresh', True, '群里照常').allowed, True)

# 群聊的"没 @ 就丢弃"要变成有解释的记录，而不是静默 return
gate._stats['dropped'].clear()
d = gate.should_reply('group_x', False, '路人闲聊')
check('群聊没 @ 被拦下', d.allowed, False)
check('拦下原因是未被点名', d.reason, 'not_mentioned')

print()
print('=== 8. 上下文记忆 ===')
gate.remember('group_9', '小明', '今天天气不错')
gate.remember('group_9', '小红', '是啊')
h = gate.history('group_9')
check('历史被记录', len(h), 2)
check('历史内容正确', h[0][2], '今天天气不错')
check('历史上限生效', len(gate.history('group_9', limit=1)), 1)

print()
print('=== 9. 运行统计 ===')
stats = gate.stats()
print(f'        收到 {stats["seen"]} 条 · 回复 {stats["replied"]} 条 · 丢弃 {stats["dropped"]}')
check('统计含被丢弃分类', isinstance(stats['dropped'], dict), True)

print()
print('=== 10. 引用回复 ===')
# 消息段解析：文本 + @ + 引用 三种段混在一起
t, m, r = api._extract([
    {'type': 'reply', 'data': {'id': '900'}},
    {'type': 'at', 'data': {'qq': '10001'}},
    {'type': 'text', 'data': {'text': ' 在吗'}},
], '10001')
check('提取出正文', t, '在吗')
check('识别出 @', m, True)
check('提取出被引用消息 ID', r, '900')

t2, m2, r2 = api._extract([{'type': 'text', 'data': {'text': '普通消息'}}], '10001')
check('无引用时 reply_id 为空', r2, '')
check('无 @ 时不误报', m2, False)

# 出站消息 ID 记录 → 用于识别"有人回复了机器人"
check('未记录过的 ID 不算回复机器人', api._is_reply_to_bot('123456'), False)
api._remember_sent(123456)
check('记录后能认出回复机器人', api._is_reply_to_bot('123456'), True)
api._remember_sent(None)          # 空 ID 不应抛异常
api._remember_sent('')
check('空 ID 记录不报错', api._is_reply_to_bot(''), False)

# 引用段的构造：群聊受开关控制，私聊恒开
rep_cfg = {'reply': {'enabled': True, 'showOriginal': True}}
segs = api._reply_segments(rep_cfg, is_group=True, reply_id='900')
check('群聊开启时生成引用段', len(segs), 1)
check('引用段类型正确', segs[0]['type'], 'reply')
check('引用段带正确 ID', segs[0]['data']['id'], '900')
check('无 reply_id 时不生成', len(api._reply_segments(rep_cfg, True, '')), 0)
check('群聊关闭时不生成',
      len(api._reply_segments({'reply': {'enabled': False}}, is_group=True, reply_id='900')), 0)
check('私聊恒开（不受群聊开关影响）',
      len(api._reply_segments({'reply': {'enabled': False}}, is_group=False, reply_id='900')), 1)

print()
print('=== 11. 戳一戳 ===')
# 事件识别：不同协议端写法有出入，只在确定是戳一戳时才认
check('notice/notify/poke 识别', api._is_poke_event(
    {'post_type': 'notice', 'notice_type': 'notify', 'sub_type': 'poke'}), True)
check('普通 notice 不误判', api._is_poke_event(
    {'post_type': 'notice', 'notice_type': 'notify', 'sub_type': 'honor'}), False)
check('消息事件不误判', api._is_poke_event({'post_type': 'message'}), False)

# 戳一戳提示词：共用角色锚定，外壳是"被戳了一下"
poke_msgs = build_poke_prompt(store.snapshot(), [('小明', '在吗')], '小鱼', '')
poke_sys = poke_msgs[0]['content']
check('戳一戳返回两条消息', len(poke_msgs), 2)
check('戳一戳仍继承人设', '害羞的鲸鱼娘' in poke_sys, True)
check('含戳一戳外壳', '【有人戳了你一下】' in poke_sys, True)
check('要求简短反应', '20~40 字' in poke_sys, True)
check('戳一戳 user 提示被戳', '戳了你一下' in poke_msgs[1]['content'], True)
check('私聊戳语气不同', '私聊里' in build_poke_prompt(
    store.snapshot(), [], '小鱼', '', is_private=True)[0]['content'], True)

# 戳一戳限流：独立冷却与独立配额，且不与消息额度互相挤占
gate._reply_times.clear()
gate._last_reply_group.clear()
gate._last_reply_global = 0.0
store.update({'trigger': {'cooldownSec': 10, 'globalCooldownSec': 0, 'hourlyQuota': 5,
                          'privateHourlyQuota': 5, 'mentionBypass': True, 'probability': 0.0}})
ok1, r1 = gate.record_poke('group_p', cooldown=60, quota=3)
check('首次戳一戳放行', ok1, True)
ok2, r2 = gate.record_poke('group_p', cooldown=60, quota=3)
check('冷却内的第二次被拦', ok2, False)
check('拦下原因是冷却', r2, 'cooldown')
# 换一个群不受该群冷却影响
check('换群不受同群戳冷却影响', gate.record_poke('group_q', 60, 3)[0], True)
# 独立配额：戳一戳用满后，消息额度不受影响
gate._reply_times.clear()
gate._last_reply_group.clear()
gate._last_reply_global = 0.0
for _ in range(3):
    gate.record_poke('group_p', cooldown=0, quota=3)
ok3, r3 = gate.record_poke('group_p', cooldown=0, quota=3)
check('戳一戳配额是硬上限', ok3, False)
check('拦下原因是配额', r3, 'quota')
check('戳一戳不消耗消息配额', gate.should_reply('group_new', True, '消息照常').allowed, True)

# 冷却会**过期**：等过冷却后应当又能回应
# （端到端不方便测这条——需要等真实时间，且依赖 HTTP 假模型服务的存活）
gate._reply_times.clear()
gate._last_reply_group.clear()
gate._last_reply_global = 0.0
check('冷却前首次戳放行', gate.record_poke('group_exp', cooldown=1, quota=10)[0], True)
check('冷却内立刻再戳被拦', gate.record_poke('group_exp', cooldown=1, quota=10)[0], False)
time.sleep(1.15)
check('过了冷却后又能回应（冷却是真的会过期）',
      gate.record_poke('group_exp', cooldown=1, quota=10)[0], True)

print()
if FAIL:
    print(f'[FAILED] {len(FAIL)} 项未通过：{FAIL}')
    sys.exit(1)
print('[OK] 全部通过')
