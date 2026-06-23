// 获取当前格式化时间字符串 YYYY-MM-DD HH:MM
export function getCurrentTime() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
}
// HTML 转义，防止 XSS
export function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}
// 格式化日期（用于侧边栏历史记录）
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
// 解析原始文本，分离思考内容和回复内容
export function parseThinkContent(rawText) {
    const thinkMatch = rawText.match(/<think>([\s\S]*?)<\/think>/);
    const thinkContent = thinkMatch ? thinkMatch[1].trim() : '';
    const replyContent = rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return { thinkContent, replyContent };
}
// 将原始文本渲染为带折叠区域的 HTML
export function renderMessageWithThink(rawText) {
    const { thinkContent, replyContent } = parseThinkContent(rawText);
    let html = '';
    if (thinkContent) {
        html += `<details class="think-details"><summary>🤔 思考过程</summary><div class="think-content">${escapeHtml(thinkContent).replace(/\n/g, '<br>')}</div></details>`;
    }
    // 处理括号斜体
    const parts = parseParenthesesContent(replyContent);
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
// 解析文本，分离括号内（非语言）和括号外（语言）部分
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
// 压缩图片：限制最大宽度，输出为 JPEG 格式（质量可调）
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
// 将快捷键字符串转为规范化的小写形式 (ctrl+n)
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
// 从event对象生成快捷键字符串（用于捕获）
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
// 判断是否为浏览器通常保护的组合（基于常识）
export function isBrowserReserved(shortcut) {
    const reserved = [
        'ctrl+n', 'ctrl+t', 'ctrl+w', 'ctrl+s', 'ctrl+p', 'ctrl+o',
        'ctrl+shift+n', 'ctrl+shift+t', 'ctrl+shift+w', // 部分浏览器也保护这些
        'ctrl+q', 'alt+f4', 'ctrl+shift+q'
    ];
    return reserved.includes(normalizeShortcut(shortcut));
}
