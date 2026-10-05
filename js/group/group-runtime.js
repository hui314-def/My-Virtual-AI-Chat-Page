// ============================================================
// 群聊 · 运行时（发送流程 / 消息渲染 / 旁观模式 / @点名）
// ------------------------------------------------------------
// 这是群聊功能与主程序之间的粘合层：
//   - 主程序的 renderMessages() 遇到群聊时委托给本模块渲染
//   - 主程序的 sendUserMessage() 遇到群聊时委托给本模块发送
//   - 所有依赖通过构造注入，尽量不侵入既有代码路径
// ============================================================
import Constants from '../core/constants.js';
import { escapeHtml, getCurrentTime, genMsgUid } from '../core/utils.js';
import { SettingsManager } from '../core/settings-manager.js';
import { resolveAssetUrl } from '../network/asset-sync.js';
import {
    isGroupChat, ensureGroupDefaults, resolveMembers, reconcileGroupMembers,
    MEMBER_HUES, GROUP_MIN_MEMBERS, toPipelineHistory, parseMentions,
} from './group-core.js';
import { runGroupTurn, runSpectator } from './group-pipeline.js';
import { StreamTextRenderer, appendFadeText } from '../ui/stream-text.js';

// ============================================================
// 流式渲染辅助（模块级纯函数）
// ============================================================

/**
 * 面向「流式中间态」的标签解析。
 *
 * `utils.parseSoulContent()` 用的是 `<soul>([\s\S]*?)<\/soul>` —— 必须有闭合标签。
 * 但流式过程中模型往往已经吐出了 `<soul>我有点紧张` 而 `</soul>` 还没来，
 * 这时正则匹配不上，裸标签就会直接显示在正文里（这正是之前的问题）。
 *
 * 这里额外处理三种情况：
 *   1. 已闭合的 <think>/<soul> → 正常摘出
 *   2. **未闭合**的（流到一半）→ 也摘出来，当作「进行中的」内容
 *   3. 末尾「还没写完的标签」（如 `<`、`<so`、`</sou`）→ 先隐藏，避免闪出半截标签
 *
 * @returns {{thinkContent: string, soulContent: string, bodyContent: string}}
 */
export function parseStreamingTags(rawText) {
    let rest = String(rawText || '');

    const extract = (tag) => {
        const closedRe = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
        const closed = rest.match(closedRe);
        if (closed) {
            rest = rest.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'g'), '');
            return closed[1];
        }
        // 未闭合：把 <tag> 之后的全部内容都当作「进行中」的该标签内容
        const openRe = new RegExp(`<${tag}>([\\s\\S]*)$`);
        const open = rest.match(openRe);
        if (open) {
            rest = rest.slice(0, open.index);
            return open[1];
        }
        return '';
    };

    const thinkContent = extract('think');
    const soulContent = extract('soul');

    // 模型偶尔多写一个孤立闭合标签；顺带隐藏末尾「还没写完的标签」
    rest = rest
        .replace(/<\/?(?:think|soul)>/g, '')
        .replace(/<\/?[a-zA-Z]*$/, '');

    return {
        thinkContent: thinkContent.trim(),
        soulContent: soulContent.trim(),
        bodyContent: rest.trim(),
    };
}

/**
 * 维护一个「只会变长」的折叠面板（思考过程 / 内心OS）。
 *
 * 与最终渲染（`utils.renderMessageWithThink`）产出的 DOM 结构保持一致：
 *   <details class="think-details [thinking]" [open]>
 *     <summary><span class="think-title">…</span><span class="think-indicator"></span></summary>
 *     <div class="think-content">…</div>
 *   </details>
 *
 * 内容增量用 `.fade-in-text` 追加，所以面板里的文字也是逐块淡入的
 * （与私聊的内心OS 面板表现一致）。
 *
 * @param {HTMLElement} slot - 承载面板的容器
 * @param {Object} cfg - { detailsClass, generatingClass, contentClass, titleClass, titleText, indicatorClass }
 * @returns {{update: Function, finish: Function}}
 */
export function createGrowingPanel(slot, cfg) {
    let detailsEl = null;
    let contentEl = null;
    let shown = '';

    const ensure = () => {
        if (detailsEl || !slot) return;
        detailsEl = document.createElement('details');
        detailsEl.className = `${cfg.detailsClass} ${cfg.generatingClass}`;
        detailsEl.open = true;
        detailsEl.innerHTML =
            `<summary><span class="${cfg.titleClass}">${cfg.titleText}</span>`
            + `<span class="${cfg.indicatorClass}"></span></summary>`
            + `<div class="${cfg.contentClass}"></div>`;
        slot.appendChild(detailsEl);
        contentEl = detailsEl.querySelector(`.${cfg.contentClass}`);
    };

    return {
        update(text) {
            if (!text || !slot) return;
            ensure();
            if (text === shown) return;
            if (text.startsWith(shown)) {
                appendFadeText(contentEl, text.slice(shown.length));
            } else {
                // 罕见：已输出内容被改写 → 整段重建
                contentEl.textContent = text;
            }
            shown = text;
        },
        finish() {
            if (!detailsEl) return;
            detailsEl.classList.remove(cfg.generatingClass);
            detailsEl.open = false;
            const dot = detailsEl.querySelector(`.${cfg.indicatorClass}`);
            if (dot) dot.remove();
        },
    };
}

export class GroupRuntime {
    /**
     * @param {Object} deps
     * @param {() => Array} deps.getChats
     * @param {() => number|string|null} deps.getCurrentChatId
     * @param {() => Object} deps.getModelService           - 主模型（成员发言）
     * @param {() => Object} deps.getOrchestratorService    - 辅助模型（编排者）
     * @param {Object} deps.chatRepo
     * @param {HTMLElement} deps.chatMessagesEl
     * @param {HTMLElement} deps.messageInputEl
     * @param {() => Object} deps.getTopicManager
     * @param {Object} deps.uiScroll
     * @param {Object} deps.uiAppearance
     * @param {() => Object} deps.getModalManager
     * @param {Function} deps.appendMessageToDOM
     * @param {() => void} deps.renderHistoryList
     * @param {() => Object} deps.getGroupUI
     * @param {() => Object} [deps.getPromptInjectManager] - 惰性获取提示词注入管理器
     */
    constructor({
        getChats, getCurrentChatId, getModelService, getOrchestratorService,
        chatRepo, chatMessagesEl, messageInputEl, getTopicManager,
        uiScroll, uiAppearance, getModalManager, appendMessageToDOM,
        renderHistoryList, getGroupUI, getPromptInjectManager = () => null,
    }) {
        this.getChats = getChats;
        this.getCurrentChatId = getCurrentChatId;
        this.getModelService = getModelService;
        this.getOrchestratorService = getOrchestratorService;
        this.chatRepo = chatRepo;
        this.chatMessagesEl = chatMessagesEl;
        this.messageInputEl = messageInputEl;
        this.getTopicManager = getTopicManager;
        this.uiScroll = uiScroll;
        this.uiAppearance = uiAppearance;
        this.getModalManager = getModalManager;
        this.appendMessageToDOM = appendMessageToDOM;
        this.renderHistoryList = renderHistoryList;
        this.getGroupUI = getGroupUI;
        this.getPromptInjectManager = getPromptInjectManager;

        this._running = false;
        this._spectating = false;
        this._ctl = { aborted: false };
        this._mentionPop = null;
        /** 用户插话队列：本轮群聊回复进行中，用户又发的消息（旁观模式不使用） */
        this._interjectQueue = [];
        /** 进入「可插话」状态前输入框的 placeholder，退出时还原 */
        this._savedPlaceholder = null;
    }

    get modalManager() { return this.getModalManager(); }
    get chats() { return this.getChats() || []; }

    currentChat() {
        return this.chats.find(c => c.id == this.getCurrentChatId()) || null;
    }

    /** 当前会话是否群聊 */
    isActive() {
        const chat = this.currentChat();
        return isGroupChat(chat);
    }

    /**
     * 渲染「提示词注入」块（与私聊 simulateAIResponse 行为一致）。
     * 每个成员用**它自己的** roleName / persona 渲染占位符，因此每个人拿到的注入块是定制的。
     * @param {{roleName:string, userName:string, userBio:string, rolePersona:string}} c
     * @returns {string|null}
     */
    _renderInjection(c) {
        const mgr = this.getPromptInjectManager && this.getPromptInjectManager();
        if (!mgr || typeof mgr.buildInjectionBlock !== 'function') return null;
        try {
            return mgr.buildInjectionBlock({
                roleName: c.roleName,
                userName: c.userName,
                userBio: c.userBio,
                rolePersona: c.rolePersona,
            });
        } catch (err) {
            console.warn('[GroupRuntime] 提示词注入渲染失败：', err);
            return null;
        }
    }

    isRunning() { return this._running; }
    isSpectating() { return this._spectating; }

    /**
     * 当前是否允许「插话」——群聊发言进行中、且不在旁观模式。
     * 旁观模式下用户是观众，不支持插话。
     */
    canInterject() {
        return this._running && !this._spectating && this.isActive();
    }

    // ============================================================
    // 1. 群聊模式开关（输入区按钮精简约 D8）
    // ============================================================

    /** 根据当前会话类型切换 body.group-mode（控制输入区按钮精简） */
    syncGroupMode() {
        const isGroup = this.isActive();
        document.body.classList.toggle('group-mode', isGroup);

        // 输入区的设置按钮：群聊下改名为「群聊设置」（打开的是群聊专属弹窗）
        const settingsBtn = document.getElementById('chat-settings-btn');
        if (settingsBtn) {
            settingsBtn.innerHTML = isGroup
                ? '<i class="fas fa-users-cog"></i> 群聊设置'
                : '<i class="fas fa-sliders-h"></i> 对话设置';
        }

        if (!isGroup) this._removeMentionPop();
        // 旁观开关按钮的显隐 / 文案随会话类型刷新
        this.syncSpectatorButton();
    }

    // ============================================================
    // 2. 渲染（由 script.js 的 renderMessages 委托）
    // ============================================================

    /**
     * 渲染群聊会话的消息。
     * 群聊 v1 固定单一话题，因此直接渲染 topics[0]（或指定的 topicIndex）。
     */
    async renderMessages(chat, topicIndex = null) {
        if (!isGroupChat(chat)) return;

        ensureGroupDefaults(chat);
        // 渲染前对账：源对话被删 → 脱钩兜底
        if (reconcileGroupMembers(chat, this.chats)) {
            this.chatRepo.saveChat(chat).catch(() => {});
        }

        const members = resolveMembers(chat, this.chats);
        const topics = chat.topics || [];
        const idx = (topicIndex !== null && topics[topicIndex]) ? topicIndex : 0;
        const topic = topics[idx];
        if (!topic) return;

        this.chatMessagesEl.innerHTML = '';
        this.chatMessagesEl.classList.remove('no-entry-animation');

        for (const msg of topic.messages) {
            const member = msg.memberId ? members.find(m => m.memberId === msg.memberId) : null;
            const memberInfo = member
                ? {
                    memberId: member.memberId,
                    name: member.displayName,
                    hue: member.hue,
                    detached: member.detached,
                    sourceChatId: member.sourceChatId,   // 供「点击头像 → 打开该成员的对话设置」
                }
                : (msg.memberId
                    ? { memberId: msg.memberId, name: msg.memberName || '成员', hue: 212, detached: true, sourceChatId: null }
                    : null);

            await this.appendMessageToDOM(
                msg.type,
                msg.text,
                msg.time,
                false,
                null,
                member ? member.avatarUrl : null,
                msg.file || null,
                msg.modelName || null,
                msg.uid,
                msg.quoteRef || null,
                msg.knowledgeSources || null,
                msg.images || null,
                msg.thinkSeconds ?? null,
                memberInfo
            );
        }

        if (topic.messages.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'topic-empty';
            emptyDiv.innerHTML = `<div style="text-align:center; padding:20px; color:#8e8eb3;">
                ${escapeHtml(chat.title || '群聊')} 已就绪<br>
                <span style="font-size:0.78rem; opacity:0.7;">直接发言，或输入 <code>@成员名</code> 点名发言</span>
            </div>`;
            this.chatMessagesEl.appendChild(emptyDiv);
        }

        this.uiScroll.conditionalScrollToBottom();
    }

    // ============================================================
    // 3. 发送流程（由 script.js 的 sendUserMessage 委托）
    // ============================================================

    /**
     * @param {Object} input - { text, fileAttachment, imageAttachments, imageUrls, quoteRef }
     * @returns {Promise<boolean>} 是否已由群聊接管处理
     */
    async send({ text, fileAttachment = null, imageAttachments = [], imageUrls = [], quoteRef = null }) {
        const chat = this.currentChat();
        if (!isGroupChat(chat)) return false;

        // —— 插话：群聊回复进行中，用户又发了一条消息 ——
        if (this._running) {
            if (this._spectating) {
                this.modalManager.showBriefToast('旁观模式下不支持插话，请先点「停止旁观」');
                return true;
            }
            await this._interject(chat, { text, fileAttachment, imageAttachments, imageUrls, quoteRef });
            return true;
        }

        // 与私聊共用同一把请求锁，避免群聊发言期间触发其它请求流程
        if (!this.uiScroll.acquireRequestLock()) {
            this.modalManager.showBriefToast('请等待当前回复完成后再发送');
            return true;
        }

        // 群聊发言期间允许「插话」：请求锁会把发送按钮禁用，这里立刻恢复它
        this._interjectQueue = [];
        this.uiScroll.enableInput();

        try {
            ensureGroupDefaults(chat);
            reconcileGroupMembers(chat, this.chats);

            const members = resolveMembers(chat, this.chats);
            if (!members.length) {
                this.modalManager.customAlert('群聊里没有可用的成员（来源对话可能已被删除）。请到群聊设置里调整成员。', 'warning');
                return true;
            }

            const topicManager = this.getTopicManager();
            const topic = topicManager.getActiveTopic(chat) || chat.topics[0];

            // @点名：默认行为（不再有开关）。被点名者必定发言，编排者用剩余名额补位 —— D20
            const mentionIds = parseMentions(text, members);

            // ---- 用户消息落库 + 渲染 ----
            const userTime = getCurrentTime();
            const uid = genMsgUid('user', text, userTime);
            topic.messages.push({
                type: 'user',
                text,
                time: userTime,
                file: fileAttachment || undefined,
                images: imageAttachments.length > 0 ? imageAttachments : undefined,
                uid,
                quoteRef: quoteRef || undefined,
            });
            chat.date = new Date();
            this.renderHistoryList();
            await this.appendMessageToDOM('user', text, userTime, false, null, null, fileAttachment, null, uid, quoteRef, null, imageAttachments);

            // ---- 进入群聊回复流程 ----
            this._running = true;
            this._ctl = { aborted: false };
            this._setProcessingUI(true, true);   // true = 可插话
            this.syncSpectatorButton();

            const liveBubbles = new Map();

            try {
                await runGroupTurn({
                    members,
                    policy: chat.orchestrator,
                    history: toPipelineHistory(topic.messages),
                    userText: text,
                    mentionIds,
                    interjections: this._interjectQueue,   // 支持用户插话
                    memberService: this.getModelService(),
                    orchestratorService: this.getOrchestratorService(),
                    ctl: this._ctl,
                    userName: this._resolveUserName(chat),
                    userBio: this._resolveUserBio(chat),
                    attachment: fileAttachment,
                    images: imageUrls,
                    renderInjection: (c) => this._renderInjection(c),
                    hooks: this._buildHooks(chat, topic, members, liveBubbles),
                });

                await this.chatRepo.saveChat(chat);

            } catch (err) {
                console.error('[GroupRuntime] 群聊发送失败：', err);
                this.modalManager.showBriefToast('群聊回复出错：' + (err.message || err));
            } finally {
                this._cleanupLive(liveBubbles);
                this._removeOrchestratorHint();
                this._interjectQueue = [];
                this._running = false;
                this._setProcessingUI(false);
                this.syncSpectatorButton();
                // 用正式状态重绘，避免 DOM 与数据漂移
                await this.renderMessages(chat, null);
            }

            return true;

        } finally {
            this.uiScroll.releaseRequestLock();
        }
    }

    /**
     * 用户插话：群聊回复进行中收到的消息。
     *
     * - 立刻落库 + 显示在聊天流（时间顺序上排在正在生成的成员气泡之后）
     * - 同时推入插话队列交给流水线：
     *     · 后续发言的成员会看到它（并入 liveHistory）
     *     · 本轮发言结束后会**触发一次重新编排**来回应插话
     * - 旁观模式下不会走到这里（canInterject 为 false）
     */
    async _interject(chat, { text, fileAttachment = null, imageAttachments = [], imageUrls = [], quoteRef = null }) {
        const topicManager = this.getTopicManager();
        const topic = topicManager.getActiveTopic(chat) || chat.topics[0];
        if (!topic) return;

        const members = resolveMembers(chat, this.chats);

        const time = getCurrentTime();
        const uid = genMsgUid('user', text, time);

        topic.messages.push({
            type: 'user',
            text,
            time,
            file: fileAttachment || undefined,
            images: imageAttachments.length > 0 ? imageAttachments : undefined,
            uid,
            quoteRef: quoteRef || undefined,
        });
        chat.date = new Date();

        // 立刻显示到聊天流
        await this.appendMessageToDOM(
            'user', text, time, false, null, null,
            fileAttachment, null, uid, quoteRef, null, imageAttachments
        );

        // 交给流水线
        this._interjectQueue.push({
            text,
            time,
            uid,
            imageUrls: imageUrls || [],
            mentionIds: parseMentions(text, members),
        });

        this.renderHistoryList();
        this.chatRepo.saveChat(chat).catch(() => {});
        this.modalManager.showBriefToast('💬 已插话，成员们会看到你的补充');
    }

    // ============================================================
    // 4. 旁观模式
    // ============================================================

    async startSpectator() {
        const chat = this.currentChat();
        if (!isGroupChat(chat)) return;
        if (this._running) {
            this.modalManager.showBriefToast('正在回复中，请稍候');
            return;
        }
        if (!this.uiScroll.acquireRequestLock()) {
            this.modalManager.showBriefToast('请等待当前回复完成后再开始旁观');
            return;
        }

        ensureGroupDefaults(chat);
        reconcileGroupMembers(chat, this.chats);
        const members = resolveMembers(chat, this.chats);
        if (!members.length) {
            this.uiScroll.releaseRequestLock();
            this.modalManager.customAlert('群聊里没有可用的成员。', 'warning');
            return;
        }

        const topicManager = this.getTopicManager();
        const topic = topicManager.getActiveTopic(chat) || chat.topics[0];

        this._running = true;
        this._spectating = true;
        this._ctl = { aborted: false };
        this._setProcessingUI(true, false);   // 旁观模式：不可插话（发送按钮保持禁用）
        this.syncSpectatorButton();

        const liveBubbles = new Map();

        try {
            this._showOrchestratorHint(
                chat.orchestrator.spectatorRounds < 0
                    ? '👀 旁观模式启动（无限轮，随时可停）'
                    : `👀 旁观模式启动（共 ${chat.orchestrator.spectatorRounds} 轮）`
            );

            await runSpectator({
                members,
                policy: chat.orchestrator,
                history: toPipelineHistory(topic.messages),
                memberService: this.getModelService(),
                orchestratorService: this.getOrchestratorService(),
                ctl: this._ctl,
                userName: this._resolveUserName(chat),
                userBio: this._resolveUserBio(chat),
                renderInjection: (c) => this._renderInjection(c),
                hooks: this._buildHooks(chat, topic, members, liveBubbles, true),
            });

            await this.chatRepo.saveChat(chat);

        } catch (err) {
            console.error('[GroupRuntime] 旁观模式失败：', err);
            this.modalManager.showBriefToast('旁观出错：' + (err.message || err));
        } finally {
            this._cleanupLive(liveBubbles);
            this._removeOrchestratorHint();
            this._running = false;
            this._spectating = false;
            this._setProcessingUI(false);
            this.syncSpectatorButton();
            await this.renderMessages(chat, null);
            const groupUI = this.getGroupUI();
            if (groupUI && typeof groupUI._syncSpectatorButton === 'function') {
                try { groupUI._syncSpectatorButton(); } catch { /* ignore */ }
            }
            this.uiScroll.releaseRequestLock();
        }
    }

    stopSpectator() {
        if (!this._running) return;
        this._ctl.aborted = true;
        try { this.getModelService()?.abortCurrentStream(); } catch { /* ignore */ }
    }

    /** 供群聊设置弹窗的按钮调用：正在旁观则停，否则开始 */
    toggleSpectator() {
        if (this._spectating) this.stopSpectator();
        else this.startSpectator();
    }

    /**
     * 同步「开始旁观 / 停止旁观」按钮外观。
     * 两处入口共用同一状态：输入区按钮栏里的开关按钮 + 群聊设置弹窗里的按钮。
     */
    syncSpectatorButton() {
        const groupUI = this.getGroupUI();
        if (groupUI && typeof groupUI._syncSpectatorButton === 'function') {
            try { groupUI._syncSpectatorButton(); } catch { /* ignore */ }
        }

        // 输入区按钮栏里的开关：点击在「开始旁观 / 停止旁观」之间切换
        const btn = document.getElementById('group-spectator-btn');
        if (!btn) return;

        const active = this._spectating;
        btn.classList.toggle('active', active);
        // 普通回复进行中（非旁观）时不可再点，避免打断
        btn.disabled = this._running && !active;
        btn.title = active ? '停止旁观' : '让成员们自己聊起来（不需要你发言）';

        const icon = btn.querySelector('i');
        if (icon) icon.className = active ? 'fas fa-stop' : 'fas fa-eye';
        const label = document.getElementById('group-spectator-label');
        if (label) label.textContent = active ? '停止旁观' : '开始旁观';
    }

    // ============================================================
    // 5. 内部：流水线回调
    // ============================================================

    _buildHooks(chat, topic, members, liveBubbles, spectator = false) {
        return {
            onStatus: (text, level) => {
                if (level === 'idle' || level === 'ok') {
                    this._removeOrchestratorHint();
                } else if (level === 'orchestrating' || level === 'spectator') {
                    this._showOrchestratorHint(text);
                }
                this.uiAppearance.updateStatusIndicator(
                    this._running ? 'thinking' : 'online',
                    text
                );
            },

            onDecision: (d) => {
                const nameOf = (id) => members.find(m => m.memberId === id)?.displayName || '';
                if (Array.isArray(d.mentioned) && d.mentioned.length) {
                    const mentioned = d.mentioned.map(nameOf).filter(Boolean).join('、');
                    const extra = (d.extra || []).map(nameOf).filter(Boolean).join('、');
                    this._showOrchestratorHint(extra
                        ? `📣 点名「${mentioned}」｜🎬 编排补充「${extra}」`
                        : `📣 已点名「${mentioned}」· 编排者认为无需其他人补充`);
                    return;
                }
                if (d.reason) {
                    this._showOrchestratorHint(d.degraded ? `⚠️ ${d.reason}` : `🎬 ${d.reason}`);
                }
            },

            onMemberStart: (member) => {
                this._removeOrchestratorHint();
                const bubble = this._createLiveBubble(member);
                liveBubbles.set(member.memberId, bubble);
                this.uiAppearance.updateStatusIndicator('speaking', `${member.displayName} 正在回应…`);
            },

            onMemberThinking: (member, text) => {
                const b = liveBubbles.get(member.memberId);
                if (b && b.appendThinking) b.appendThinking(text);
            },

            onMemberChunk: (member, text) => {
                const b = liveBubbles.get(member.memberId);
                if (b) b.appendContent(text);
            },

            onMemberEnd: (member) => {
                // 该成员说完 → 立刻定稿这一条（收起思考/内心OS 面板，正文保持括号斜体）
                const b = liveBubbles.get(member.memberId);
                if (b) b.finalize();
            },

            onSave: async (msg) => {
                // 落库：思考内容以 <think> 包裹后嵌入正文，保证重渲染时折叠面板能还原
                const storedText = msg.thinkText ? `<think>${msg.thinkText}</think>${msg.text}` : msg.text;
                const time = getCurrentTime();
                topic.messages.push({
                    type: 'ai',
                    text: storedText,
                    time,
                    memberId: msg.memberId,
                    memberName: msg.memberName,
                    uid: genMsgUid('ai', storedText, time),
                });
                chat.date = new Date();
            },

            onError: (err, member) => {
                console.error('[GroupRuntime] 成员发言出错：', err);
                this.modalManager.showBriefToast(`「${member.displayName}」发言失败：${err.message || err}`);
            },
        };
    }

    _resolveUserName(chat) {
        const chatProfile = (chat.settings?.userProfileName || '').trim();
        if (chatProfile) return chatProfile;
        const g = SettingsManager.getUsername();
        return (g && g !== Constants.DEFAULT_USERNAME) ? g : '用户';
    }

    _resolveUserBio(chat) {
        const chatProfile = (chat.settings?.userProfileBio || '').trim();
        return chatProfile || SettingsManager.getBio() || '';
    }

    // ============================================================
    // 6. 内部：DOM 辅助
    // ============================================================

    /**
     * 切换「正在生成」的界面状态。
     * @param {boolean} processing
     * @param {boolean} [interjectable] - 是否处于可插话状态（群聊发言中=true；旁观=false）
     */
    _setProcessingUI(processing, interjectable = false) {
        const sendBtn = document.querySelector('.send-btn');
        document.body.classList.toggle('grp-live', !!processing && interjectable);

        if (sendBtn) {
            sendBtn.classList.toggle('grp-busy', !!processing);
            sendBtn.title = (processing && interjectable) ? '发送（插话，成员们会看到）' : '发送';
        }

        // 输入框提示：可插话时换成更明确的文案，结束后还原
        const input = this.messageInputEl;
        if (input) {
            if (processing && interjectable) {
                if (this._savedPlaceholder === null) this._savedPlaceholder = input.placeholder;
                input.placeholder = '可以在这里插话，成员们会看到你的补充…';
            } else if (this._savedPlaceholder !== null) {
                input.placeholder = this._savedPlaceholder;
                this._savedPlaceholder = null;
            }
        }

        if (!processing) this.uiAppearance.updateStatusIndicator('online');
    }

    /**
     * 临时气泡：一个「正在输入…」的群成员消息。
     *
     * 关键点：**流式期间就用与最终渲染完全相同的排版**，且与私聊共用同一套流式渲染：
     *   · 正文 → `js/ui/stream-text.js` 的 StreamTextRenderer
     *     （括号闭合立即斜体 + 逐块淡入，两者兼得）
     *   · 思考 / 内心OS → createGrowingPanel（默认展开 + 生成中呼吸点 + 逐块淡入）
     * 该成员一说完就 `finalize()` 收起面板，不必等所有成员说完。
     */
    _createLiveBubble(member) {
        const wrap = document.createElement('div');
        wrap.className = 'message ai';
        wrap.dataset.member = member.memberId;
        wrap.style.setProperty('--m-hue', String(member.hue ?? MEMBER_HUES[0]));

        const avatarHtml = member.avatarUrl
            ? `<img src="${escapeHtml(resolveAssetUrl(member.avatarUrl))}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;">`
            : '<i class="fas fa-robot"></i>';

        wrap.innerHTML = `
            <div class="avatar-msg">${avatarHtml}</div>
            <div class="bubble">
                <div class="msg-sender">${escapeHtml(member.displayName)}<span class="grp-typing">正在输入…</span></div>
                <div class="grp-think-slot"></div>
                <div class="grp-soul-slot"></div>
                <p class="grp-live-body"></p>
                <div class="msg-time">${escapeHtml(getCurrentTime())}</div>
            </div>`;

        // 清掉空态提示
        const empty = this.chatMessagesEl.querySelector('.topic-empty');
        if (empty) empty.remove();

        this.chatMessagesEl.appendChild(wrap);
        this.uiScroll.conditionalScrollToBottom();

        const bodyEl = wrap.querySelector('.grp-live-body');
        const thinkSlot = wrap.querySelector('.grp-think-slot');
        const soulSlot = wrap.querySelector('.grp-soul-slot');
        const typing = wrap.querySelector('.grp-typing');

        // 正文：共享的流式渲染器（与私聊同一套）
        const bodyRenderer = new StreamTextRenderer(bodyEl);

        const thinkPanel = createGrowingPanel(thinkSlot, {
            detailsClass: 'think-details', generatingClass: 'thinking',
            contentClass: 'think-content', titleClass: 'think-title',
            titleText: '🤔 思考过程', indicatorClass: 'think-indicator',
        });
        const soulPanel = createGrowingPanel(soulSlot, {
            detailsClass: 'soul-details', generatingClass: 'soul-generating',
            contentClass: 'soul-content', titleClass: 'soul-title',
            titleText: '💭 内心OS', indicatorClass: 'soul-indicator',
        });

        let contentRaw = '';   // 正文累积（可能含 <soul> 标签）
        let thinkRaw = '';     // 思考累积（来自流式 thinking 块）
        let rafId = null;

        /** 立刻重绘（用与最终渲染同一套规则） */
        const repaint = () => {
            rafId = null;
            const { thinkContent, soulContent, bodyContent } = parseStreamingTags(contentRaw);
            // 思考内容优先取流式 thinking 块；兼容模型把 <think> 写在正文里的情况
            const think = (thinkRaw || '').trim() || thinkContent;
            if (think) thinkPanel.update(think);
            if (soulContent) soulPanel.update(soulContent);
            bodyRenderer.update(bodyContent);
        };

        /** 用 requestAnimationFrame 合并重绘，避免每个 chunk 都触发一次布局 */
        const scheduleRepaint = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(repaint);
        };

        /** 自动跟随（只在用户没有手动上滑时） */
        const autoScroll = () => {
            const el = wrap.closest('.chat-messages');
            if (!el) return;
            const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
            if (nearBottom) el.scrollTop = el.scrollHeight;
        };

        // 点击头像 → 打开该成员的对话设置（与渲染完成后的行为保持一致）
        const liveAvatar = wrap.querySelector('.avatar-msg');
        if (liveAvatar && member.sourceChatId != null && !member.detached) {
            liveAvatar.style.cursor = 'pointer';
            liveAvatar.title = `点击打开「${member.displayName}」的对话设置`;
            liveAvatar.addEventListener('click', (e) => {
                e.stopPropagation();
                this.modalManager.openSettingsModal({ chatId: member.sourceChatId });
            });
        }

        return {
            root: wrap,

            /** 正文增量（内容块） */
            appendContent(chunk) {
                if (typing) typing.remove();
                contentRaw += chunk;
                scheduleRepaint();
                autoScroll();
            },

            /** 思考增量（thinking 块，与正文分开到达） */
            appendThinking(chunk) {
                thinkRaw += chunk;
                scheduleRepaint();
                autoScroll();
            },

            /**
             * 该成员**输出完成** → 立刻定稿这一条消息：
             * 收起思考 / 内心OS 面板、去掉「生成中」呼吸点，
             * 正文压平成与「生成完成后渲染」完全一致的结构。
             */
            finalize() {
                if (typing) typing.remove();
                if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
                repaint();
                thinkPanel.finish();
                soulPanel.finish();
                bodyRenderer.finish();
                autoScroll();
            },
        };
    }

    _cleanupLive(liveBubbles) {
        for (const b of liveBubbles.values()) {
            try { b.root.remove(); } catch { /* ignore */ }
        }
        liveBubbles.clear();
    }

    /** 编排者状态提示（非持久化，不进消息流） */
    _showOrchestratorHint(text) {
        let hint = this.chatMessagesEl.querySelector('.orchestrator-hint');
        if (!hint) {
            hint = document.createElement('div');
            hint.className = 'orchestrator-hint';
            this.chatMessagesEl.appendChild(hint);
        }
        hint.innerHTML = `<span class="dot-pulse"></span>${escapeHtml(text)}`;
        const el = this.chatMessagesEl;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
        if (nearBottom) el.scrollTop = el.scrollHeight;
    }

    _removeOrchestratorHint() {
        this.chatMessagesEl.querySelectorAll('.orchestrator-hint').forEach(n => n.remove());
    }

    // ============================================================
    // 7. @ 点名候选浮层
    // ============================================================

    /** 输入框内容变化时调用（由 script.js 在 input 事件里转接） */
    updateMentionPop() {
        if (!this.isActive()) { this._removeMentionPop(); return; }

        const input = this.messageInputEl;
        if (!input) return;

        const text = input.value;
        const caret = input.selectionStart ?? text.length;
        const before = text.slice(0, caret);
        const at = before.lastIndexOf('@');

        let fragment = null;
        if (at !== -1) {
            const seg = before.slice(at + 1);
            if (!/\s/.test(seg)) fragment = seg;
        }
        if (fragment === null) { this._removeMentionPop(); return; }

        const chat = this.currentChat();
        const members = resolveMembers(chat, this.chats);
        const matches = members.filter(m =>
            String(m.displayName || '').toLowerCase().includes(fragment.toLowerCase()));
        if (!matches.length) { this._removeMentionPop(); return; }

        const pop = this._ensureMentionPop();
        pop.innerHTML = matches.map(m => `
            <button type="button" class="grp-mention-item" data-name="${escapeHtml(m.displayName)}" style="--m-hue:${m.hue}">
                ${m.avatarUrl
                    ? `<img src="${escapeHtml(resolveAssetUrl(m.avatarUrl))}" alt="">`
                    : `<span class="grp-char-avatar">${escapeHtml(String(m.displayName).slice(0, 1))}</span>`}
                <span>${escapeHtml(m.displayName)}</span>
            </button>`).join('');
        pop.hidden = false;
    }

    _ensureMentionPop() {
        if (this._mentionPop && document.body.contains(this._mentionPop)) return this._mentionPop;

        const host = document.querySelector('.chat-input-area') || document.body;
        const pop = document.createElement('div');
        pop.className = 'grp-mention-pop';
        pop.hidden = true;
        pop.addEventListener('mousedown', (e) => {
            const btn = e.target.closest('.grp-mention-item');
            if (!btn) return;
            e.preventDefault();
            this._applyMention(btn.dataset.name);
        });
        host.appendChild(pop);
        this._mentionPop = pop;
        return pop;
    }

    _applyMention(name) {
        const input = this.messageInputEl;
        if (!input) return;
        const text = input.value;
        const caret = input.selectionStart ?? text.length;
        const before = text.slice(0, caret);
        const at = before.lastIndexOf('@');
        if (at === -1) return;
        const after = text.slice(caret);
        input.value = `${before.slice(0, at)}@${name} ${after}`;
        const pos = at + name.length + 2;
        input.setSelectionRange(pos, pos);
        this._removeMentionPop();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
    }

    _removeMentionPop() {
        if (this._mentionPop) this._mentionPop.hidden = true;
    }
}

export default GroupRuntime;
