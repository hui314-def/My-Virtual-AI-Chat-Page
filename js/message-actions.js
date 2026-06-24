// 消息操作菜单模块
// 处理双击消息气泡弹出的操作栏（引用/删除/播放/重新生成/继续说/保存图片等）。
import Constants from './constants.js';
import { escapeHtml, getCurrentTime, parseThinkContent, parseParenthesesContent, genMsgUid } from './utils.js';

export class MessageActions {
    /**
     * @param {Object} ctx
     * @param {Function} ctx.getChats          — () => Array
     * @param {Function} ctx.getCurrentChatId  — () => number
     * @param {Function} ctx.getCurrentTopicIndex — () => number|null
     * @param {Function} ctx.isProcessing      — () => boolean
     * @param {Object}   ctx.chatRepo          — ChatRepository
     * @param {Object}   ctx.ttsService        — TTsService
     * @param {HTMLElement} ctx.chatMessages   — 聊天区 DOM 元素
     * @param {Function} ctx.renderMessages    — (chatId, topicIdx?)
     * @param {Function} ctx.renderHistoryList — ()
     * @param {Function} ctx.customAlert       — (msg, type)
     * @param {Function} ctx.showBriefToast    — (msg)
     * @param {Function} ctx.simulateAIResponse— (userMsg)
     * @param {Function} ctx.appendMessageToDOM— (type, text, ...)
     * @param {Function} ctx.updateStatusIndicator — (state, text?)
     */
    constructor(ctx) {
        this.ctx = ctx;
        /** @type {HTMLElement|null} */
        this.currentActionMenu = null;
        /** @type {HTMLElement|null} */
        this.currentActionMsgElement = null;
        /** @type {Function|null} */
        this.currentActionClickHandler = null;
        /** @type {Function|null} */
        this.currentActionScrollHandler = null;
        /** @type {HTMLElement|null} */
        this.currentPictureMenu = null;
        /** @type {HTMLElement|null} */
        this.currentPictureMsgElement = null;
    }

    // ==================== 图片消息操作栏 ====================

    showPictureActions(msgElement, msgData) {
        if (this.currentPictureMenu) {
            this.currentPictureMenu.remove();
            this.currentPictureMenu = null;
        }
        const bubble = msgElement.querySelector('.bubble');
        if (!bubble) return;

        const rect = bubble.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'message-actions';
        actionsDiv.innerHTML = `
            <button class="save-pic-btn"><i class="fas fa-download"></i> 保存</button>
            <button class="delete-btn"><i class="fas fa-trash-alt"></i> 删除</button>
        `;
        document.body.appendChild(actionsDiv);
        this.currentPictureMenu = actionsDiv;
        this.currentPictureMsgElement = msgElement;

        // 定位
        actionsDiv.style.top = `${rect.bottom + scrollTop + 8}px`;
        actionsDiv.style.left = `${rect.left + scrollLeft}px`;
        const actionsRect = actionsDiv.getBoundingClientRect();
        if (actionsRect.right > window.innerWidth) {
            actionsDiv.style.left = `${window.innerWidth - actionsRect.width - 10 + scrollLeft}px`;
        }

        const closePictureMenu = () => {
            if (actionsDiv.parentNode) actionsDiv.remove();
            this.currentPictureMenu = null;
            this.currentPictureMsgElement = null;
            document.removeEventListener('click', closeHandler);
            this.ctx.chatMessages.removeEventListener('scroll', scrollCloseHandler);
        };

        const closeHandler = (e) => {
            if (!actionsDiv.contains(e.target) && e.target !== msgElement && !msgElement.contains(e.target)) {
                closePictureMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        const scrollCloseHandler = () => closePictureMenu();

        // 保存图片
        actionsDiv.querySelector('.save-pic-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const a = document.createElement('a');
            a.href = msgData.src;
            a.download = `generated_image_${Date.now()}.png`;
            a.click();
            closePictureMenu();
        });

        // 删除图片
        actionsDiv.querySelector('.delete-btn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm('确定要删除这张图片吗？')) {
                await this.#deletePictureMessage(msgElement, msgData);
                closePictureMenu();
            }
        });

        setTimeout(() => {
            document.addEventListener('click', closeHandler);
            this.ctx.chatMessages.addEventListener('scroll', scrollCloseHandler, { once: true });
        }, 0);
    }

    // ==================== 文字消息操作栏 ====================

    showMessageActions(msgElement, type, text, time, saveToStorageFlag, chatIdForSave, customAvatarUrl, fileAttachment) {
        const ctx = this.ctx;

        // 移除已存在的操作栏
        if (this.currentActionMenu) {
            if (this.currentActionClickHandler) {
                document.removeEventListener('click', this.currentActionClickHandler);
                this.currentActionClickHandler = null;
            }
            if (this.currentActionScrollHandler) {
                document.removeEventListener('scroll', this.currentActionScrollHandler);
                this.currentActionScrollHandler = null;
            }
            this.currentActionMenu.remove();
            this.currentActionMenu = null;
            this.currentActionMsgElement = null;
        }

        const bubble = msgElement.querySelector('.bubble');
        if (!bubble) return;

        const rect = bubble.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'message-actions';

        const chats = ctx.getChats();
        const currentChatId = ctx.getCurrentChatId();
        const currentChat = chats.find(c => c.id == currentChatId);

        // 是否为最新 AI 消息
        const isLatestAi = (type === 'ai' && currentChat && currentChat.messages.length > 0 &&
            currentChat.messages[currentChat.messages.length - 1].text === text);

        let buttonsHtml = `<button class="quote-btn"><i class="fas fa-quote-right"></i> 引用</button><button class="delete-btn"><i class="fas fa-trash-alt"></i> 删除消息</button>`;
        if (type === 'ai') {
            buttonsHtml += `<button class="play-msg-btn"><i class="fas fa-play"></i> 播放</button>`;
        }
        if (isLatestAi) {
            buttonsHtml += `
                <button class="regenerate-btn"><i class="fas fa-undo-alt"></i> 重新生成</button>
                <button class="continue-btn"><i class="fas fa-forward"></i> 继续说</button>
            `;
        }
        const isLatestUser = (type === 'user' && currentChat && currentChat.messages.length > 0 &&
            currentChat.messages[currentChat.messages.length - 1].type === 'user' &&
            currentChat.messages[currentChat.messages.length - 1].text === text &&
            currentChat.messages[currentChat.messages.length - 1].time === time);
        if (isLatestUser) {
            buttonsHtml += `<button class="generate-reply-btn"><i class="fas fa-comment-dots"></i> 生成回复</button>`;
        }
        actionsDiv.innerHTML = buttonsHtml;
        document.body.appendChild(actionsDiv);
        this.currentActionMenu = actionsDiv;
        this.currentActionMsgElement = msgElement;

        // 定位
        const top = rect.bottom + scrollTop + 8;
        const left = rect.left + scrollLeft;
        actionsDiv.style.top = `${top}px`;
        actionsDiv.style.left = `${left}px`;
        const actionsRect = actionsDiv.getBoundingClientRect();
        if (actionsRect.right > window.innerWidth) {
            actionsDiv.style.left = `${window.innerWidth - actionsRect.width - 10 + scrollLeft}px`;
        }

        const self = this;

        function closeActionMenu() {
            if (self.currentActionClickHandler) {
                document.removeEventListener('click', self.currentActionClickHandler);
                self.currentActionClickHandler = null;
            }
            if (self.currentActionScrollHandler) {
                document.removeEventListener('scroll', self.currentActionScrollHandler);
                self.currentActionScrollHandler = null;
            }
            if (actionsDiv && actionsDiv.parentNode) actionsDiv.remove();
            self.currentActionMenu = null;
            self.currentActionMsgElement = null;
        }

        // 删除
        actionsDiv.querySelector('.delete-btn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm('确定要删除这条消息吗？')) {
                const msgUid = msgElement.dataset.msgUid ? parseInt(msgElement.dataset.msgUid) : null;
                await self.#deleteMessageFromChat(msgUid, type, text, time);
                closeActionMenu();
            }
        });

        // 播放 TTS
        actionsDiv.querySelector('.play-msg-btn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            closeActionMenu();
            if (ctx.ttsService.isSpeaking()) {
                ctx.customAlert('正在合成和播放语音，请稍后再试');
                return;
            }
            const chat = chats.find(c => c.id == currentChatId);
            const ttsEnabled = chat?.settings?.ttsEnabled;
            const ttsVoice = chat?.settings?.ttsVoice || 'default';
            if (ttsEnabled) {
                const { replyContent } = parseThinkContent(text);
                const contentToSpeak = replyContent || text;
                const parts = parseParenthesesContent(contentToSpeak);
                const speechText = parts.filter(p => p.type === 'speech').map(p => p.text).join('');
                if (speechText.trim()) {
                    ctx.updateStatusIndicator('speaking', '语音合成中 ...');
                    ctx.ttsService.speak(speechText, ttsVoice)
                        .finally(() => ctx.updateStatusIndicator('online'));
                } else {
                    ctx.customAlert('当前消息没有可朗读的语言内容');
                }
            } else {
                ctx.customAlert('当前对话未开启语音合成，请在对话设置中开启 TTS 开关');
            }
        });

        // 生成回复
        actionsDiv.querySelector('.generate-reply-btn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            closeActionMenu();
            await ctx.simulateAIResponse(text);
        });

        // 重新生成
        actionsDiv.querySelector('.regenerate-btn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            closeActionMenu();
            await self.#regenerateAIMessage(text, time);
        });

        // 继续说
        actionsDiv.querySelector('.continue-btn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            closeActionMenu();
            if (ctx.isProcessing()) {
                ctx.showBriefToast('请等待当前请求完成');
                return;
            }
            await self.#continueAIMessage();
        });

        // 引用
        actionsDiv.querySelector('.quote-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const chat = chats.find(c => c.id == currentChatId);
            if (!chat) return;
            const settings = chat.settings || Constants.DEFAULT_SETTINGS;
            const role = type === 'ai' ? settings.roleName : '用户';
            const quoteText = `引用消息> **${role}**：${text}\n\n`;
            const textarea = document.querySelector('.auto-expand-textarea');
            if (textarea) {
                textarea.value = textarea.value ? textarea.value + '\n' + quoteText : quoteText;
                textarea.dispatchEvent(new Event('input'));
                textarea.focus();
            }
            closeActionMenu();
        });

        // 点击外部/滚动关闭
        const closeHandler = (e) => {
            if (!actionsDiv.contains(e.target) && e.target !== msgElement && !msgElement.contains(e.target)) {
                closeActionMenu();
                document.removeEventListener('click', closeHandler);
                document.removeEventListener('scroll', scrollCloseHandler);
            }
        };
        const scrollCloseHandler = () => closeActionMenu();
        ctx.chatMessages.addEventListener('scroll', scrollCloseHandler);
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
        this.currentActionClickHandler = closeHandler;
        this.currentActionScrollHandler = scrollCloseHandler;
    }

    // ==================== 私有：消息操作实现 ====================

    async #deleteMessageFromChat(msgUid, type, text, time) {
        const ctx = this.ctx;
        const currentChat = ctx.getChats().find(c => c.id == ctx.getCurrentChatId());
        if (!currentChat) return;

        let index = -1;
        if (msgUid) index = currentChat.messages.findIndex(msg => msg.uid === msgUid);
        if (index === -1 && type && text && time) {
            index = currentChat.messages.findIndex(msg => msg.type === type && msg.text === text && msg.time === time);
        }
        if (index !== -1) {
            currentChat.messages.splice(index, 1);
            ctx.renderMessages(ctx.getCurrentChatId(), ctx.getCurrentTopicIndex());
            await ctx.chatRepo.saveChat(currentChat);
            if (currentChat.messages.length > 0) {
                currentChat.date = new Date();
                ctx.renderHistoryList();
            }
        } else {
            ctx.customAlert('无法找到该消息，删除失败', 'error');
        }
    }

    async #deletePictureMessage(msgElement, msgData) {
        const ctx = this.ctx;
        const currentChat = ctx.getChats().find(c => c.id == ctx.getCurrentChatId());
        if (!currentChat) return;

        const index = currentChat.messages.findIndex(m => m.isImage && m.time === msgData.time && m.text === msgData.src);
        if (index !== -1) {
            currentChat.messages.splice(index, 1);
            await ctx.chatRepo.saveChat(currentChat);
            msgElement.remove();
            ctx.renderHistoryList();
        }
    }

    async #regenerateAIMessage(oldText, oldTime) {
        const ctx = this.ctx;
        if (ctx.isProcessing()) {
            ctx.showBriefToast('请等待当前请求完成');
            return;
        }
        const currentChat = ctx.getChats().find(c => c.id == ctx.getCurrentChatId());
        if (!currentChat) return;

        const lastIndex = currentChat.messages.length - 1;
        if (lastIndex < 0 || currentChat.messages[lastIndex].type !== 'ai') return;

        let userMsg = '';
        for (let i = lastIndex - 1; i >= 0; i--) {
            if (currentChat.messages[i].type === 'user') {
                userMsg = currentChat.messages[i].modelInputText || currentChat.messages[i].text;
                break;
            }
        }
        if (!userMsg) {
            ctx.appendMessageToDOM('ai', '无法找到对应的用户消息，无法重新生成。', getCurrentTime(), true);
            return;
        }

        currentChat.messages.splice(lastIndex, 1);
        await ctx.chatRepo.saveChat(currentChat);
        ctx.renderMessages(ctx.getCurrentChatId(), ctx.getCurrentTopicIndex());
        await ctx.simulateAIResponse(userMsg);
    }

    async #continueAIMessage() {
        const ctx = this.ctx;
        const currentChat = ctx.getChats().find(c => c.id == ctx.getCurrentChatId());
        if (!currentChat) return;

        const lastMsg = currentChat.messages[currentChat.messages.length - 1];
        if (!lastMsg || lastMsg.type !== 'ai') return;

        const continuePrompt = '请继续刚才的话题，接着上面的内容继续说。';
        const userTime = getCurrentTime();
        currentChat.messages.push({
            type: 'user',
            text: continuePrompt,
            time: userTime,
            uid: genMsgUid('user', continuePrompt, userTime)
        });
        await ctx.chatRepo.saveChat(currentChat);
        await ctx.appendMessageToDOM('user', continuePrompt, userTime, false);
        await ctx.simulateAIResponse(continuePrompt);
    }
}

export default MessageActions;
