// 工具函数

/** 获取当前格式化时间字符串 YYYY-MM-DD HH:MM*/ 
export function getCurrentTime() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
}
/** HTML 转义，防止 XSS*/ 
export function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}
/** 格式化日期（用于侧边栏历史记录）*/ 
export function formatDate(dateObj) {
    const now = new Date();
    // 使用 YYYY-MM-DD 字符串比较，正确处理跨月/跨年边界
    const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const dateStr = fmtDate(dateObj);
    const todayStr = fmtDate(now);
    if (dateStr === todayStr) {
        return `今天 ${dateObj.getHours()}:${String(dateObj.getMinutes()).padStart(2,'0')}`;
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (dateStr === fmtDate(yesterday)) {
        return `昨天 ${dateObj.getHours()}:${String(dateObj.getMinutes()).padStart(2,'0')}`;
    }
    return `${dateObj.getMonth()+1}月${dateObj.getDate()}日`;
}
/** 解析原始文本，分离思考内容和回复内容*/
export function parseThinkContent(rawText) {
    const thinkMatch = rawText.match(/<think>([\s\S]*?)<\/think>/);
    const thinkContent = thinkMatch ? thinkMatch[1].trim() : '';
    const replyContent = rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return { thinkContent, replyContent };
}
/** 解析原始文本，分离内心OS内容和回复内容*/
export function parseSoulContent(rawText) {
    const soulMatch = rawText.match(/<soul>([\s\S]*?)<\/soul>/);
    const soulContent = soulMatch ? soulMatch[1].trim() : '';
    const replyContent = rawText.replace(/<soul>[\s\S]*?<\/soul>/g, '').trim();
    return { soulContent, replyContent };
}
/** 剥离所有隐藏标签（<think> 思考过程、<soul> 内心OS），返回纯正文（用于发送给模型）*/
export function stripHiddenTags(rawText) {
    return parseSoulContent(parseThinkContent(rawText).replyContent).replyContent;
}
/** 将原始文本渲染为带折叠区域的 HTML
 * @param {string} rawText - 原始文本
 * @param {boolean} showThinking - 是否显示思考内容，false 时直接丢弃 <think> 部分
 * @param {number|null} thinkSeconds - 思考用时（秒），用于历史消息回显
 */
export function renderMessageWithThink(rawText, showThinking = true, thinkSeconds = null) {
    const { thinkContent, replyContent } = parseThinkContent(rawText);
    const { soulContent, replyContent: finalContent } = parseSoulContent(replyContent);
    let html = '';
    if (showThinking && thinkContent) {
        const timeHtml = thinkSeconds != null
            ? ` <span class="think-timer">· ${thinkSeconds}s</span>`
            : '';
        html += `<details class="think-details"><summary><span class="think-title">🤔 思考过程</span>${timeHtml}</summary><div class="think-content">${escapeHtml(thinkContent).replace(/\n/g, '<br>')}</div></details>`;
    }
    if (soulContent) {
        html += `<details class="soul-details"><summary><span class="soul-title">💭 内心OS</span></summary><div class="soul-content">${escapeHtml(soulContent).replace(/\n/g, '<br>')}</div></details>`;
    }
    // 处理括号斜体
    const parts = parseParenthesesContent(finalContent);
    let contentHtml = '';
    for (const part of parts) {
        if (part.type === 'action') {
            contentHtml += `<span class="action-text" style="font-style: italic; opacity: 0.8;">${escapeHtml(part.raw)}</span>`;
        } else {
            contentHtml += escapeHtml(part.text).replace(/\n/g, '<br>');
        }
    }
    html += `<p>${contentHtml}</p>`;
    return html;
}
/** 解析文本，分离括号内（非语言）和括号外（语言）部分*/ 
export function parseParenthesesContent(text) {
    const parts = [];
    // 正则匹配括号及其内容（非贪婪）
    const regex = /（([^（）]*)）|\(([^()]*)\)/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const parenContent = match[1] || match[2]; // 中文或英文括号内的内容
        const start = match.index;
        const end = start + match[0].length;
        // 括号前的普通文本
        if (start > lastIndex) {
            parts.push({ type: 'speech', text: text.substring(lastIndex, start) });
        }
        // 括号内的内容（非语言）
        parts.push({ type: 'action', text: parenContent, raw: match[0] });
        lastIndex = end;
    }
    if (lastIndex < text.length) {
        parts.push({ type: 'speech', text: text.substring(lastIndex) });
    }
    return parts;
}
/** 将普通文本渲染为 HTML，括号内容斜体化（用于用户消息等不含 <think> 标签的文本）
 * @param {string} text - 原始文本
 * @returns {string} 包含 <p> 包裹的 HTML
 */
export function renderTextWithActions(text) {
    const parts = parseParenthesesContent(text);
    let html = '';
    for (const part of parts) {
        if (part.type === 'action') {
            html += `<span class="action-text">${escapeHtml(part.raw)}</span>`;
        } else {
            html += escapeHtml(part.text).replace(/\n/g, '<br>');
        }
    }
    return `<p>${html}</p>`;
}
/** 压缩图片：限制最大宽度，输出为 JPEG 格式（质量可调）*/ 
export function compressImage(file, maxWidth = 200, quality = 0.7) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                if (width > maxWidth) {
                    height = (height * maxWidth) / width;
                    width = maxWidth;
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                // 输出为 JPEG，质量 quality（0-1）
                const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
                resolve(compressedDataUrl);
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/** 从 data URL 生成缩略图（用于聊天列表展示，节省内存和存储）
 * @param {string} dataUrl - 完整图片 data URL
 * @param {number} maxDim - 缩略图最大宽/高，默认 300px
 * @param {number} quality - JPEG 质量 0-1，默认 0.7
 * @returns {Promise<string>} 缩略图 data URL
 */
export function createThumbnail(dataUrl, maxDim = 300, quality = 0.7) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let width = img.width;
            let height = img.height;
            // 已经足够小，直接返回原图
            if (width <= maxDim && height <= maxDim) {
                resolve(dataUrl);
                return;
            }
            const ratio = Math.min(maxDim / width, maxDim / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('缩略图生成失败'));
        img.src = dataUrl;
    });
}

/** 检测字符串是否为图片 data URL */
export function isImageUrl(str) {
    return typeof str === 'string' && str.startsWith('data:image/');
}

/** 将快捷键字符串转为规范化的小写形式 (ctrl+n)*/
export function normalizeShortcut(keys) {
    return keys.toLowerCase().replace(/\s/g, '');
}
// 根据快捷键字符串构建keydown事件匹配的条件
export function parseShortcut(shortcutStr) {
    const parts = shortcutStr.toLowerCase().split('+');
    const key = parts.pop(); // 最后一个为实际按键
    return {
        ctrlKey: parts.includes('ctrl'),
        shiftKey: parts.includes('shift'),
        altKey: parts.includes('alt'),
        metaKey: parts.includes('meta') || parts.includes('cmd'),
        key: key
    };
}
/** 从event对象生成快捷键字符串（用于捕获）*/ 
export function eventToShortcutString(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.shiftKey) parts.push('shift');
    if (e.altKey) parts.push('alt');
    if (e.metaKey) parts.push('meta');
    let key = e.key.toLowerCase();
    if (key === 'control' || key === 'shift' || key === 'alt' || key === 'meta') return null;
    if (key === ' ') key = 'space';
    if (key === '/') key = '/';  // 特殊键保留
    // 处理功能键
    if (key.length === 1) key = key;
    else if (key === 'arrowup') key = 'up';
    else if (key === 'arrowdown') key = 'down';
    else if (key === 'arrowleft') key = 'left';
    else if (key === 'arrowright') key = 'right';
    parts.push(key);
    return parts.join('+');
}
/** 判断是否为浏览器通常保护的组合（基于常识）*/ 
export function isBrowserReserved(shortcut) {
    const reserved = [
        'ctrl+n', 'ctrl+t', 'ctrl+w', 'ctrl+s', 'ctrl+p', 'ctrl+o',
        'ctrl+shift+n', 'ctrl+shift+t', 'ctrl+shift+w', // 部分浏览器也保护这些
        'ctrl+q', 'alt+f4', 'ctrl+shift+q'
    ];
    return reserved.includes(normalizeShortcut(shortcut));
}

/**
 * 基于消息内容 + 时间戳 + 随机数生成唯一 ID（djb2 哈希，base36 编码）。
 * - 纳入了随机因子，即使同一毫秒内创建相同内容的消息也不会碰撞
 * @param {string} type - 消息类型 'user'|'ai'|'divider'
 * @param {string} text - 消息文本内容
 * @param {string} time - 格式化时间字符串
 * @returns {string} base36 编码的哈希值，例如 "2f8k3x9p"
 */
export function genMsgUid(type, text, time) {
    const seed = `${type}|${text}|${time}|${Date.now()}|${Math.random()}`;
    let hash = 5381;
    for (let i = 0; i < seed.length; i++) {
        hash = ((hash << 5) + hash) + seed.charCodeAt(i); // hash * 33 + c
    }
    return (hash >>> 0).toString(36);
}

// ==================== SillyTavern 宏解析 ====================

/** 当前时间 HH:MM（24 小时制） */
function stTime() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** 当前日期 YYYY-MM-DD */
function stDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** 星期几（英文，对齐 SillyTavern 惯例） */
function stWeekday() {
    return new Date().toLocaleDateString('en-US', { weekday: 'long' });
}
/** 解析骰子表达式（如 2d20+5）→ {count, sides, bonus}；非法返回 null */
function parseDiceExpr(expr) {
    const m = String(expr || '').match(/^\s*(\d*)d(\d+)\s*([+-]\s*\d+)?\s*$/i);
    if (!m) return null;
    const count = m[1] === '' ? 1 : parseInt(m[1], 10);
    const sides = parseInt(m[2], 10);
    const bonus = m[3] ? parseInt(m[3].replace(/\s+/g, ''), 10) : 0;
    if (!count || !sides || count > 100 || sides > 1000) return null;
    return { count, sides, bonus };
}
/** 掷骰子：返回总和（非法表达式回退 1d6） */
function rollDice(expr) {
    const d = parseDiceExpr(expr) || { count: 1, sides: 6, bonus: 0 };
    let total = 0;
    for (let i = 0; i < d.count; i++) total += 1 + Math.floor(Math.random() * d.sides);
    return String(total + d.bonus);
}
/** 取最近一条指定角色消息的文本；role 为 null 时取最后一条 */
function lastMsgBy(messages, role) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    if (role == null) {
        const last = messages[messages.length - 1];
        return last ? (last.text || '') : '';
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === role) return messages[i].text || '';
    }
    return '';
}

/**
 * 解析文本中的 SillyTavern 宏（静态宏 + 常用动态宏）。
 * 规则：
 *  - {{//注释}} 所在行整行剔除（含前后空白），内联注释替换为空串
 *  - 静态宏（char/user/time/date/weekday/datetime/random/roll/newline/pipe/charVersion）直接求值，random/roll 每次调用重新生成
 *  - 动态宏（input/original/lastMessage/lastCharMessage/lastUserMessage/firstMessage）从 ctx 取值；ctx 缺值 → 空串
 *  - 未知宏原样保留，防止误伤
 * @param {string} text - 原始文本
 * @param {Object} ctx - 宏上下文
 * @param {string} [ctx.roleName]     角色名（{{char}}）
 * @param {string} [ctx.userName]     用户名（{{user}}）
 * @param {string} [ctx.greeting]     开场白（{{firstMessage}}）
 * @param {string} [ctx.charVersion]  角色卡版本（{{charVersion}}）
 * @param {string} [ctx.input]        当前用户输入（含前缀，{{input}}）
 * @param {string} [ctx.original]     当前用户输入原文（{{original}}）
 * @param {Array<{role:string,text:string}>} [ctx.messages] 历史消息（AI 侧建议已剥离 think/soul）
 * @returns {string}
 */
export function replaceSTMacros(text, ctx = {}) {
    if (!text) return '';
    let result = text;
    // 1) 注释：整行 {{//...}} 连同前后空白与换行剔除；内联 {{//...}} 替换为空串
    result = result.replace(/^[ \t]*\{\{\/\/[^}]*\}\}[ \t]*\r?\n?/gm, '');
    result = result.replace(/\{\{\/\/[^}]*\}\}/g, '');
    // 2) 宏替换
    result = result.replace(/\{\{([^{}]+)\}\}/g, (match, body) => {
        const key = body.trim();
        // 带参宏
        if (key.startsWith('random:')) {
            const parts = key.slice(7).split(',').map(s => parseInt(s.trim(), 10));
            if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                const min = Math.min(parts[0], parts[1]);
                const max = Math.max(parts[0], parts[1]);
                return String(min + Math.floor(Math.random() * (max - min + 1)));
            }
            if (parts.length === 1 && !isNaN(parts[0])) {
                return String(1 + Math.floor(Math.random() * Math.max(1, parts[0])));
            }
            return String(1 + Math.floor(Math.random() * 100)); // 解析失败回退 1~100
        }
        if (key.startsWith('roll:')) return rollDice(key.slice(5));
        // 精确匹配
        switch (key) {
            case 'char': return ctx.roleName || 'AI';
            case 'user': return ctx.userName || '用户';
            case 'time': return stTime();
            case 'date': return stDate();
            case 'weekday': return stWeekday();
            case 'datetime': return `${stDate()} ${stTime()}`;
            case 'random': return String(1 + Math.floor(Math.random() * 100));
            case 'roll': return rollDice('1d6');
            case 'newline': return '\n';
            case 'pipe': return '|';
            case 'charVersion': return ctx.charVersion || '';
            case 'firstMessage': return ctx.greeting || '';
            case 'input': return ctx.input || '';
            case 'original': return ctx.original || '';
            case 'lastMessage': return lastMsgBy(ctx.messages, null);
            case 'lastCharMessage': return lastMsgBy(ctx.messages, 'ai');
            case 'lastUserMessage': return lastMsgBy(ctx.messages, 'user');
            default: return match; // 未知宏原样保留
        }
    });
    return result;
}