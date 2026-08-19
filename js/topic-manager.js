// 话题管理:话题索引辅助、开启新话题、切换话题(动画)、生成话题摘要
// 从 script.js 分离(阶段2),风格与其余 js/ 模块一致(构造注入依赖)
import Constants from './constants.js';
import { genMsgUid, getCurrentTime, parseThinkContent, parseParenthesesContent } from './utils.js';

export class TopicManager {
    /**
     * @param {Object} deps
     * @param {() => Array} deps.getChats
     * @param {() => number|string|null} deps.getCurrentChatId
     * @param {HTMLElement} deps.chatMessagesEl 消息滚动容器(.chat-messages)
     * @param {Object} deps.chatRepo
     * @param {Object} deps.ttsService
     * @param {() => Object} deps.getModelService
     * @param {Object} deps.uiScroll 请求锁
     * @param {Object} deps.uiAppearance 状态指示器
     * @param {() => void} deps.renderHistoryList
     * @param {(chatId, topicIdx) => void} deps.renderMessages
     * @param {() => Object} deps.getModalManager 惰性获取 modalManager(预留,与其余模块一致)
     */
    constructor({
        getChats, getCurrentChatId,
        chatMessagesEl,
        chatRepo,
        ttsService,
        getModelService,
        uiScroll,
        uiAppearance,
        renderHistoryList,
        renderMessages,
        getModalManager,
    }) {
        this.getChats = getChats;
        this.getCurrentChatId = getCurrentChatId;
        this.chatMessages = chatMessagesEl;
        this.chatRepo = chatRepo;
        this.ttsService = ttsService;
        this.getModelService = getModelService;
        this.uiScroll = uiScroll;
        this.uiAppearance = uiAppearance;
        this.renderHistoryList = renderHistoryList;
        this.renderMessages = renderMessages;
        this.getModalManager = getModalManager;
    }

    get chats() { return this.getChats(); }
    get currentChatId() { return this.getCurrentChatId(); }
    get modalManager() { return this.getModalManager(); }

    // ==================== 话题辅助函数 ====================
    // currentTopicIndex 移入 chat 对象，不使用全局变量
    getCurrentTopicIndex() {
        const chat = this.chats.find(c => c.id == this.currentChatId);
        return chat ? chat.currentTopicIndex : null;
    }

    setCurrentTopicIndex(value) {
        const chat = this.chats.find(c => c.id == this.currentChatId);
        if (chat) chat.currentTopicIndex = value;
    }

    /** 获取当前对话的活跃话题（当前选中话题），可能为 null */
    getActiveTopic(chat) {
        if (!chat || !chat.topics) return null;
        const idx = chat.currentTopicIndex;
        if (idx === null || idx === undefined || idx < 0 || idx >= chat.topics.length) return null;
        return chat.topics[idx];
    }

    // 开启新话题（创建独立话题对象 + 开场白）
    async startNewTopic() {
        const modelService = this.getModelService();
        if (modelService.isStreaming()) {
            if (confirm('当前正在生成回复，开启新话题会中断本次回复。是否继续？')) {
                modelService.abortCurrentStream();
                this.uiScroll.releaseRequestLock();
                this.ttsService.stop();
            } else {
                return;
            }
        }
        const currentChat = this.chats.find(c => c.id == this.currentChatId);
        if (!currentChat) return;
        const settings = currentChat.settings || Constants.DEFAULT_SETTINGS;
        const greeting = settings.greeting || Constants.DEFAULT_SETTINGS.greeting;

        // 创建新话题对象（独立消息列表）
        const aiTime = getCurrentTime();
        const newTopic = {
            id: Date.now(),
            name: `话题 ${currentChat.topics.length + 1}`,
            createdAt: new Date().toISOString(),
            summary: null,
            messages: [{
                type: 'ai',
                text: greeting,
                time: aiTime,
                uid: genMsgUid('ai', greeting, aiTime)
            }]
        };
        currentChat.topics.push(newTopic);
        const newTopicIndex = currentChat.topics.length - 1;

        // 切换到新话题视图
        await this.setCurrentTopic(newTopicIndex, false);

        // 刷新左侧历史列表
        currentChat.date = new Date();
        this.renderHistoryList();
        await this.chatRepo.saveChat(currentChat);

        // 如果当前对话开启语音合成，则朗读开场白（跳过括号内的非语言内容）
        if (settings.ttsEnabled) {
            const { replyContent } = parseThinkContent(greeting);
            const contentToSpeak = replyContent || greeting;
            const parts = parseParenthesesContent(contentToSpeak);
            const speechText = parts.filter(p => p.type === 'speech').map(p => p.text).join('');
            if (speechText.trim()) {
                const ttsVoice = currentChat?.settings?.ttsVoice || 'default';
                this.uiAppearance.updateStatusIndicator('speaking', '语音合成中 ...');
                this.ttsService.speak(speechText, ttsVoice)
                    .finally(() => this.uiAppearance.updateStatusIndicator('online'));
            }
        }
    }

    // 切换话题视图（带淡出/跌落动画）
    async setCurrentTopic(topicIndex) {
        const modelService = this.getModelService();
        if (modelService.isStreaming()) {
            if (confirm('正在生成回复，切换话题会中断当前回复。是否继续？')) {
                modelService.abortCurrentStream();
                // 释放请求锁
                this.uiScroll.releaseRequestLock();
                this.ttsService.stop();
            } else {
                return;
            }
        }

        const messagesContainer = this.chatMessages;
        if (!messagesContainer) return;

        // 1. 淡出旧消息（如果有）
        const oldMessages = Array.from(messagesContainer.children).filter(
            child => child.classList && (child.classList.contains('message') || child.classList.contains('topic-divider'))
        );
        if (oldMessages.length > 0) {
            oldMessages.forEach(msg => {
                msg.classList.remove('no-animation'); // 移除旧的无动画标记，让 fade-out 生效
                msg.classList.add('fade-out');
            });
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        // 2. 临时禁用默认入场动画
        messagesContainer.classList.add('no-entry-animation');

        // 3. 更新话题索引并重新渲染
        this.setCurrentTopicIndex(topicIndex);
        this.renderMessages(this.currentChatId, topicIndex);

        // 4. 为新消息添加跌落动画：只对最后几条做动画，前面的静默显示
        //    （消息过多时逐条错开延迟会拉长动画链并造成卡顿，限制动画条数可保持流畅）
        const MAX_ANIMATED = 6;
        const newMessages = Array.from(messagesContainer.children).filter(
            child => child.classList && (child.classList.contains('message') || child.classList.contains('topic-divider'))
        );
        const animStartIdx = Math.max(0, newMessages.length - MAX_ANIMATED);
        newMessages.forEach((msg, idx) => {
            if (idx >= animStartIdx) {
                msg.classList.add('topic-drop-in');
                msg.style.animationDelay = `${(idx - animStartIdx) * 0.05}s`;
            } else {
                msg.classList.add('no-animation');
            }
        });

        // 5. 动画结束后清理样式（等最后一条播完：延迟最多 (MAX-1)*0.05s + 动画 0.5s + 余量）
        // 先给当前消息加上 no-animation 防止移除 no-entry-animation 时重新触发入场动画
        setTimeout(() => {
            newMessages.forEach(msg => {
                msg.classList.remove('topic-drop-in');
                msg.classList.add('no-animation');
                msg.style.animationDelay = '';
            });
            messagesContainer.classList.remove('no-entry-animation');
        }, 500 + (MAX_ANIMATED - 1) * 50 + 100);
    }

    // 生成话题摘要
    async generateTopicSummary(topicIndex, topicMessages) {
        const currentChat = this.chats.find(c => c.id == this.currentChatId);
        if (!currentChat) return null;

        // 提取话题中所有用户和AI的消息文本
        const conversationText = topicMessages.map(msg => `${msg.type === 'user' ? '用户' : '助手'}：${msg.text}`).join('\n');
        if (!conversationText.trim()) return '（无内容）';

        const prompt = `请为以下对话生成一句简短的摘要（10-30字），简明扼要地概括主要内容：\n${conversationText}`;

        const modelService = this.getModelService();
        try {
            const summary = await modelService.generateText(prompt, { temperature: 0.3, maxTokens: 100 });
            return summary.trim() || '生成失败';
        } catch (err) {
            console.error('生成简介失败', err);
            return '生成失败，请检查模型配置';
        }
    }
}
