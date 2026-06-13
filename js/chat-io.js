// js/chat-io.js
import { escapeHtml, getCurrentTime, formatDate, renderMessageWithThink } from './utils.js';
import Constants from './constants.js';

export class ChatIO {
    /**
     * @param {Object} deps
     * @param {Function} deps.saveAllChats - 保存所有对话的函数（例如 chatRepo.saveAllChats）
     * @param {string} deps.cachedCSS - 缓存的 CSS 文本（用于导出 HTML）
     */
    constructor({ saveAllChats, cachedCSS = '' } = {}) {
        this.saveAllChats = saveAllChats;
        this.cachedCSS = cachedCSS;
    }

    // 更新缓存的 CSS（在页面加载后调用）
    updateCachedCSS(css) {
        this.cachedCSS = css;
    }

    /**
     * 导出会话为 JSON 文件
     * @param {Object} chat
     */
    exportAsJSON(chat) {
        const data = {
            id: chat.id,
            title: chat.title,
            date: chat.date,
            messages: chat.messages.map(msg => {
                const newMsg = { ...msg };
                if (newMsg.file === null || newMsg.file === undefined) delete newMsg.file;
                if (newMsg.modelInputText !== undefined && newMsg.modelInputText === newMsg.text) delete newMsg.modelInputText;
                return newMsg;
            }),
            settings: chat.settings
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat_${chat.id}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.#showToast('✅ 会话已导出');
    }

    /**
     * 导出会话为 HTML 文件
     * @param {Object} chat
     */
    exportAsHTML(chat) {
        const settings = chat.settings || Constants.DEFAULT_SETTINGS;
        const roleName = escapeHtml(settings.roleName || 'Nova');
        const title = `${roleName} · 对话记录`;
        const dateStr = chat.date.toLocaleString(Constants.SPEECH_RECOGNITION_LANG);
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        const userAvatar = globalSettings.avatar;
        const bgUrl = chat.settings?.bgUrl;
        const bodyBgStyle = bgUrl
            ? `background: linear-gradient(0deg, rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0.55)), url(${bgUrl}) center/cover no-repeat fixed;`
            : `background: #030305;`;

        const messagesHtml = chat.messages.map(msg => {
            if (msg.type === 'divider') {
                return `<div class="topic-divider"><i class="fas fa-asterisk"></i> ${escapeHtml(msg.text)} <i class="fas fa-asterisk"></i></div>`;
            }
            const isAi = msg.type === 'ai';
            const bubbleContent = isAi ? renderMessageWithThink(msg.text) : `<p>${escapeHtml(msg.text).replace(/\n/g, '<br>')}</p>`;
            const timeHtml = `<div class="msg-time">${escapeHtml(msg.time || '')}${isAi && msg.modelName ? `<span>🤖 ${escapeHtml(msg.modelName)}</span>` : ''}</div>`;
            const avatarHtml = isAi
                ? (settings.avatarUrl ? `<img src="${settings.avatarUrl}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;">` : '<i class="fas fa-robot"></i>')
                : (userAvatar && userAvatar.startsWith('data:image')
                    ? `<img src="${userAvatar}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;">`
                    : '<i class="fas fa-user-astronaut"></i>');
            return `
            <div class="message ${msg.type}">
                <div class="avatar-msg">${avatarHtml}</div>
                <div class="bubble">
                    ${bubbleContent}
                    ${timeHtml}
                </div>
            </div>`;
        }).join('');

        const cssBlock = this.cachedCSS
            ? `<style>${this.cachedCSS}</style>`
            : '<link rel="stylesheet" href="style.css">';

        const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
    ${cssBlock}
    <style>
        body { ${bodyBgStyle} margin: 0; padding: 0; height: auto !important; overflow: visible !important; }
        .chat-app, .main-chat { height: auto !important; overflow: visible !important; }
        .main-chat { background: transparent; }
        .chat-messages { height: auto !important; max-height: none !important; overflow: visible !important; }
        .export-container { max-width: 800px; margin: 0 auto; padding: 20px; background: transparent !important; min-height: 100vh; }
        h1 { color: #5f7eff; margin-bottom: 10px; }
        .export-date { color: #8e8eb3; margin-bottom: 30px; }
    </style>
</head>
<body>
    <div class="chat-app">
        <main class="main-chat">
            <div class="export-container">
                <h1>${title}</h1>
                <p style="color:#8e8eb3; margin-bottom:30px;">导出时间：${dateStr}</p>
                <div class="chat-messages">
                    ${messagesHtml}
                </div>
            </div>
        </main>
    </div>
</body>
</html>`;

        const blob = new Blob([html], { type: 'text/html;charset=UTF-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat_${chat.id}.html`;
        a.click();
        URL.revokeObjectURL(url);
        this.#showToast('✅ 会话已导出为 HTML');
    }

    /**
     * 从 JSON 对象导入会话，并保存到存储
     * @param {Object} data - 解析后的 JSON 对象
     * @param {Array} currentChats - 当前已有的 chats 数组（用于生成新 ID 和校验）
     * @param {Function} onSuccess - 导入成功后的回调，接收新创建的 chat 对象
     */
    async importFromJSON(data, currentChats, onSuccess) {
        if (!data || typeof data !== 'object') throw new Error('无效的 JSON 数据');
        if (!data.messages || !Array.isArray(data.messages) || !data.settings) {
            throw new Error('无效的对话格式：缺少 messages 或 settings 字段');
        }
        const newId = Date.now();
        let chatDate = data.date ? new Date(data.date) : new Date();
        if (isNaN(chatDate.getTime())) chatDate = new Date();

        const newChat = {
            id: newId,
            title: data.title || `导入对话 ${currentChats.length + 1}`,
            date: chatDate,
            messages: data.messages.map(msg => ({
                ...msg,
                time: msg.time || getCurrentTime()
            })),
            settings: { ...Constants.DEFAULT_SETTINGS, ...data.settings },
            pinned: false
        };
        if (this.saveAllChats) {
            // 注意：这里需要将 newChat 添加到现有 chats 后保存，但 saveAllChats 是外部提供的保存函数
            // 调用方应负责将新 chat 加入数组并调用保存。我们只返回新 chat。
        }
        if (onSuccess) onSuccess(newChat);
        return newChat;
    }

    /**
     * 导出单个话题为 JSON 文件
     * @param {number} topicIndex
     * @param {Array} topics
     * @param {Object} currentChat
     */
    exportTopic(topicIndex, topics, currentChat) {
        const topic = topics[topicIndex];
        if (!topic) return;
        const data = {
            chatId: currentChat.id,
            chatTitle: currentChat.title,
            topicIndex: topicIndex + 1,
            messages: topic.messages,
            exportedAt: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `topic_${currentChat.id}_${topicIndex+1}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.#showToast('✅ 话题已导出');
    }

    #showToast(msg) {
        const toast = document.createElement('div');
        toast.textContent = msg;
        toast.style.cssText = 'position:fixed; bottom:80px; right:20px; background:#2a2f55; color:white; padding:8px 16px; border-radius:20px; z-index:10000;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    }
}