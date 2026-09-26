// 对话管理:新建 / 切换 / 置顶 / 删除 / 快捷键切换
// 从 script.js 分离(阶段2),风格与其余 js/ 模块一致(构造注入依赖)
import { getCurrentTime, replaceSTMacros } from '../core/utils.js';
import Constants from '../core/constants.js';
import { SettingsManager } from '../core/settings-manager.js';
import {
    buildDisplayNames, buildInitialSpaceSettings, defaultOrchestratorPolicy,
    GROUP_MIN_MEMBERS, GROUP_MAX_MEMBERS,
} from '../group/group-core.js';

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
        onDeleteChat = () => {},
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
        this.onDeleteChat = onDeleteChat;
    }

    get chats() { return this.getChats(); }
    get currentChatId() { return this.getCurrentChatId(); }
    get modalManager() { return this.getModalManager(); }

    // 新建对话：先弹出对话设置弹窗，用户点击「保存设置」后才真正创建对话
    async createNewChat() {
        this.closeSidebarOnMobile();
        this.modalManager.openSettingsModal({ newChat: true });
    }

    // 使用传入的设置新建对话（供「新对话 → 先弹设置 → 保存后创建」流程使用）
    async createNewChatWithSettings(settings) {        this.closeSidebarOnMobile();
        // 开场白支持 SillyTavern 宏：创建时解析一次并定型（动态宏无上下文 → 空串）
        const stUserName = (settings.userProfileName || '').trim()
            || (SettingsManager.getUsername() === Constants.DEFAULT_USERNAME ? '用户' : SettingsManager.getUsername());
        const greeting = replaceSTMacros(settings.greeting, {
            roleName: settings.roleName || Constants.DEFAULT_ROLE_NAME,
            userName: stUserName,
            greeting: settings.greeting,
            charVersion: settings.cardMeta?.characterVersion,
        });
        const newId = Date.now();
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
                    { type: 'ai', text: greeting, time: getCurrentTime() }
                ]
            }],
            currentTopicIndex: 0,
            settings,
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

    /**
     * 新建群聊（编排者驱动的多智能体会话）。
     *
     * - 成员的角色参数（人设 / 头像 / 音色 / 模型参数）**不复制**，而是通过
     *   `sourceChatId` 实时继承自各自的来源对话（见 js/group/group-core.js）
     * - 背景 / 背景音乐 / 用户画像属于「群空间设置」，由群聊独立维护，
     *   初始值跟随**第一个被选中的成员**（D15）
     *
     * @param {Object} p
     * @param {Array}  p.members - [{ sourceChatId, name, sourceTitle, ... }]
     * @param {string} [p.name]  - 群聊名称，留空自动生成
     * @returns {Promise<Object>} 新建的群聊会话
     */
    async createGroupChat({ members = [], name = '' } = {}) {
        this.closeSidebarOnMobile();

        if (members.length < GROUP_MIN_MEMBERS || members.length > GROUP_MAX_MEMBERS) {
            throw new Error(`群聊需要 ${GROUP_MIN_MEMBERS}~${GROUP_MAX_MEMBERS} 个角色`);
        }

        // 重名去重：同名自动追加 (2)、(3)
        const displayNames = buildDisplayNames(members);

        const groupMembers = members.map((c, i) => ({
            memberId: `m_${i + 1}`,
            displayName: displayNames[i],
            sourceChatId: c.sourceChatId,
            sourceTitle: c.sourceTitle || '',
            detached: false,
            snapshot: null,
            lastResolved: null,
        }));

        // 群空间初始值：跟随第一个被选中的成员
        const firstSource = this.chats.find(c => c.id == members[0].sourceChatId);
        const spaceSettings = buildInitialSpaceSettings(firstSource?.settings || null);

        const autoTitle = members.length <= 3
            ? `群聊 · ${displayNames.join(' / ')}`
            : `群聊 · ${displayNames.slice(0, 3).join(' / ')} 等 ${members.length} 人`;

        const newId = Date.now();
        const newChat = {
            id: newId,
            kind: 'group',
            title: name || autoTitle,
            date: new Date(),
            topics: [{
                id: Date.now(),
                name: '群聊',
                createdAt: new Date().toISOString(),
                summary: null,
                messages: [],
            }],
            currentTopicIndex: 0,
            members: groupMembers,
            orchestrator: defaultOrchestratorPolicy(),
            settings: spaceSettings,
            pinned: false,
        };

        this.chats.unshift(newChat);
        this.setCurrentChatId(newId);
        this.renderHistoryList();
        await this.renderMessages(this.currentChatId, 0);
        this.applyCurrentChatSettings();
        await this.chatRepo.saveAllChats(this.chats);

        return newChat;
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
        if (!confirm('确定要删除这个会话吗？此操作不可撤销。\n\n该角色的专属记忆将一并删除。')) return;

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

            // 级联删除该对话的专属记忆(热层+归档+日志;全局记忆不受影响)
            try { await this.onDeleteChat(id); } catch (err) { console.warn('[Memory] 删除对话记忆失败：', err); }

            // 提示
            this.modalManager.showBriefToast('🗑️ 会话已删除')
        };
    }
}
