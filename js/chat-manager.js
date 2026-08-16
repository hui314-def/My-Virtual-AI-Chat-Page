// 对话管理:新建 / 切换 / 置顶 / 删除 / 快捷键切换
// 从 script.js 分离(阶段2),风格与其余 js/ 模块一致(构造注入依赖)
import Constants from './constants.js';
import { getCurrentTime } from './utils.js';
import { SettingsManager } from './settings-manager.js';

export class ChatManager {
    /**
     * @param {Object} deps
     * @param {() => Array} deps.getChats
     * @param {() => number|string|null} deps.getCurrentChatId
     * @param {(id) => void} deps.setCurrentChatId 写入当前对话 ID(含 localStorage 持久化)
     * @param {Object} deps.chatRepo
     * @param {Object} deps.ttsService
     * @param {() => Object} deps.getModelService
     * @param {Object} deps.uiScroll 请求锁
     * @param {Object} deps.uiAppearance 状态指示器
     * @param {() => void} deps.renderHistoryList
     * @param {(chatId, topicIdx) => void} deps.renderMessages
     * @param {() => void} deps.applyCurrentChatSettings
     * @param {(v) => void} deps.setCurrentTopicIndex
     * @param {() => number|null} deps.getCurrentTopicIndex
     * @param {() => void} deps.closeSidebarOnMobile
     * @param {() => Object} deps.getModalManager 惰性获取 modalManager(提示/确认)
     */
    constructor({
        getChats, getCurrentChatId,
        setCurrentChatId,
        chatRepo,
        ttsService,
        getModelService,
        uiScroll,
        uiAppearance,
        renderHistoryList,
        renderMessages,
        applyCurrentChatSettings,
        setCurrentTopicIndex,
        getCurrentTopicIndex,
        closeSidebarOnMobile,
        getModalManager,
    }) {
        this.getChats = getChats;
        this.getCurrentChatId = getCurrentChatId;
        this.setCurrentChatId = setCurrentChatId;
        this.chatRepo = chatRepo;
        this.ttsService = ttsService;
        this.getModelService = getModelService;
        this.uiScroll = uiScroll;
        this.uiAppearance = uiAppearance;
        this.renderHistoryList = renderHistoryList;
        this.renderMessages = renderMessages;
        this.applyCurrentChatSettings = applyCurrentChatSettings;
        this.setCurrentTopicIndex = setCurrentTopicIndex;
        this.getCurrentTopicIndex = getCurrentTopicIndex;
        this.closeSidebarOnMobile = closeSidebarOnMobile;
        this.getModalManager = getModalManager;
    }

    get chats() { return this.getChats(); }
    get currentChatId() { return this.getCurrentChatId(); }
    get modalManager() { return this.getModalManager(); }

    // 新建对话
    async createNewChat() {
        this.closeSidebarOnMobile();
        const newId = Date.now();
        // 新对话的标题使用默认设置
        const newSettings = JSON.parse(JSON.stringify(Constants.DEFAULT_SETTINGS));
        newSettings.contextLimit = SettingsManager.getContextLimit();
        newSettings.temperature = SettingsManager.getTemperature();
        newSettings.topP = SettingsManager.getTopP();
        newSettings.thinkLevel = SettingsManager.getThinkLevel();
        newSettings.maxTokens = SettingsManager.getMaxTokens();
        // 继承用户管理的用户名等
        const newChat = {
            id: newId,
            title: `新对话 ${this.chats.length + 1}`,
            date: new Date(),
            topics: [{
                id: Date.now(),
                name: '话题 1',
                createdAt: new Date().toISOString(),
                summary: null,
                messages: [
                    { type: 'ai', text: newSettings.greeting, time: getCurrentTime() }
                ]
            }],
            currentTopicIndex: 0,
            settings: newSettings,
            pinned: false
        };
        this.chats.unshift(newChat);
        this.setCurrentChatId(newId);
        this.renderHistoryList();
        this.renderMessages(this.currentChatId, 0);
        this.applyCurrentChatSettings();   // 应用新对话的设置（背景、名称等）
        await this.chatRepo.saveAllChats(this.chats);

        // 为新创建的历史项添加插入动画
        setTimeout(() => {
            const newItem = document.querySelector(`.history-item[data-id="${newId}"]`);
            if (newItem) {
                newItem.classList.add('inserting');
                newItem.addEventListener('animationend', () => {
                    newItem.classList.remove('inserting');
                }, { once: true });
            }
        }, 20); // 确保 DOM 已更新
    }

    // 切换对话
    switchChat(chatId) {
        const modelService = this.getModelService();
        this.ttsService.stop();
        if (this.uiAppearance.currentStatus === 'thinking' || this.uiAppearance.currentStatus === 'speaking') {
            this.uiAppearance.updateStatusIndicator('online');
        }
        // 检查是否有正在进行的流式回复
        if (modelService.isStreaming()) {
            if (confirm('当前对话正在生成回复，切换对话会中断当前回复。是否继续？')) {
                modelService.abortCurrentStream()
                // 释放请求锁（如果有）
                this.uiScroll.releaseRequestLock();
                this.ttsService.stop();
            } else {
                return;
            }
        }
        this.closeSidebarOnMobile();
        if (this.currentChatId == chatId) return;
        this.setCurrentChatId(chatId);
        // ✅ 使用 chat 自身存储的 currentTopicIndex，未设置时默认最后一个话题
        const chat = this.chats.find(c => c.id == chatId);
        if (chat) {
            if (chat.currentTopicIndex === undefined || chat.currentTopicIndex === null) {
                chat.currentTopicIndex = chat.topics.length > 0 ? chat.topics.length - 1 : null;
            }
        }
        this.renderHistoryList();
        this.renderMessages(this.currentChatId, this.getCurrentTopicIndex());
        this.applyCurrentChatSettings();
    }

    // 切换到上一个/下一个对话（在 chats 数组中按排序顺序）
    switchToPreviousChat() {
        // 按置顶 + 时间倒序排列（与 renderHistoryList 相同）
        const sorted = [...this.chats].sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return b.date - a.date;
        });
        const idx = sorted.findIndex(c => c.id == this.currentChatId);
        if (idx > 0) this.switchChat(sorted[idx - 1].id);
    }

    switchToNextChat() {
        const sorted = [...this.chats].sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return b.date - a.date;
        });
        const idx = sorted.findIndex(c => c.id == this.currentChatId);
        if (idx < sorted.length - 1) this.switchChat(sorted[idx + 1].id);
    }

    // 收藏置顶（将对话移到列表最上方）
    async togglePinChat(chat) {
        chat.pinned = !chat.pinned;
        // 重新排序并渲染列表
        this.renderHistoryList();
        await this.chatRepo.saveChat(chat);
        this.modalManager.showBriefToast(chat.pinned ? '📌 已置顶该会话' : '📍 已取消置顶')
    }

    // 删除会话
    async deleteChat(chatId) {
        if (this.chats.length === 1) {
            this.modalManager.customAlert('至少保留一个对话，无法删除最后一个。', 'warn');
            return;
        }
        if (!confirm('确定要删除这个会话吗？此操作不可撤销。')) return;

        const item = document.querySelector(`.history-item[data-id="${chatId}"]`);
        if (item) {
            // 添加删除动画类
            item.classList.add('removing');

            // 监听过渡结束事件（取第一个完成的属性即可）
            const onTransitionEnd = (e) => {
                if (e.propertyName === 'transform') { // 以 transform 为准
                    item.removeEventListener('transitionend', onTransitionEnd);
                    performDelete(chatId);
                }
            };
            item.addEventListener('transitionend', onTransitionEnd);

            // 万一动画不触发，兜底在 400ms 后强制删除
            setTimeout(() => {
                if (item.classList.contains('removing')) {
                    item.removeEventListener('transitionend', onTransitionEnd);
                    performDelete(chatId);
                }
            }, 400);
        } else {
            // 找不到 DOM 元素时直接删除
            performDelete(chatId);
        }

        // 实际的删除逻辑(箭头函数保持 this 指向 ChatManager)
        const performDelete = async (id) => {
            const index = this.chats.findIndex(c => c.id === id);
            if (index !== -1) {
                this.chats.splice(index, 1);
                if (this.currentChatId === id) {
                    this.setCurrentChatId(this.chats[0].id);
                    this.setCurrentTopicIndex(null);
                    this.renderMessages(this.currentChatId);
                    this.applyCurrentChatSettings();
                }
            }
            this.renderHistoryList();       // 重新渲染列表（此时已无删除动画，会平滑出现）
            await this.chatRepo.saveAllChats(this.chats);

            // 提示
            this.modalManager.showBriefToast('🗑️ 会话已删除')
        };
    }
}
