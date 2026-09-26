"""提示词构建 + 模型调用 + 知识库检索 + 语音合成。

**换壳不换芯**：角色人设 / 附加系统设定 / 示例对话 / 开场白**原样继承**角色卡，
连 SillyTavern 宏都有个轻量渲染器（对齐 js/core/utils.js 的 replaceSTMacros），
只把最外层的「群聊规则」换成 QQ 版本（纯文本、禁 Markdown、禁链接、短回复）。
"""
import hashlib
import os
import re
import time
import requests

from .config_store import AUDIO_DIR

# ==================== SillyTavern 宏（轻量版） ====================

_WEEKDAYS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']

# 前端有、后端拿不到上下文的宏：原样保留，避免误伤（与前端"未知宏原样保留"一致）
_UNKNOWN_MACROS = {'random', 'roll', 'newline', 'pipe', 'charVersion',
                   'input', 'lastMessage', 'lastCharMessage', 'lastUserMessage',
                   'firstMessage', '//'}


def render_macros(text, ctx=None):
    """渲染常用 SillyTavern 宏。未支持的一律原样保留，绝不静默删掉。"""
    if not text:
        return ''
    ctx = ctx or {}
    now = time.localtime()

    def repl(m):
        raw = m.group(1).strip()
        key = raw.split(':')[0].strip()
        low = key.lower()
        if low == 'char':
            return str(ctx.get('roleName', ''))
        if low == 'user':
            return str(ctx.get('userName', '')) or '对方'
        if low == 'date':
            return time.strftime('%Y-%m-%d', now)
        if low == 'time':
            return time.strftime('%H:%M', now)
        if low == 'datetime':
            return time.strftime('%Y-%m-%d %H:%M', now)
        if low == 'weekday':
            return _WEEKDAYS[now.tm_wday]
        if low in _UNKNOWN_MACROS:
            return m.group(0)   # 原样保留
        return m.group(0)       # 未知宏同样原样保留

    return re.sub(r'\{\{(.*?)\}\}', repl, str(text))


# ==================== 提示词构建 ====================

# 分条发送用的分隔符。选 `|||` 的理由：
#   · 正常中文聊天里几乎不会出现，不会误切正文
#   · 比换行更明确——需要时它可以出现在行内，不受排版影响
#   · 模型对这个 token 很熟（常见于结构化输出）
REPLY_PART_SEP = '|||'


def _part_limits(cfg, is_private=False):
    """返回 (单条字数上限, 最多条数)。群聊更保守，私聊可以稍多。"""
    trig = cfg.get('trigger') or {}
    per = int(trig.get('replyPartMaxChars', 0) or 0)
    if per <= 0:
        # 兼容旧配置：没设新字段就从 replySplitChars 推导
        per = int(trig.get('replySplitChars', 120) or 120)
    per = min(500, max(20, per))

    mx = int(trig.get('replyPartsMax', 0) or 0)
    if mx <= 0:
        # 旧字段 maxRepliesPerMessage 作为回退
        mx = int(trig.get('maxRepliesPerMessage', 3) or 3)
    mx = min(10, max(1, mx))
    if is_private:
        mx = min(10, mx + 1)        # 私聊可以多一条：朋友对话天然可以多说两句
    return per, mx


def _reply_char_limit(cfg, is_private=False):
    """给模型的软性建议字数：比硬上限略小，留出标点与括号的余量。"""
    per, _ = _part_limits(cfg, is_private)
    return max(20, int(per * 0.85))


def _roleplay_anchor(cfg, speaker_name, user_bio, knowledge_text, ctx):
    """角色锚定部分：人设 / 用户画像 / 角色卡附加内容 / 知识库。

    群聊与私聊**共用**这一段——区别只在外壳（群聊规则 vs 私聊规则）。
    这就是"换壳不换芯"：人设与角色卡永远原样继承，不因场景重新发明。
    """
    role = cfg.get('role') or {}
    role_name = (role.get('roleName') or '').strip() or '助手'

    system = (
        f'你是一位角色扮演者，你的姓名是"{role_name}"。关于你的角色简介是：\n\n'
        + render_macros(role.get('persona') or '', ctx)
        + f'\n\n总之你需要始终以"{role_name}"的身份和口吻回应。\n\n'
    )

    # 用户画像：优先对话级（userProfileName/Bio），否则用全局的
    prof_name = (role.get('userProfileName') or '').strip() or speaker_name
    prof_bio = (role.get('userProfileBio') or '').strip() or (user_bio or '')
    if prof_bio:
        system += f'关于和你对话的当前用户的名称是：{prof_name}，简介：{prof_bio}\n'
    else:
        system += f'关于和你对话的当前用户名称叫：{prof_name}。\n'

    # 角色卡附加内容：原样继承（示例对话对语气模仿帮助最大）
    if role.get('cardSystemPrompt'):
        system += f'\n\n【附加系统设定】\n{render_macros(role["cardSystemPrompt"], ctx)}'
    if role.get('cardExampleMessages'):
        system += f'\n\n【角色对话示例(用于模仿语气与风格)】\n{render_macros(role["cardExampleMessages"], ctx)}'

    if knowledge_text:
        system += (
            '\n\n【可参考的知识库资料】\n'
            '以下是本项目知识库中检索到的资料片段，请优先依据它们回答；'
            '资料里没有的内容不要编造，也不要在回复里贴出资料原文或来源链接。\n'
            f'{knowledge_text}'
        )
    return role_name, system


def build_roleplay_prompt(cfg, members, transcript, speaker_name, user_bio, knowledge_text=''):
    """群聊提示词：拼出 system + user 两条消息。

    @param members  : 群里其他人的显示名（不含自己）
    @param transcript: [(发送者名, 文本)] 最近群聊记录
    @param speaker_name: 本条触发消息的发送者
    """
    role = cfg.get('role') or {}
    ctx = {'roleName': (role.get('roleName') or '').strip() or '助手', 'userName': speaker_name}
    role_name, system = _roleplay_anchor(cfg, speaker_name, user_bio, knowledge_text, ctx)
    soft_limit = _reply_char_limit(cfg, is_private=False)

    # ---- 以下为 QQ 群聊外壳：网页那套是"一对一多人聊天室"，QQ 必须换 ----
    others = [m for m in (members or []) if m and m != role_name]
    system += '\n\n【你正在一个 QQ 群聊里】\n'
    system += ('群里正在聊天的人有：' + '、'.join(others) + '。\n') if others else '群里目前比较安静。\n'
    system += (
        '聊天记录里每条消息都会以「发言人名字：内容」的形式给出，方便你分辨是谁说的。\n\n'
        '【QQ 群聊规则】\n'
        f'1. 只以「{role_name}」自己的身份发言，绝对不要替别人说话，也不要复述别人的话。\n'
        '2. 不要在自己的回复开头写名字前缀，直接说话即可。\n'
        '3. 保持你原本的性格、语气和说话习惯。\n'
        '4. 这是日常群聊，回复请简短自然，每条消息只讲一件事。\n'
        '5. 不要每次都反问对方，也不要每次都长篇大论；话题与你无关时，可以只简短表达态度。\n'
        '6. 你的回复会以**纯文本**发送到 QQ：不要输出 Markdown 标题、加粗星号、代码块，'
        '也不要输出任何链接或网址。\n'
        '7. 不确定的事情就说不知道，不要编造。\n\n'
        '【分条发送规则（重要）】\n'
        '你能像真人一样把一次回复拆成几条连着发。请这样用：\n'
        f'· 每条尽量不超过 {soft_limit} 字，手机上不要出现一坨大段文字。\n'
        f'· 需要分条时，在每条之间写分隔符 {REPLY_PART_SEP}（三个竖线），系统会按它拆成多条消息依次发出。\n'
        f'· 例：{REPLY_PART_SEP}前后的内容会变成两条独立的消息。\n'
        f'· 不必刻意分条：一两句话能说完就写一条，别为了凑条数硬拆。\n'
        f'· 最多 3 条。真要说的很多，就挑重点说，别刷屏。\n'
        f'· 除了 {REPLY_PART_SEP} 不要使用其他分隔符，也不要在结尾重复它。\n\n'
        '【回复格式规则】\n'
        '当你的回复中包含非语言表达的内容时，请使用括号（）包裹，例如："（轻轻叹气）我相信你能做到。"'
    )

    # ---- user：群聊转录 + 本条消息 + 发言指令 ----
    lines = [f'{name}：{text}' for name, text in (transcript or []) if (text or '').strip()]
    transcript_text = '\n'.join(lines) if lines else '（暂无记录）'

    user_content = (
        f'【群聊记录】\n{transcript_text}\n\n'
        f'【现在请你发言】\n'
        f'请以「{role_name}」的身份，紧接着上面的聊天记录往下说。\n'
        f'只输出「{role_name}」要说的话本身——不要写名字前缀，不要写旁白或解释，不要复述聊天记录。'
    )
    return [
        {'role': 'system', 'content': system},
        {'role': 'user', 'content': user_content},
    ]


def build_private_prompt(cfg, transcript, speaker_name, user_bio, knowledge_text=''):
    """私聊提示词：与群聊**共用角色锚定部分**，只换成一对一外壳。

    与群聊的两处实质差别：
      · 不需要「分辨谁在说话」，也不该出现"群里其他人"这类描述
      · 一对一场景可以比群聊话多一点（群聊要防刷屏，私聊是朋友对话）
    """
    role = cfg.get('role') or {}
    ctx = {'roleName': (role.get('roleName') or '').strip() or '助手', 'userName': speaker_name}
    role_name, system = _roleplay_anchor(cfg, speaker_name, user_bio, knowledge_text, ctx)
    soft_limit = _reply_char_limit(cfg, is_private=True)

    system += (
        '\n\n【你正在和对方 QQ 私聊】\n'
        '现在只有你和对方两个人在说话，没有第三个人在场。\n\n'
        '【QQ 私聊规则】\n'
        f'1. 只以「{role_name}」自己的身份说话，不要替对方说话，也不要复述对方的话。\n'
        '2. 不要在自己的回复开头写名字前缀，直接说话即可。\n'
        '3. 保持你原本的性格、语气和说话习惯。\n'
        '4. 回复请自然；可以比在群里话多一点，但不要写成小作文。\n'
        '5. 不要每次都反问对方，也不要每次都长篇大论。\n'
        '6. 你的回复会以**纯文本**发送到 QQ：不要输出 Markdown 标题、加粗星号、代码块，'
        '也不要输出任何链接或网址。\n'
        '7. 不确定的事情就说不知道，不要编造。\n\n'
        '【分条发送规则（重要）】\n'
        '你能像真人一样把一次回复拆成几条连着发。请这样用：\n'
        f'· 每条尽量不超过 {soft_limit} 字；长内容一定要拆开，不要发一大段。\n'
        f'· 需要分条时，在每条之间写分隔符 {REPLY_PART_SEP}（三个竖线），系统会按它拆成多条消息依次发出。\n'
        f'· 例：先回一句短的{REPLY_PART_SEP}再说具体的想法——这样对方会收到两条消息。\n'
        f'· 不必刻意分条：一句话能说完就写一条。\n'
        f'· 最多 4 条。\n'
        f'· 除了 {REPLY_PART_SEP} 不要使用其他分隔符，也不要在结尾重复它。\n\n'
        '【回复格式规则】\n'
        '当你的回复中包含非语言表达的内容时，请使用括号（）包裹，例如："（轻轻叹气）我相信你能做到。"'
    )

    # ---- user：一对一对话记录 + 本条消息 + 发言指令 ----
    # 私聊转录里只有「对方：…」「角色名：…」两种发言人
    lines = []
    for name, text in (transcript or []):
        if not (text or '').strip():
            continue
        lines.append(f'{text}' if name == role_name else f'{name}：{text}')
    transcript_text = '\n'.join(lines) if lines else '（暂无记录）'

    user_content = (
        f'【对话记录】\n{transcript_text}\n\n'
        f'【现在请你回复】\n'
        f'请以「{role_name}」的身份，紧接着上面的对话往下说。\n'
        f'只输出「{role_name}」要说的话本身——不要写名字前缀，不要写旁白或解释，不要复述对话记录。'
    )
    return [
        {'role': 'system', 'content': system},
        {'role': 'user', 'content': user_content},
    ]


# ==================== 回复文本清洗 ====================

_HIDDEN_TAGS = re.compile(r'<(think|soul|thinking)>.*?</\1>', re.S | re.I)
_CODE_FENCE = re.compile(r'```[a-zA-Z0-9_+-]*\n?(.*?)```', re.S)
_URL = re.compile(r'https?://\S+|www\.\S+', re.I)
_MD_HEADING = re.compile(r'^\s{0,3}#{1,6}\s*', re.M)
_MD_BOLD = re.compile(r'\*\*(.+?)\*\*', re.S)
_MD_ITALIC = re.compile(r'(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)', re.S)
_MD_QUOTE = re.compile(r'^\s{0,3}>\s?', re.M)
_LEADING_NAME = re.compile(r'^\s*[^：:\n]{1,12}[：:]\s*')


def clean_reply(text, role_name=''):
    """清洗模型输出，使其适合 QQ 纯文本：去隐藏标签 / 去 Markdown / 去链接。"""
    s = str(text or '')
    s = _HIDDEN_TAGS.sub('', s)                 # 思考过程与内心 OS 不进 QQ
    s = _CODE_FENCE.sub(lambda m: m.group(1), s)  # 代码块保留内容，去掉围栏
    s = _MD_HEADING.sub('', s)
    s = _MD_BOLD.sub(r'\1', s)
    s = _MD_ITALIC.sub(r'\1', s)
    s = _MD_QUOTE.sub('', s)
    s = _URL.sub('', s)                          # QQ 官方/协议端都不欢迎链接
    s = s.replace('**', '').replace('`', '')
    s = re.sub(r'[ \t]+', ' ', s)
    s = re.sub(r'\n{2,}', '\n', s).strip()
    # 去掉可能冒出来的「角色名：」前缀
    if role_name and _LEADING_NAME.match(s):
        head = s.split('：', 1)[0].split(':', 1)[0].strip()
        if head == role_name or head in (f'[{role_name}]',):
            s = _LEADING_NAME.sub('', s, count=1).strip()
    return s


def split_reply(text, max_chars=120, max_parts=3, prefer_paragraph=False):
    """把回复切成「几条独立消息」，模拟真人连发的语气。

    两层策略（缺一不可）：
      1. **先按模型给的分隔符 `|||` 分条**——模型最懂自己的断句，它配合时效果最好。
         分隔符的各种变体（`||`、`//`、`／／`、单独一行的 `---`）都容错识别。
      2. **再对每一条做长度兜底**：仍然超长的按句末标点合并/硬切。
         因为模型经常不配合——这一步保证永远不会发出一坨超长文本。

    @param max_parts: 最多几条。超过则把剩余的合并进最后一条，避免刷屏。
    @param prefer_paragraph: 未使用分隔符时，是否按段落（换行）分。私聊开启，
                             群聊关闭（群里按句号强拆会显得很碎）。
    """
    s = (text or '').strip()
    if not s:
        return []
    max_chars = max(30, int(max_chars or 120))
    max_parts = max(1, int(max_parts or 1))

    # ---- 第一层：按分隔符切 ----
    # 顺序重要：`|||` 必须在 `||` 之前判断，否则三条竖线会被切成"空 + 单竖线"。
    # `//` 只在该区分隔符单独成段时才当作分隔符——否则正文里的 "//" （比如路径）
    # 会被误切，所以它不参与无条件替换。
    seps = (REPLY_PART_SEP, '||', '／／', '\n//\n', '\n---\n')
    chunks = [s]
    for sep in seps:
        nxt = []
        for c in chunks:
            nxt.extend(c.split(sep))
        chunks = nxt
    # 还原那些其实用作正文的分隔符（模型可能在行内用 --- 做分隔线）
    chunks = [c.strip() for c in chunks if c and c.strip()]
    if not chunks:
        return [s]

    # ---- 第二层：每一条做长度兜底 ----
    out = []
    for c in chunks:
        out.extend(_split_by_length(c, max_chars, prefer_paragraph))

    # ---- 条数上限：多出来的合并进最后一条，而不是丢弃（丢内容更糟） ----
    if len(out) > max_parts:
        head, tail = out[:max_parts - 1], out[max_parts - 1:]
        out = head + [' '.join(tail)]

    # ---- 收尾：空段丢掉；仍超长的硬切 ----
    final = []
    for part in out:
        part = part.strip()
        if not part:
            continue
        while len(part) > max_chars:
            final.append(part[:max_chars].strip())
            part = part[max_chars:].strip()
        if part:
            final.append(part)
    return final or [s[:max_chars]]


def _split_by_length(s, max_chars, prefer_paragraph=False):
    """把一条文本按长度切成若干条：优先句末标点，实在不行才硬切。"""
    s = (s or '').strip()
    if not s:
        return []
    if len(s) <= max_chars:
        return [s]

    # 句末标点 / 换行处切开，再把短句合并到接近上限
    pieces = [p for p in re.split(r'(?<=[。！？!?；;\n])', s) if p.strip()]
    if not pieces:
        pieces = [s]

    out, buf = [], ''
    for p in pieces:
        if len(buf) + len(p) <= max_chars:
            buf += p
            continue
        if buf.strip():
            out.append(buf.strip())
        while len(p) > max_chars:          # 单句本身就超长 → 硬切
            out.append(p[:max_chars].strip())
            p = p[max_chars:]
        buf = p
    if buf.strip():
        out.append(buf.strip())
    return out


# ==================== 模型调用 ====================

def _is_ollama(model_host, kind=''):
    if kind == 'ollama':
        return True
    if kind == 'openai':
        return False
    host = (model_host or '').lower()
    return ':11434' in host or '/api/chat' in host


def call_model(cfg, messages, timeout=120):
    """调模型，返回纯文本回复。非流式——QQ 侧本来就是整条发，流式没有收益。"""
    model = cfg.get('model') or {}
    role = cfg.get('role') or {}
    host = (model.get('modelHost') or '').rstrip('/')
    api_key = model.get('apiKey') or ''
    model_name = model.get('modelName') or ''
    if not host or not model_name:
        raise RuntimeError('模型地址或模型名为空（网页侧未推送配置？）')

    temperature = float(role.get('temperature', 0.7) or 0.7)
    top_p = float(role.get('topP', 0.9) or 0.9)
    max_tokens = int(role.get('maxTokens', 500) or 500)
    # 角色若开了"思考深度"，QQ 这种日常群聊场景统一关掉：省 token 也省延迟
    think_level = 0

    if _is_ollama(host, model.get('kind')):
        url = f'{host}/api/chat'
        body = {
            'model': model_name,
            'messages': messages,
            'stream': False,
            'think': False,
            'options': {'temperature': temperature, 'top_p': top_p, 'num_predict': max_tokens},
        }
    else:
        url = f'{host}/v1/chat/completions'
        body = {
            'model': model_name,
            'messages': messages,
            'stream': False,
            'temperature': temperature,
            'top_p': top_p,
            'max_tokens': max_tokens,
        }
        if think_level == 0:
            body['think'] = False

    headers = {'Content-Type': 'application/json'}
    if api_key:
        headers['Authorization'] = f'Bearer {api_key}'

    resp = requests.post(url, json=body, headers=headers, timeout=timeout)
    if resp.status_code >= 400:
        raise RuntimeError(f'模型返回 HTTP {resp.status_code}: {resp.text[:300]}')
    data = resp.json()

    try:
        if _is_ollama(host, model.get('kind')):
            content = (data.get('message') or {}).get('content', '')
        else:
            content = (data.get('choices') or [{}])[0].get('message', {}).get('content', '')
    except (AttributeError, IndexError, TypeError):
        content = ''
    if not content:
        raise RuntimeError(f'模型未返回内容：{str(data)[:300]}')
    return content


# ==================== 知识库检索 ====================

def retrieve_knowledge(cfg, query):
    """复用本项目已有的知识库服务（同一个 Chroma 向量库，无需重灌）。

    失败一律降级为空结果——知识库挂了不能连累回话。
    """
    kb = cfg.get('knowledge') or {}
    if not kb.get('enabled'):
        return ''
    ids = [i for i in (kb.get('ids') or []) if i and i != '__memory__']
    base = (kb.get('apiBase') or '').rstrip('/')
    if not ids or not base or not (query or '').strip():
        return ''

    top_k = int(kb.get('topK', 3) or 3)
    min_score = float(kb.get('minScore', 0.4) or 0.0)
    hits = []
    for kb_id in ids:
        try:
            r = requests.post(
                f'{base}/knowledge_bases/{kb_id}/search',
                json={'query': query, 'top_k': top_k},
                timeout=20,
            )
            if r.status_code >= 400:
                continue
            for item in (r.json().get('results') or []):
                score = float(item.get('score', 0) or 0)
                if score >= min_score and item.get('content'):
                    hits.append((score, item['content'].strip(), item.get('filename', '未知')))
        except Exception as e:      # noqa: BLE001
            print(f'[QQ] 知识库 {kb_id} 检索失败：{e}')
    if not hits:
        return ''
    hits.sort(key=lambda x: x[0], reverse=True)
    seen, lines = set(), []
    for _, content, filename in hits[:5]:
        key = content[:80]
        if key in seen:
            continue
        seen.add(key)
        lines.append(f'- （来自《{filename}》）{content}')
    return '\n'.join(lines)


# ==================== 语音合成 ====================

def synthesize_voice(cfg, text):
    """调本项目已有的 TTS 服务合成语音，写成本地 wav 文件，返回文件名。

    返回 None 表示未启用或失败——调用方应静默退回纯文本。
    """
    tts = cfg.get('tts') or {}
    if not tts.get('enabled') or not (text or '').strip():
        return None
    api_url = (tts.get('apiUrl') or '').rstrip('/')
    if not api_url:
        return None

    payload = {'text': text, 'voiceId': tts.get('voiceId') or 'default'}
    headers = {'Content-Type': 'application/json'}
    if tts.get('apiKey'):
        headers['X-API-Key'] = tts['apiKey']

    try:
        r = requests.post(f'{api_url}/tts', json=payload, headers=headers, timeout=180)
        if r.status_code >= 400 or not r.content:
            print(f'[QQ] 语音合成失败：HTTP {r.status_code}')
            return None
        name = hashlib.md5((text + str(tts.get('voiceId'))).encode('utf-8')).hexdigest() + '.wav'
        with open(os.path.join(AUDIO_DIR, name), 'wb') as f:
            f.write(r.content)
        return name
    except Exception as e:          # noqa: BLE001
        print(f'[QQ] 语音合成异常：{e}')
        return None


def audio_path(name):
    """安全解析音频文件名 → 绝对路径（拒绝任何目录穿越）。"""
    safe = os.path.basename(name or '')
    if not safe.endswith('.wav'):
        return None
    p = os.path.join(AUDIO_DIR, safe)
    return p if os.path.exists(p) else None
