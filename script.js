// 聊天页面核心交互功能
import { 
    escapeHtml, getCurrentTime, parseThinkContent, renderMessageWithThink, genMsgUid,
    parseParenthesesContent, eventToShortcutString, renderTextWithActions,
} from './js/utils.js';
import Constants from './js/constants.js'
import { ModelService } from './js/model-service.js';
import { ChatRepository } from './js/repository.js';
import { BackendClient } from './js/backend-client.js';
import { SyncedChatRepository } from './js/sync-repository.js';
import { ensureChatIdentity } from './js/chat-diff.js';
import { setAssetBackendClient, resolveAssetUrl, resolveToDataUrl } from './js/asset-sync.js';
import { AuthManager } from './js/auth-manager.js';
import { TTsService } from './js/tts-service.js';
import { ChatIO } from './js/chat-io.js';
import { FileUploadService } from './js/file-upload.js';
import { SettingsManager } from './js/settings-manager.js';
import ModalManager from './js/modal-manager.js';
import { TokenTracker } from './js/token-tracker.js';
import VoiceInput from './js/voice-input.js';
import BackgroundManager from './js/background-manager.js';
import BgMusicManager from './js/bg-music-manager.js';
import AssetStore from './js/asset-store.js';
import SearchManager from './js/search.js';
import MessageActions from './js/message-actions.js';
import ShortcutManager from './js/shortcut-manager.js';
import { ImageGenService } from './js/image-gen.js';
import { UiScroll } from './js/ui-scroll.js';
import { UiAppearance } from './js/ui-appearance.js';
import { ModelConfigUI } from './js/model-config-ui.js';
import { ChatManager } from './js/chat-manager.js';
import { TopicManager } from './js/topic-manager.js';
import { HistoryList } from './js/history-list.js';
import { KnowledgeRetriever } from './js/knowledge-retriever.js';
import { UploadBindings } from './js/upload-bindings.js';
import { MessageSuggest } from './js/message-suggest.js';
import { CharacterCard } from './js/character-card.js';


// ==================== DOM 元素绑定 ====================
const historyList = document.querySelector('.history-list');
const chatMessages = document.querySelector('.chat-messages');
const messageInput = document.querySelector('.auto-expand-textarea');
const sendBtn = document.querySelector('.send-btn');


const DB_NAME = Constants.DB_NAME;
const DB_VERSION = Constants.DB_VERSION;
const STORE_NAME = Constants.STORE_NAME;
const DEFAULT_SHORTCUTS = Constants.DEFAULT_SHORTCUTS
const localChatRepo = new ChatRepository(() => getChatRepoDbName());
const guestChatRepo = new ChatRepository(() => 'ChatAppDB');  // 固定访客库，登录「认领」时读取
const backendClient = new BackendClient({
    getBaseUrl: () => getSyncApiUrl(),
    onUnauthorized: () => authManager.handleUnauthorized(),
});
setAssetBackendClient(backendClient);
const chatRepo = new SyncedChatRepository({
    localRepo: localChatRepo,
    backendClient,
    getIsLoggedIn: () => authManager.isLoggedIn(),
    getNamespace: () => authManager.getNamespace(),
});
const ttsService = new TTsService();
const chatIO = new ChatIO({
    saveAllChats: (chats) => chatRepo.saveAllChats(chats),  // 传递保存函数
});
const fileUpload = new FileUploadService({
    previewArea: document.getElementById('file-preview-area'),
    fileNameSpan: document.getElementById('file-name'),
    imagePreviewArea: document.getElementById('image-preview-area'),
    alertFn: (msg, type) => modalManager.customAlert(msg, type)
});

let chats = [];
let currentChatId = null;
const cropperRef = { value: null };
const modelServiceInstanceRef = { value: null };

// (话题辅助函数已迁移至 js/topic-manager.js —— TopicManager)

// ==================== 快捷键管理器 ====================
// 注意：先于 modalManager 构造，因为 modalManager 依赖 shortcutManager。
// customAlert 在 modalManager 创建后注入。
const shortcutManager = new ShortcutManager({
    defaultShortcuts: DEFAULT_SHORTCUTS,
    getStoredShortcuts: () => SettingsManager.getShortcuts(),
    saveShortcuts: (shortcuts) => SettingsManager.update({ shortcuts }),
    actionCallbacks: {
        'new-chat':          () => chatManager.createNewChat(),
        'new-topic':         () => topicManager.startNewTopic(),
        'prev-chat':         () => chatManager.switchToPreviousChat(),
        'next-chat':         () => chatManager.switchToNextChat(),
        'export-json':       () => chatIO.exportAsJSON(chats.find(c => c.id == currentChatId)),
        'focus-input':       () => focusChatInput(),
        'send-no-ai':        () => sendMessageWithoutAI(),
        'focus-search':      () => searchManager.focusSearchInput(),
        'toggle-immersive':  () => toggleImmersiveMode(),
    },
});

// ==================== UI 控制器（滚动 / 请求锁 / 外观 / 模型配置） ====================
// 注意：modelConfigUI 通过 getModalManager 惰性引用 modalManager，避免构造期循环依赖（运行时才调用）。
const uiScroll = new UiScroll({ chatMessagesEl: chatMessages, sendBtnEl: sendBtn });
const uiAppearance = new UiAppearance({ chatMessagesEl: chatMessages });
const modelConfigUI = new ModelConfigUI({ getModalManager: () => modalManager });

// ==================== 业务控制器（对话 / 话题 / 历史列表 / 知识库检索） ====================
// 相互引用均通过回调惰性解析(chatManager ↔ historyList ↔ topicManager)，避免循环依赖。
const chatManager = new ChatManager({
    getChats: () => chats,
    getCurrentChatId: () => currentChatId,
    setCurrentChatId,
    chatRepo,
    ttsService,
    getModelService,
    uiScroll,
    uiAppearance,
    renderHistoryList: () => historyListUI.renderHistoryList(),
    renderMessages,
    applyCurrentChatSettings,
    setCurrentTopicIndex: (v) => topicManager.setCurrentTopicIndex(v),
    getCurrentTopicIndex: () => topicManager.getCurrentTopicIndex(),
    closeSidebarOnMobile,
    getModalManager: () => modalManager,
});
const topicManager = new TopicManager({
    getChats: () => chats,
    getCurrentChatId: () => currentChatId,
    chatMessagesEl: chatMessages,
    chatRepo,
    ttsService,
    getModelService,
    uiScroll,
    uiAppearance,
    renderHistoryList: () => historyListUI.renderHistoryList(),
    renderMessages,
    getModalManager: () => modalManager,
});
const historyListUI = new HistoryList({
    getChats: () => chats,
    getCurrentChatId: () => currentChatId,
    historyListEl: historyList,
    chatIO,
    getChatManager: () => chatManager,
    closeSidebarOnMobile,
});
const knowledgeRetriever = new KnowledgeRetriever({ getModalManager: () => modalManager });

// ==================== 上传与媒体预览绑定 ====================
const uploadBindings = new UploadBindings({ fileUpload, getModalManager: () => modalManager });

// ==================== 消息建议 ====================
const suggestManager = new MessageSuggest({
    messageInputEl: messageInput,
    suggestBtnEl: document.getElementById('suggest-btn'),
    modalEl: document.getElementById('suggest-modal'),
    getModalManager: () => modalManager,
    getModelService,
    getChats: () => chats,
    getCurrentChatId: () => currentChatId,
    getCurrentTopicIndex: () => topicManager.getCurrentTopicIndex(),
    getSettingsManager: () => SettingsManager,
    getIsProcessing: () => uiScroll.isProcessing,
    sendUserMessage,
});

// ==================== 弹窗管理器 ====================
// 注意：ctx 中的回调函数（renderMessages 等）由 function 声明定义在下方，JS 会提升声明，因此引用安全。
const modalManager = new ModalManager({
    get chats() { return chats; },            // getter：initData 会重新赋值 chats，必须动态读取
    get currentChatId() { return currentChatId; },
    get currentTopicIndex() { return topicManager.getCurrentTopicIndex(); },
    chatRepo,
    chatIO,
    ttsService,
    modelServiceInstanceRef,
    cropperRef,
    getShortcuts: () => shortcutManager.getShortcuts(),
    getModelService,
    releaseRequestLock: () => uiScroll.releaseRequestLock(),
    updateStatusIndicator: (state, customText) => uiAppearance.updateStatusIndicator(state, customText),
    // 以下回调函数由下方 function 声明定义（JS 提升），在构造时引用安全：
    renderMessages: (chatId, topicIdx) => renderMessages(chatId, topicIdx),
    renderHistoryList: () => historyListUI.renderHistoryList(),
    applyCurrentChatSettings: () => applyCurrentChatSettings(),
    startNewTopic: () => topicManager.startNewTopic(),
    setCurrentTopic: (idx) => topicManager.setCurrentTopic(idx),
    applyTheme: (theme) => uiAppearance.applyTheme(theme),
    applyFontSize: (size) => uiAppearance.applyFontSize(size),
    renderShortcutsPanel: () => shortcutManager.renderPanel(),
    bindAutoResize: (el) => bindAutoResize(el),
    updateModelSelector: () => modelConfigUI.updateModelSelector(),
    renderModelListUI: () => modelConfigUI.renderModelListUI(),
    saveModelListToStorage: () => modelConfigUI.saveModelListToStorage(),
    addModel: (name) => modelConfigUI.addModel(name),
    generateTopicSummary: (idx, msgs) => topicManager.generateTopicSummary(idx, msgs),
    focusChatInput: () => focusChatInput(),
    focusSearchInput: () => searchManager.focusSearchInput(),
    createNewChat: () => chatManager.createNewChat(),
    createNewChatWithSettings: (settings) => chatManager.createNewChatWithSettings(settings),
    switchToPreviousChat: () => chatManager.switchToPreviousChat(),
    switchToNextChat: () => chatManager.switchToNextChat(),
    sendMessageWithoutAI: () => sendMessageWithoutAI(),
    toggleImmersiveMode: () => toggleImmersiveMode(),
    executeAction: (action) => shortcutManager.executeAction(action),
});

// ==================== 账号 / 云同步 ====================
const authManager = new AuthManager({
    backendClient,
    getModalManager: () => modalManager,
    onAuthChanged: () => refreshAfterAuth(),
});

// 注入 customAlert（modalManager 创建后才能引用）
shortcutManager._customAlert = (msg, type) => modalManager.customAlert(msg, type);
ttsService.setOnFallback((msg) => modalManager.showBriefToast(msg));

// ==================== 语音输入 ====================
const voiceInput = new VoiceInput({ customAlert: (msg, type) => modalManager.customAlert(msg, type) });
function startVoiceInput() { voiceInput.start(); }

// ==================== 搜索管理器 ====================
const searchManager = new SearchManager({
    getChats: () => chats,
    getCurrentChatId: () => currentChatId,
    getCurrentTopicIndex: () => topicManager.getCurrentTopicIndex(),
    setCurrentTopicIndex: (v) => topicManager.setCurrentTopicIndex(v),
    switchChat: (chatId) => chatManager.switchChat(chatId),
    renderMessages: (chatId, topicIdx) => renderMessages(chatId, topicIdx),
});

// ==================== 消息操作菜单 ====================
const msgActions = new MessageActions({
    getChats: () => chats,
    getCurrentChatId: () => currentChatId,
    getCurrentTopicIndex: () => topicManager.getCurrentTopicIndex(),
    isProcessing: () => uiScroll.isProcessing,
    chatRepo,
    ttsService,
    chatMessages,
    renderMessages: (chatId, topicIdx) => renderMessages(chatId, topicIdx),
    renderHistoryList: () => historyListUI.renderHistoryList(),
    customAlert: (msg, type) => modalManager.customAlert(msg, type),
    showBriefToast: (msg) => modalManager.showBriefToast(msg),
    simulateAIResponse,
    appendMessageToDOM,
    updateStatusIndicator: (state, customText) => uiAppearance.updateStatusIndicator(state, customText),
});
function showMessageActions(...args) { msgActions.showMessageActions(...args); }
function showPictureActions(...args) { msgActions.showPictureActions(...args); }

const imageGenService = new ImageGenService({
    isProcessing: () => uiScroll.isProcessing,
    customAlert: (msg, type) => modalManager.customAlert(msg, type),
    getImgApiUrl: () => SettingsManager.getImgApiUrl(),
    getImgApiKey: () => SettingsManager.getImgApiKey(),
    appendMessageToDOM,
    appendImageToDOM,
    forceScrollToBottom: () => uiScroll.forceScrollToBottom(),
    getAutoScrollAfterSend: () => SettingsManager.getAutoScrollAfterSend(),
});

function getModelService() {
    if (!modelServiceInstanceRef.value) {
        modelServiceInstanceRef.value = new ModelService({
            modelHost: SettingsManager.getModelHost(),
            apiKey: SettingsManager.getApiKey(),
            modelName: SettingsManager.getModelName(),
        });
        // 注册 Token 用量回调（仅首次创建时）
        ModelService.setUsageCallback((promptTokens, completionTokens) => {
            TokenTracker.record(promptTokens, completionTokens);
        });
    }
    return modelServiceInstanceRef.value;
}

function setCurrentChatId(id) { 
    currentChatId = id;
    localStorage.setItem(Constants.STORAGE_KEYS.LAST_CHAT_ID, id);
}

// 后端地址：可被 localStorage 覆盖；默认取当前访问地址同机 8001 端口（局域网其它设备也能用）
function getSyncApiUrl() {
    const override = localStorage.getItem(Constants.STORAGE_KEYS.SYNC_API_URL);
    if (override) return override;
    return `http://${location.hostname}:8001`;
}

// 本地 IndexedDB 库名（按账号命名空间分库）
function getChatRepoDbName() {
    const ns = authManager.getNamespace();
    return ns ? `ChatAppDB_${ns}` : 'ChatAppDB';
}

// 切换本地缓存命名空间（IndexedDB 库 + 设置键）
function applyNamespace() {
    const ns = authManager.getNamespace();
    localChatRepo.switchNamespace();
    SettingsManager.setNamespace(ns);
}

// 首次登录「认领」：仅认领一次（全局标记）。首次登录把访客本地数据迁移到该账号，
// 之后的新账号不再认领、从空开始；访客数据保留不删（登出仍可见）。
async function claimGuestData() {
    if (!authManager.isLoggedIn()) return;
    try {
        if (localStorage.getItem(Constants.STORAGE_KEYS.GUEST_CLAIMED) === '1') return;  // 已认领过
        const { chats: serverChats } = await backendClient.getChats();
        const guestChats = await guestChatRepo.loadAllChats();  // 固定读访客库
        const guestSettings = SettingsManager.getSyncableSettings();  // 此刻仍是访客命名空间
        const { settings } = await backendClient.getSettings();

        if ((!serverChats || serverChats.length === 0) && guestChats && guestChats.length > 0) {
            await backendClient.putChats(guestChats);
        }
        if (!settings || Object.keys(settings).length === 0) {
            await backendClient.putSettings(guestSettings);
        }
        localStorage.setItem(Constants.STORAGE_KEYS.GUEST_CLAIMED, '1');
    } catch (e) { /* 离线：不标记，下次登录再试 */ }
}

// (请求锁与滚动控制已迁移至 js/ui-scroll.js —— UiScroll)

// (模型配置 UI 已迁移至 js/model-config-ui.js —— ModelConfigUI)
// 左侧边栏拖动调整宽度
// 左侧边栏拖动调整宽度
function initResizer() {
    if (window.innerWidth <= Constants.MOBILE_BREAKPOINT) return; // 移动端不启用拖动
    const resizer = document.querySelector('.resizer');
    const sidebar = document.querySelector('.sidebar');
    if (!resizer || !sidebar) return;

    let startX, startWidth;
    let isDragging = false;

    // 从 localStorage 恢复宽度
    const savedWidth = localStorage.getItem(Constants.STORAGE_KEYS.SIDEBAR_WIDTH);
    if (savedWidth && !isNaN(parseInt(savedWidth))) {
        sidebar.style.width = `${savedWidth}px`;
    }

    function onMouseMove(e) {
        if (!isDragging) return;
        e.preventDefault();   // 阻止默认行为（重要）
        let newWidth = startWidth + (e.clientX - startX);
        newWidth = Math.min(Constants.SIDEBAR_MAX_WIDTH, Math.max(Constants.SIDEBAR_MIN_WIDTH, newWidth));
        sidebar.style.width = `${newWidth}px`;
        localStorage.setItem(Constants.STORAGE_KEYS.SIDEBAR_WIDTH, newWidth);
    }

    function onMouseUp() {
        if (!isDragging) return;
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        resizer.classList.remove('active');
        document.body.classList.remove('dragging');
    }

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();   // 关键：阻止文字选中
        e.stopPropagation();
        isDragging = true;
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        resizer.classList.add('active');
        document.body.classList.add('dragging');
    });
}

// 从 IndexedDB 加载
async function loadFromStorage() {
    try {
        const storedChats = await chatRepo.loadAllChats();
        if (storedChats && storedChats.length > 0) {
            // 恢复日期对象（JSON 序列化会丢失 Date 类型）+ 补齐话题/消息身份标识
            return storedChats.map(chat => ensureChatIdentity({
                ...chat,
                date: new Date(chat.date),
                topics: (chat.topics || []).map(topic => ({
                    ...topic,
                    messages: (topic.messages || []).map(msg => ({ ...msg }))
                })),
                settings: { ...Constants.DEFAULT_SETTINGS, ...(chat.settings || {}) }
            }));
        }
        return null;
    } catch (err) {
        console.error('加载失败', err);
        return null;
    }
}

// 应用当前对话的设置到界面（背景、右上角名称、全局头像变量）
function applyCurrentChatSettings() {
    const chat = chats.find(c => c.id == currentChatId);
    if (!chat) return;
    const settings = chat.settings || Constants.DEFAULT_SETTINGS;
    BackgroundManager.apply({
        chatId: chat.id,
        bgType: settings.bgType || null,
        bgImageUrl: settings.bgImageUrl || null,
        bgVideoUrl: settings.bgVideoUrl || '',
        bgVideoMode: settings.bgVideoMode || 'url',
    });
    BgMusicManager.apply({
        chatId: chat.id,
        bgMusicEnabled: settings.bgMusicEnabled || false,
        bgMusicUrl: settings.bgMusicUrl || '',
        bgMusicMode: settings.bgMusicMode || 'url',
        bgMusicName: settings.bgMusicName || '',
        bgMusicVolume: settings.bgMusicVolume ?? 0.5,
    });
}

// (历史列表渲染已迁移至 js/history-list.js —— HistoryList)

// 追加消息到DOM
async function appendMessageToDOM(type, text, time, saveToStorageFlag = false, chatIdForSave = null, customAvatarUrl = null, fileAttachment = null, modelName = null, msgUid = null, quoteRef = null, knowledgeSources = null, imageAttachments = null, thinkSeconds = null) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;
    if (msgUid) messageDiv.dataset.msgUid = msgUid;
    let avatarHtml = '';

    if (type === 'ai') {
        // AI 头像：优先使用传入的头像，否则从当前对话设置中获取
        let avatarUrl = customAvatarUrl;
        if (!avatarUrl && currentChatId) {
            const currentChat = chats.find(c => c.id == currentChatId);
            if (currentChat && currentChat.settings) {
                avatarUrl = currentChat.settings.avatarUrl;
            }
        }
        if (avatarUrl) {
            avatarHtml = `<img src="${resolveAssetUrl(avatarUrl)}" style="width:50px; height:50px; border-radius:50%; object-fit:cover;">`;
        } else {
            avatarHtml = '<i class="fas fa-robot"></i>';
        }
    } else {
        // 用户头像：从全局设置中获取
        const userAvatar = SettingsManager.getAvatar();
        if (userAvatar && userAvatar.startsWith('data:image')) {
            avatarHtml = `<img src="${userAvatar}" style="width:50px; height:50px; border-radius:50%; object-fit:cover;">`;
        } else {
            avatarHtml = '<i class="fas fa-user-astronaut"></i>';
        }
    }
    
    // 消息气泡内容
    let bubbleContent = '';
    if (type === 'ai') {
        bubbleContent = renderMessageWithThink(text, true, thinkSeconds);
    } else {
        // 用户消息：括号内容同样做斜体处理
        bubbleContent = renderTextWithActions(text);
    }
    // 引用消息块（在文本前显示）
    if (quoteRef) {
        const quotedRole = escapeHtml(quoteRef.role || '');
        const quotedText = escapeHtml(quoteRef.text || '');
        const truncatedText = quotedText.length > 60 ? quotedText.substring(0, 60) + '...' : quotedText;
        bubbleContent = `<div class="quoted-msg-ref" data-quote-msg-uid="${escapeHtml(quoteRef.msgUid || '')}">
            <div class="quoted-msg-ref-role"><i class="fas fa-quote-right"></i> ${quotedRole}</div>
            <div class="quoted-msg-ref-text">${truncatedText}</div>
        </div>` + bubbleContent;
    }
    if (type === 'user' && imageAttachments && imageAttachments.length > 0) {
        bubbleContent += '<div class="message-images">';
        for (const img of imageAttachments) {
            const thumbSrc = resolveAssetUrl(img.dataUrl);                        // 缩略图（旧格式兼容：即为完整图）
            const fullSrc = resolveAssetUrl(img.fullDataUrl || img.dataUrl);      // 完整图用于点击放大
            bubbleContent += `<img src="${thumbSrc}" class="message-image" data-full-img="${fullSrc}" alt="${escapeHtml(img.name || '图片')}" title="${escapeHtml(img.name || '图片')}">`;
        }
        bubbleContent += '</div>';
    }
    if (type === 'user' && fileAttachment) {
        // 添加可点击的文件链接
        bubbleContent += `<div class="file-attachment" data-filename="${escapeHtml(fileAttachment.name)}" data-content="${escapeHtml(fileAttachment.content)}">
            <i class="fas fa-paperclip"></i> ${escapeHtml(fileAttachment.name)}
        </div>`;
    }
    let displayTime = time || getCurrentTime();
    let timeHtml = `<div class="msg-time">`;
    if (type === 'ai' && modelName) {
        timeHtml += `<span style="margin-right: 8px; font-size: 0.65rem; opacity: 0.7;">🤖 ${escapeHtml(modelName)}</span>`;
    }
    timeHtml += `${escapeHtml(displayTime)}</div>`;
    bubbleContent += timeHtml;

    // ---- 知识库引用标志 ----
    if (type === 'ai' && knowledgeSources && knowledgeSources.length > 0) {
        const sourcesHtml = knowledgeSources.map(src =>
            `<span class="kb-source-tag" title="相似度: ${src.score}">
                <i class="fas fa-database"></i> ${escapeHtml(src.filename)}
            </span>`
        ).join('');
        bubbleContent += `<div class="kb-sources">${sourcesHtml}</div>`;
    }
    messageDiv.innerHTML = `
        <div class="avatar-msg">${avatarHtml}</div>
        <div class="bubble">${bubbleContent}</div>
    `;
    
    const aiAvatar = messageDiv.querySelector('.avatar-msg');
    if (type === 'ai' && aiAvatar) {
        aiAvatar.style.cursor = 'pointer';
        aiAvatar.addEventListener('click', (e) => {
            e.stopPropagation();
            modalManager.openSettingsModal();   // 复用已有的打开对话设置函数
        });
    }

    // 添加点击气泡显示操作栏
    const bubble = messageDiv.querySelector('.bubble');
    if (bubble) {
        bubble.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            showMessageActions(messageDiv, type, text, displayTime, saveToStorageFlag, chatIdForSave, customAvatarUrl, fileAttachment, imageAttachments);
        });
    }

    // 绑定引用块点击事件
    if (quoteRef && quoteRef.msgUid) {
        const quoteRefEl = messageDiv.querySelector('.quoted-msg-ref');
        if (quoteRefEl) {
            quoteRefEl.addEventListener('click', (e) => {
                e.stopPropagation();
                msgActions.scrollToQuotedMessage(quoteRef.msgUid);
            });
        }
    }

    chatMessages.appendChild(messageDiv);
    uiScroll.conditionalScrollToBottom();
    
    // 绑定文件点击事件
    if (type === 'user' && fileAttachment) {
        const fileElem = messageDiv.querySelector('.file-attachment');
        if (fileElem) {
            fileElem.addEventListener('click', () => {
                modalManager.showFileContentModal(fileAttachment.name, fileAttachment.content);
            });
        }
    }
    if (saveToStorageFlag) {
        const targetChatId = chatIdForSave || currentChatId;
        const targetChat = chats.find(c => c.id == targetChatId);
        if (targetChat) {
            const activeTopic = topicManager.getActiveTopic(targetChat);
            if (activeTopic) {
                const msgUid = genMsgUid(type, text, time || getCurrentTime());
                activeTopic.messages.push({ type, text, time: time || getCurrentTime(), uid: msgUid });
                if (messageDiv) messageDiv.dataset.msgUid = msgUid;
                if (type === 'user') {
                    targetChat.date = new Date();
                    historyListUI.renderHistoryList();
                    await chatRepo.saveChat(targetChat);
                }
            }
        }
    }
}

// 向聊天区追加一张图片（支持 base64 或 URL）
async function appendImageToDOM(type, imgSrc, time, saveToStorageFlag = false) {
    const displaySrc = resolveAssetUrl(imgSrc);
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;

    // 头像
    let avatarHtml = '<i class="fas fa-robot"></i>';
    if (type === 'ai') {
        const currentChat = chats.find(c => c.id == currentChatId);
        const avatarUrl = currentChat?.settings?.avatarUrl;
        avatarHtml = avatarUrl ? `<img src="${resolveAssetUrl(avatarUrl)}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;">` 
                            : '<i class="fas fa-robot"></i>';
    } else {
        const userAvatar = SettingsManager.getAvatar();
        avatarHtml = (userAvatar && userAvatar.startsWith('data:image'))
            ? `<img src="${userAvatar}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;">`
            : '<i class="fas fa-user-astronaut"></i>';
    }

    // 气泡：图片 + 时间
    const imgTag = `<img src="${displaySrc}" class="message-image" alt="生成图片">`;
    const timeHtml = `<div class="msg-time">${escapeHtml(time || getCurrentTime())}</div>`;
    messageDiv.innerHTML = `
        <div class="avatar-msg">${avatarHtml}</div>
        <div class="bubble">
            ${imgTag}
            ${timeHtml}
        </div>
    `;

    const imgElement = messageDiv.querySelector('.message-image');
    const bubble = messageDiv.querySelector('.bubble');

    // 单击放大
    if (imgElement) {
        imgElement.addEventListener('click', (e) => {
            e.stopPropagation();
            modalManager.showFullscreenImage(displaySrc);
        });
    }

    // 双击操作栏（保存、删除）
    if (bubble) {
        bubble.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const msgData = {
                type,
                isImage: true,
                src: imgSrc,
                time: time || getCurrentTime(),
            };
            showPictureActions(messageDiv, msgData);
        });
    }

    chatMessages.appendChild(messageDiv);
    uiScroll.conditionalScrollToBottom();

    // 持久化（消息对象里附带 isImage 和生成参数）
    if (saveToStorageFlag) {
        const targetChat = chats.find(c => c.id == currentChatId);
        if (targetChat) {
            const activeTopic = topicManager.getActiveTopic(targetChat);
            if (activeTopic) {
                const msgUid = genMsgUid(type, imgSrc, time || getCurrentTime());
                activeTopic.messages.push({
                    type,
                    text: imgSrc,
                    isImage: true,
                    time: time || getCurrentTime(),
                    uid: msgUid,
                });
                targetChat.date = new Date();
                historyListUI.renderHistoryList();
            }
            await chatRepo.saveChat(targetChat);
        }
    }
}

function renderMessages(chatId, topicIndex = null) {
    const chat = chats.find(c => c.id == chatId);
    if (!chat || !chatMessages) return;
    // 清理残留的动画状态（setCurrentTopic 的定时器可能尚未触发）
    chatMessages.classList.remove('no-entry-animation');
    chatMessages.innerHTML = '';
    const currentAvatarUrl = chat.settings?.avatarUrl || null;
    const topics = chat.topics || [];

    if (topicIndex !== null && topics[topicIndex]) {
        // 单个话题视图：仅渲染该话题的消息
        const topicMessages = topics[topicIndex].messages;
        topicMessages.forEach(msg => {
            if (msg.isImage) {
                appendImageToDOM(msg.type, msg.text, msg.time, false, null);
            } else {
                const fileAttachment = msg.file || null;
                const imageAttachments = msg.images || null;
                appendMessageToDOM(msg.type, msg.text, msg.time, false, null, currentAvatarUrl, fileAttachment, msg.modelName || null, msg.uid, msg.quoteRef || null, msg.knowledgeSources || null, imageAttachments, msg.thinkSeconds ?? null);
            }
        });
        if (topicMessages.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'topic-empty';
            emptyDiv.innerHTML = '<div style="text-align:center; padding:20px; color:#8e8eb3;">该话题暂无消息</div>';
            chatMessages.appendChild(emptyDiv);
        }
    } else {
        // 显示所有话题：话题间插入合成分隔线
        for (let i = 0; i < topics.length; i++) {
            if (i > 0) {
                const divider = document.createElement('div');
                divider.className = 'topic-divider';
                divider.innerHTML = `<i class="fas fa-asterisk"></i> ${escapeHtml(topics[i].name)} <i class="fas fa-asterisk"></i>`;
                chatMessages.appendChild(divider);
            }
            topics[i].messages.forEach(msg => {
                if (msg.isImage) {
                    appendImageToDOM(msg.type, msg.text, msg.time, false, null);
                } else {
                    const fileAttachment = msg.file || null;
                    const imageAttachments = msg.images || null;
                    appendMessageToDOM(msg.type, msg.text, msg.time, false, null, currentAvatarUrl, fileAttachment, msg.modelName || null, msg.uid, msg.quoteRef || null, msg.knowledgeSources || null, imageAttachments, msg.thinkSeconds ?? null);
                }
            });
        }
    }

    uiScroll.conditionalScrollToBottom();
}

function getTypingSpeed() {
    const slider = document.getElementById('global-typing-speed');
    return slider ? parseFloat(slider.value) || 1 : 1;
}

async function simulateAIResponse(userMsg, imageUrls = []) {
    // 🔒 请求开始：集中管理请求生命周期
    if (!uiScroll.acquireRequestLock()) {
        console.warn('已有请求正在处理，丢弃本次调用');
        return;
    }
    const currentChat = chats.find(c => c.id == currentChatId);
    if (!currentChat) {
        appendMessageToDOM('ai', '系统错误：无法找到当前对话。', getCurrentTime(), true);
        // 发生错误，释放锁
        uiScroll.releaseRequestLock();
        return;
    }
    uiAppearance.updateStatusIndicator('thinking', '模型思考中 ...');
    const settings = currentChat.settings || Constants.DEFAULT_SETTINGS;
    const roleName = settings.roleName || Constants.DEFAULT_ROLE_NAME;
    const rolePersona = settings.persona || '';

    // 显示正在输入指示器
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message ai';
    typingDiv.innerHTML = `<div class="avatar-msg"><i class="fas fa-robot"></i></div><div class="bubble typing-bubble"><div class="typing-indicator"><i class="fas fa-ellipsis-h"></i> ${roleName} 正在思考...</div></div>`;
    chatMessages.appendChild(typingDiv);
    if (SettingsManager.getAutoScrollAfterSend()) uiScroll.scrollToBottom();
    // 思考计时器句柄：必须在 try 外声明（finally 清理时需要访问）
    let thinkTickTimer = null;

    try {
        // 获取对话历史（支持话题视图）
        let historyMessages = [];
        const topicIdx = topicManager.getCurrentTopicIndex();
        if (topicIdx !== null && currentChat.topics[topicIdx]) {
            historyMessages = currentChat.topics[topicIdx].messages;
        } else {
            // "显示全部"模式：拍平所有话题的消息
            for (const topic of (currentChat.topics || [])) {
                historyMessages = historyMessages.concat(topic.messages);
            }
        }
        let messagesToUse = historyMessages;
        const contextLimit = currentChat.settings?.contextLimit ?? 10;
        if (contextLimit !== -1 && messagesToUse.length > contextLimit) {
            messagesToUse = messagesToUse.slice(-contextLimit);
        }

        // 构建 API 消息列表
        const messages = [];
        // 用户画像：优先使用当前对话设置中的用户画像，留空则回退全局「对话设定」
        // 系统提示中的用户名默认值与设置面板不同：系统提示用 '用户'，设置面板用 '访客'，保持原行为
        const chatProfileName = (settings.userProfileName || '').trim();
        const chatProfileBio = (settings.userProfileBio || '').trim();
        const globalUserName = SettingsManager.getUsername();
        const globalUserBio = SettingsManager.getBio();
        const userName = chatProfileName || (globalUserName === Constants.DEFAULT_USERNAME ? '用户' : globalUserName);
        const userBio = chatProfileBio || globalUserBio || '';

        let systemPrompt = `你是一位角色扮演者，你的姓名是“ ${roleName} ”。关于你的角色简介是：\n\n${rolePersona ? rolePersona : ''}\n\n总之你需要始终以“ ${roleName} ”的身份和口吻回应\n\n`;
        if (userBio) systemPrompt += `关于和你对话的当前用户的名称是：${userName}，简介：${userBio}`;
        else systemPrompt += `关于和你对话的当前用户名称叫：${userName}。`;
        systemPrompt += '\n\n重要：请严格根据上述角色设定进行角色扮演，不要打破角色，不要以助手或AI的身份回答。必须始终以角色的身份和语气回复。\n\n回复格式规则：你的回复可以包含人物动作、环境描写、情绪描述等非语言表达内容，当你的回复中包含这样的的内容时，请使用括号（）将这些内容包裹起来。例如：“（轻轻叹气）我相信你能做到”。或“（窗外的雨声淅沥）今天的任务完成得不错。”';
        // 角色卡附加字段(SillyTavern 角色卡导入):system_prompt 与示例对话
        if (settings.cardSystemPrompt) systemPrompt += `\n\n【附加系统设定】\n${settings.cardSystemPrompt}`;
        if (settings.cardExampleMessages) systemPrompt += `\n\n【角色对话示例(用于模仿语气与风格)】\n${settings.cardExampleMessages.replace(/\{\{char\}\}/g, roleName).replace(/\{\{user\}\}/g, userName)}`;
        messages.push({ role: 'system', content: systemPrompt });
        let lastUserMsgContent = '';
        for (const msg of messagesToUse) {
            const role = msg.type === 'user' ? 'user' : 'assistant';
            const content = (role === 'user' && msg.modelInputText) ? msg.modelInputText : (msg.text || '');
            if (!content) continue; // 跳过空消息，避免 API 报错
            messages.push({ role, content });
            if (role === 'user') lastUserMsgContent = content;
        }
        if (lastUserMsgContent !== userMsg) {
            messages.push({ role: 'user', content: userMsg });
        }

        let finalUserMsg = null;
        let knowledgeSources = null;

        const selectedIdsStr = localStorage.getItem(Constants.STORAGE_KEYS.SELECTED_KB_IDS) || '';
        if (selectedIdsStr.trim() !== '') {
            const kbIds = selectedIdsStr.split(',').filter(id => id.trim());
            if (kbIds.length > 0) {
                try {
                    const kbResults = await knowledgeRetriever.retrieveKnowledge(kbIds, userMsg);
                    const relevant = kbResults.filter(item => (item.score || 0) >= Constants.SIMILARITY_THRESHOLD);
                    if (relevant && relevant.length > 0) {
                        const knowledgeText = relevant.map((item, idx) => 
                            `[知识片段 ${idx+1}] 来源：${item.filename || '知识库'}\n${item.content}`
                        ).join('\n\n');
                        finalUserMsg = `【知识库参考信息】\n以下是知识库中与当前问题相关的参考信息，仅供你在需要事实细节时参考。但请你记住：如果参考资料中没有任何与用户消息有关的内容，则请你忽略以下所有资料信息，否则必须以当前的角色人设风格进行回答。\n\n${knowledgeText}\n`;
                        // 保存知识库引用信息
                        knowledgeSources = relevant.map(item => ({
                            filename: item.filename || '知识库',
                            score: Math.round((item.score || 0) * 100) + '%'
                        }));
                    } else {
                        console.log('知识库检索结果分数过低，已过滤');
                    }
                } catch (err) {
                    console.warn('知识库检索失败:', err);
                }
            }
        }

        // 如果有知识库上下文，作为独立消息追加
        if (finalUserMsg) {
            messages.push({ role: 'user', content: finalUserMsg });
        }
        // 创建模型服务实例（使用当前全局设置）
        const modelService = getModelService();
        // 确保配置最新（在调用前更新配置）
        modelService.updateConfig({
            modelHost: SettingsManager.getModelHost(),
            apiKey: SettingsManager.getApiKey(),
            modelName: SettingsManager.getModelName(),
        });

        // 准备请求选项
        const requestOptions = {
            temperature: currentChat.settings?.temperature ?? Constants.DEFAULT_SETTINGS.temperature,
            topP: currentChat.settings?.topP ?? Constants.DEFAULT_SETTINGS.topP,
            maxTokens: currentChat.settings?.maxTokens ?? Constants.DEFAULT_SETTINGS.maxTokens,
            thinkLevel: currentChat.settings?.thinkLevel ?? Constants.DEFAULT_SETTINGS.thinkLevel,
            images: imageUrls,
        };

        // 获取生成器
        const generator = modelService.streamChat(messages, requestOptions);

        let fullReply = '';
        let isFirstChunk = true;
        let messageDiv = null;
        let bubble = null;
        let contentP = null;         // 正文流式容器 <p>
        let replyRaw = '';           // 正文原始文本（流式累积，生成完成后统一斜体化）
        let thinkDetails = null;     // 思考面板 <details>
        let thinkContentEl = null;   // 思考内容 <div>
        let thinkTimerEl = null;     // 思考用时 <span>
        let thinkIndicatorEl = null; // 思考中呼吸指示点 <span>
        let thinkStartTime = null;   // 思考开始时间（performance.now）
        let thinkEndTime = null;     // 思考结束时间
        let thinkClosed = false;     // 思考阶段是否已结束（收到正文 / 流结束）

        // 更新思考计时显示（思考中实时跳动）
        const updateThinkTimer = () => {
            if (!thinkTimerEl || thinkStartTime == null) return;
            const end = thinkEndTime ?? performance.now();
            thinkTimerEl.textContent = ` · ${((end - thinkStartTime) / 1000).toFixed(1)}s`;
        };
        // 结束思考阶段：停止计时、定格用时、自动折叠面板
        const finalizeThink = () => {
            if (thinkTickTimer) { clearInterval(thinkTickTimer); thinkTickTimer = null; }
            if (!thinkDetails || thinkClosed) return;
            thinkClosed = true;
            thinkEndTime = performance.now();
            updateThinkTimer();
            if (thinkIndicatorEl) { thinkIndicatorEl.remove(); thinkIndicatorEl = null; }
            thinkDetails.classList.remove('thinking');
            thinkDetails.open = false;  // 思考输出完成后自动折叠
        };

        for await (const chunk of generator) {
            if (isFirstChunk) {
                // 第一次收到数据时，移除指示器并创建消息气泡
                if (typingDiv.parentNode) typingDiv.remove();
                const modelNameForDisplay = SettingsManager.getModelName();
                messageDiv = createMessageBubble('ai', '', getCurrentTime(), currentChat.settings?.avatarUrl, modelNameForDisplay, knowledgeSources);
                bubble = messageDiv.querySelector('.bubble');
                // 移除空占位 <p>，改用流式正文容器（保留 msg-time 与 kb-sources）
                const placeholderP = bubble.querySelector('p');
                if (placeholderP) placeholderP.remove();
                contentP = document.createElement('p');
                contentP.style.whiteSpace = 'pre-wrap';
                bubble.insertBefore(contentP, bubble.querySelector('.msg-time') || null);
                chatMessages.appendChild(messageDiv);
                if (SettingsManager.getAutoScrollAfterSend()) uiScroll.scrollToBottom();
                isFirstChunk = false;
            }

            if (chunk.type === 'thinking') {
                // ---- 思考内容：实时渲染到思考面板，用户可随时折叠/展开 ----
                if (!thinkDetails) {
                    fullReply += '<think>';
                    thinkStartTime = performance.now();
                    thinkDetails = document.createElement('details');
                    thinkDetails.className = 'think-details thinking';
                    thinkDetails.open = true;   // 思考过程中默认展开
                    const summary = document.createElement('summary');
                    const titleSpan = document.createElement('span');
                    titleSpan.className = 'think-title';
                    titleSpan.textContent = '🤔 思考过程';
                    thinkIndicatorEl = document.createElement('span');
                    thinkIndicatorEl.className = 'think-indicator';
                    thinkTimerEl = document.createElement('span');
                    thinkTimerEl.className = 'think-timer';
                    summary.appendChild(titleSpan);
                    summary.appendChild(thinkIndicatorEl);
                    summary.appendChild(thinkTimerEl);
                    thinkDetails.appendChild(summary);
                    thinkContentEl = document.createElement('div');
                    thinkContentEl.className = 'think-content';
                    thinkDetails.appendChild(thinkContentEl);
                    bubble.insertBefore(thinkDetails, contentP);
                    // 思考期间每 100ms 刷新一次用时
                    thinkTickTimer = setInterval(updateThinkTimer, 100);
                }
                fullReply += chunk.text;
                thinkContentEl.appendChild(document.createTextNode(chunk.text));
                updateThinkTimer();
            } else {
                // ---- 正文内容：思考结束则自动折叠思考面板，逐字实时输出正文 ----
                if (!thinkClosed) {
                    if (thinkDetails) fullReply += '</think>';
                    finalizeThink();
                }
                fullReply += chunk.text;
                replyRaw += chunk.text;
                const span = document.createElement('span');
                span.className = 'fade-in-text';
                span.textContent = chunk.text;
                contentP.appendChild(span);
            }
            uiScroll.conditionalScrollToBottom();

            // 控制打字速度
            const speed = getTypingSpeed();
            if (speed < 1) {
                await new Promise(resolve => setTimeout(resolve, (1 - speed) * 150));
            }
        }
        // 流结束：若仍处于思考阶段（如被截断），补全标签并折叠
        if (thinkDetails && !thinkClosed) {
            fullReply += '</think>';
            finalizeThink();
        }
        // 生成完成后，将正文重新渲染为括号斜体样式（流式阶段保持纯文本逐字输出）
        if (bubble && contentP && replyRaw) {
            const parts = parseParenthesesContent(replyRaw);
            contentP.innerHTML = '';
            for (const part of parts) {
                const span = document.createElement('span');
                if (part.type === 'action') span.className = 'action-text';
                span.textContent = part.type === 'action' ? part.raw : part.text;
                contentP.appendChild(span);
            }
        }
        // 更新消息时间（保留模型名），并重新绑定气泡双击事件
        if (messageDiv && bubble) {
            const oldMsgTime = bubble.querySelector('.msg-time');
            let modelNameSpan = '';
            if (oldMsgTime) {
                const modelSpan = oldMsgTime.querySelector('span');
                if (modelSpan) {
                    modelNameSpan = modelSpan.outerHTML;
                }
            }
            const newTimeHtml = `<div class="msg-time">${modelNameSpan}${getCurrentTime()}</div>`;
            if (oldMsgTime) oldMsgTime.outerHTML = newTimeHtml;

            bubble.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                showMessageActions(messageDiv, 'ai', fullReply, getCurrentTime(), false, null, currentChat.settings?.avatarUrl, null);
            });
        }
        if (SettingsManager.getAutoScrollAfterSend()) uiScroll.scrollToBottom();
        uiAppearance.updateStatusIndicator('online');
        // 保存消息到存储
        const targetChat = chats.find(c => c.id == currentChatId);
        if (targetChat) {
            const activeTopic = topicManager.getActiveTopic(targetChat);
            if (activeTopic) {
                const modelName = SettingsManager.getModelName();
                const msgUid = genMsgUid('ai', fullReply, getCurrentTime());
                const msgData = {
                    type: 'ai',
                    text: fullReply,
                    time: getCurrentTime(),
                    modelName: modelName,
                    uid: msgUid
                };
                // 记录思考用时（秒），用于历史消息回显
                if (thinkStartTime != null) {
                    msgData.thinkSeconds = Math.round(((thinkEndTime ?? performance.now()) - thinkStartTime) / 1000 * 10) / 10;
                }
                // 如果有知识库引用，添加该字段
                if (knowledgeSources && knowledgeSources.length > 0) {
                    msgData.knowledgeSources = knowledgeSources;
                }
                activeTopic.messages.push(msgData);
                targetChat.date = new Date();
                historyListUI.renderHistoryList();
                await chatRepo.saveChat(targetChat);
            }
        }

        if (currentChat.settings?.ttsEnabled) {
            const { replyContent } = parseThinkContent(fullReply);
            if (replyContent) {
                const parts = parseParenthesesContent(replyContent);
                const speechText = parts.filter(p => p.type === 'speech').map(p => p.text).join('');
                if (speechText.trim()) {
                    let ttsVoice = currentChat.settings.ttsVoice;
                    if (!ttsVoice || ttsVoice === '') ttsVoice = 'default';
                    uiAppearance.updateStatusIndicator('speaking', '语音合成中 ...');
                    ttsService.speak(speechText, ttsVoice)
                        .finally(() => uiAppearance.updateStatusIndicator('online'));;
                }
            }
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('流式请求已被取消');
        } else {
            console.error('模型调用失败:', error);
            uiAppearance.updateStatusIndicator('offline', '离线 · 模型调用失败');
            modalManager.customAlert(`❌ 模型调用失败：${error.message}\n请检查模型地址和 API Key 是否正确。`);
        }
    } finally {
        // 🔓 请求结束，恢复输入并清理控制器
        if (thinkTickTimer) { clearInterval(thinkTickTimer); thinkTickTimer = null; }
        if (typingDiv && typingDiv.parentNode) typingDiv.remove();
        uiScroll.releaseRequestLock();
    }
}

// 辅助函数：创建消息气泡（复用）
function createMessageBubble(type, text, time, avatarUrl, modelName = null, knowledgeSources = null) {
    const div = document.createElement('div');
    div.className = `message ${type}`;
    const avatarHtml = avatarUrl ? `<img src="${resolveAssetUrl(avatarUrl)}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;">` : '<i class="fas fa-robot"></i>';
    let timeHtml = `<div class="msg-time">`;
    if (type === 'ai' && modelName) {
        timeHtml += `<span style="margin-right: 8px; font-size: 0.65rem; opacity: 0.7;">🤖 ${escapeHtml(modelName)}</span>`;
    }
    timeHtml += `${escapeHtml(time)}</div>`;

    // 知识库引用
    let sourcesHtml = '';
    if (type === 'ai' && knowledgeSources && knowledgeSources.length > 0) {
        sourcesHtml = `<div class="kb-sources">` +
            knowledgeSources.map(src =>
                `<span class="kb-source-tag" title="相似度: ${src.score}">
                    <i class="fas fa-database"></i> ${escapeHtml(src.filename)}
                </span>`
            ).join('') +
            `</div>`;
    }
    div.innerHTML = `
        <div class="avatar-msg">${avatarHtml}</div>
        <div class="bubble">
            <p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>
            ${timeHtml}
            ${sourcesHtml}
        </div>
    `;
    return div;
}

async function sendUserMessage() {
    if (uiScroll.isProcessing) {
        modalManager.showBriefToast('请等待当前回复完成后再发送');
        return;
    }
    // 如果当前为”显示全部话题”模式，自动切换到最后一个话题
    if (topicManager.getCurrentTopicIndex() === null) {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (currentChat && currentChat.topics.length > 0) {
            await topicManager.setCurrentTopic(currentChat.topics.length - 1, false);
        }
    }

    let text = messageInput.value.trim();
    // 获取文件附件
    let fileAttachment = fileUpload.getFileAttachment();
    if (fileAttachment) {
        fileUpload.clearFile();
    }
    // 获取图片附件
    const imageAttachments = fileUpload.getImageAttachments();
    const imageUrls = fileUpload.getImageDataUrls();
    if (imageAttachments.length > 0) {
        fileUpload.clearImages();
    }

    // 捕获并清除引用状态
    const quoteRef = msgActions.getQuoteRef();
    if (quoteRef) msgActions.clearQuoteRef();

    // 如果引用中包含图片 URL，追加到图片列表传递给模型
    if (quoteRef && quoteRef.imageUrls && quoteRef.imageUrls.length > 0) {
        for (const url of quoteRef.imageUrls) {
            imageUrls.push(await resolveToDataUrl(url));  // asset:// → data URL（模型需要字节）
        }
    }

    if (text === '' && !fileAttachment && imageAttachments.length === 0 && imageUrls.length === 0) return;

    const sendButton = document.querySelector('.send-btn');
    if (sendButton) {
        sendButton.classList.add('animate-send');
        sendButton.addEventListener('animationend', function onAnimEnd() {
            sendButton.classList.remove('animate-send');
            sendButton.removeEventListener('animationend', onAnimEnd);
        }, { once: true });
    }

    // 存储消息时附带文件信息
    const userTime = getCurrentTime();
    const targetChat = chats.find(c => c.id == currentChatId);
    // 发给 AI 的文本保持旧格式（引用前缀 + 用户输入）
    let modelUserMsg = text;
    if (quoteRef) {
        modelUserMsg = `引用消息> **${quoteRef.role}**：${quoteRef.text}\n\n` + text;
    }
    // 构建发送给模型的内容（包含文件内容）
    if (fileAttachment) {
        modelUserMsg = modelUserMsg + `\n\n文件内容如下：\n\`\`\`\n${fileAttachment.content}\n\`\`\``;
    }

    if (targetChat) {
        const activeTopic = topicManager.getActiveTopic(targetChat);
        if (activeTopic) {
            const msgUid = genMsgUid('user', text, userTime);
            activeTopic.messages.push({
                type: 'user',
                text: text,
                time: userTime,
                file: fileAttachment,
                images: imageAttachments.length > 0 ? imageAttachments : undefined,
                modelInputText: modelUserMsg,
                uid: msgUid,
                quoteRef: quoteRef || undefined,
            });
            targetChat.date = new Date();
            historyListUI.renderHistoryList();
            await chatRepo.saveChat(targetChat);
        }
    }
    if (SettingsManager.getAutoScrollAfterSend()) uiScroll.forceScrollToBottom();
    // 渲染消息
    await appendMessageToDOM('user', text, userTime, false, null, null, fileAttachment, null, null, quoteRef || null, null, imageAttachments);
    messageInput.value = '';
    if (messageInput) messageInput.style.height = 'auto';
    simulateAIResponse(modelUserMsg, imageUrls);
}

// (对话管理已迁移至 js/chat-manager.js —— ChatManager)

// ==================== 初始化数据 ====================
async function initData() {
    // 应用已保存的字体大小
    uiAppearance.applyFontSize(SettingsManager.getFontSize());
    await reloadChatsIntoState();
}

// 加载聊天数据到内存并渲染（启动与登录/登出后复用）
async function reloadChatsIntoState() {
    const stored = await loadFromStorage();
    if (stored && stored.length > 0) {
        chats = stored;
        // 读取上次对话 ID
        const lastId = localStorage.getItem(Constants.STORAGE_KEYS.LAST_CHAT_ID);
        if (lastId && chats.some(c => c.id == lastId)) {
            setCurrentChatId(lastId);
        } else {
            setCurrentChatId(chats[0].id);
        }
    } else {
        // 创建默认聊天，使用默认设置
        const defaultChat = {
            id: Date.now(),
            title: "✨ 与 Nova · 意识觉醒",
            date: new Date(),
            topics: JSON.parse(JSON.stringify(Constants.BASE_CHATS)),
            currentTopicIndex: 0,
            settings: JSON.parse(JSON.stringify(Constants.DEFAULT_SETTINGS)),
            pinned: false
        };
        chats = [defaultChat];
        setCurrentChatId(defaultChat.id);
        await chatRepo.saveAllChats(chats);
    }
    historyListUI.renderHistoryList();
    renderMessages(currentChatId, topicManager.getCurrentTopicIndex());
    applyCurrentChatSettings();
}

// 从后端拉取设置并应用（可同步字段覆盖本地，API Key 保留）
async function syncSettingsFromServer() {
    if (!authManager.isLoggedIn()) return;
    try {
        const { settings } = await backendClient.getSettings();
        if (settings && Object.keys(settings).length > 0) {
            SettingsManager.applySyncableSettings(settings);
        }
    } catch (e) { /* 离线，忽略 */ }
}

// 登录 / 登出后刷新：认领 → 切换命名空间 → 拉设置 → 重载聊天 → 重应用外观
async function refreshAfterAuth() {
    authManager.render();
    if (authManager.isLoggedIn()) {
        await claimGuestData();  // 首次登录认领（须在切换命名空间前读访客数据）
    }
    applyNamespace();  // 切换本地缓存命名空间（换抽屉）
    await syncSettingsFromServer();
    authManager.render();  // 此时已是账号命名空间 + 账号设置，重新渲染账号头像
    await reloadChatsIntoState();
    uiAppearance.applyTheme(SettingsManager.getTheme());
    uiAppearance.applyFontSize(SettingsManager.getFontSize());
    modelConfigUI.updateModelSelector();
}

function closeSidebarOnMobile() {
    if (window.innerWidth <= Constants.MOBILE_BREAKPOINT) {
        const sidebar = document.querySelector('.sidebar');
        if (sidebar && sidebar.classList.contains('open')) {
            sidebar.classList.remove('open');
        }
    }
}

// ==================== 事件绑定 ====================

// —— 移动端侧边栏开关 ——
function bindMobileSidebar() {
    const menuToggle = document.getElementById('mobile-menu-toggle');
    const sidebarElem = document.querySelector('.sidebar');
    if (!menuToggle || !sidebarElem) return;

    menuToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        sidebarElem.classList.toggle('open');
    });
    // 点击外部关闭侧边栏
    document.addEventListener('click', (e) => {
        if (sidebarElem.classList.contains('open') &&
            !sidebarElem.contains(e.target) &&
            !menuToggle.contains(e.target)) {
            sidebarElem.classList.remove('open');
        }
    });
    // 点击聊天区域关闭侧边栏
    const mainChat = document.querySelector('.main-chat');
    if (mainChat) {
        mainChat.addEventListener('click', () => {
            sidebarElem.classList.remove('open');
        });
    }
}

// —— 输入框：自动伸缩 + 发送 + 键盘快捷键 ——
function bindMessageInput() {
    const textarea = messageInput;
    if (!textarea) return;

    const autoResize = () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
    };
    textarea.addEventListener('input', autoResize);
    autoResize();

    sendBtn.onclick = function () {
        if (textarea.value.trim() === '') return;
        sendUserMessage();
        setTimeout(() => { textarea.style.height = 'auto'; }, 0);
    };

    textarea.addEventListener('keydown', (e) => {
        const pressed = eventToShortcutString(e);
        if (!pressed) return;

        if (shortcutManager.matchesAction(e, 'send-no-ai')) {
            e.preventDefault();
            sendMessageWithoutAI();
            return;
        }
        if (pressed === 'enter') {
            e.preventDefault();
            sendUserMessage();
            setTimeout(() => { textarea.style.height = 'auto'; }, 0);
        }
    });
}

// —— 工具栏按钮：上传 / 语音 / 知识库 / 折叠菜单 / 图片生成 ——
function bindToolbarButtons() {
    // 上传与媒体预览(背景/头像/文件上传/粘贴/拖拽/图片放大)已迁移至 js/upload-bindings.js —— UploadBindings
    uploadBindings.bind();

    // 语音输入
    const voiceBtn = document.getElementById('voice-input-btn');
    if (voiceBtn) voiceBtn.addEventListener('click', startVoiceInput);

    // 知识库选择
    const kbSelectBtn = document.getElementById('kb-select-btn');
    if (kbSelectBtn) kbSelectBtn.addEventListener('click', () => modalManager.openKnowledgeBaseSelector());

    // 折叠按钮（PC 展开/收起 + 移动端弹出菜单）
    bindCollapseToggle();

    // 图片生成
    imageGenService.bindImageGeneration();
}

// —— 折叠按钮逻辑（从 bindToolbarButtons 中抽出） ——
function bindCollapseToggle() {
    const collapseToggle = document.getElementById('collapse-toggle-btn');
    const collapsibleButtons = document.getElementById('collapsible-buttons');
    const collapseIcon = document.getElementById('collapse-icon');
    if (!collapseToggle || !collapsibleButtons) return;

    collapseToggle.addEventListener('click', () => {
        if (window.innerWidth <= Constants.MOBILE_BREAKPOINT) {
            showMobileCollapseMenu();
        } else {
            const isOpen = collapsibleButtons.classList.toggle('open');
            collapseToggle.classList.toggle('expanded');
            collapseIcon.className = isOpen ? 'fas fa-chevron-left' : 'fas fa-chevron-right';
        }
    });
}

function showMobileCollapseMenu() {
    let existing = document.querySelector('.mobile-collapse-menu');
    if (existing) { existing.remove(); return; }

    const btns = [
        { id: 'kb-select-btn', label: document.getElementById('kb-select-btn')?.innerHTML || '<i class="fas fa-database"></i> 选择知识库' },
        { id: 'upload-file-btn', label: document.getElementById('upload-file-btn')?.innerHTML || '<i class="fas fa-file-upload"></i> 文件上传' },
        { id: 'generate-image-btn', label: document.getElementById('generate-image-btn')?.innerHTML || '<i class="fas fa-image"></i> 生成图片' }
    ];

    const overlay = document.createElement('div');
    overlay.className = 'mobile-collapse-overlay'; // 样式见 css/responsive.css

    const menu = document.createElement('div');
    menu.className = 'mobile-collapse-menu'; // 样式见 css/responsive.css

    btns.forEach((btnData) => {
        const btn = document.createElement('button');
        btn.className = 'action-btn mobile-collapse-item'; // 样式见 css/responsive.css
        btn.innerHTML = btnData.label;
        btn.addEventListener('click', () => {
            const originalBtn = document.getElementById(btnData.id);
            if (originalBtn) originalBtn.click();
            closeMobileMenu();
        });
        menu.appendChild(btn);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'action-btn mobile-collapse-close'; // 样式见 css/responsive.css
    closeBtn.innerHTML = '<i class="fas fa-times"></i> 取消';
    closeBtn.addEventListener('click', closeMobileMenu);
    menu.appendChild(closeBtn);

    overlay.appendChild(menu);
    document.body.appendChild(overlay);
    // 防止拖选文本时误关闭：只有 mousedown 和 click 都在遮罩上时才关闭
    let _mobileMenuMousedownOnOverlay = false;
    overlay.addEventListener('mousedown', (e) => { _mobileMenuMousedownOnOverlay = (e.target === overlay); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay && _mobileMenuMousedownOnOverlay) closeMobileMenu(); });

    function closeMobileMenu() {
        if (overlay.parentNode) overlay.remove();
    }
}

// —— 所有弹窗控件（设置 / 全局设置 / 话题 / 知识库选择） ——
function bindModalControls() {
    // —— 对话设置弹窗 (settings-modal) ——
    const modal = document.getElementById('settings-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const cancelBtn = document.getElementById('cancel-settings-btn');
    const saveBtn = document.getElementById('save-settings-btn');
    if (closeModalBtn) closeModalBtn.addEventListener('click', () => modalManager.closeSettingsModal());
    if (cancelBtn) cancelBtn.addEventListener('click', () => modalManager.closeSettingsModal());
    if (saveBtn) saveBtn.addEventListener('click', () => modalManager.saveSettings());
    if (modal) modalManager.bindModalOverlayClose(modal, () => modalManager.closeSettingsModal());

    // 对话设置入口按钮
    const chatSettingsBtn = document.getElementById('chat-settings-btn');
    if (chatSettingsBtn) chatSettingsBtn.addEventListener('click', () => modalManager.openSettingsModal());

    // —— 全局设置弹窗 (global-settings-modal) ——
    const globalModal = document.getElementById('global-settings-modal');
    const closeGlobalBtn = document.getElementById('close-global-settings');
    const cancelGlobalBtn = document.getElementById('cancel-global-settings');
    const saveGlobalBtn = document.getElementById('save-global-settings');
    if (closeGlobalBtn) closeGlobalBtn.addEventListener('click', () => modalManager.closeGlobalModal());
    if (cancelGlobalBtn) cancelGlobalBtn.addEventListener('click', () => modalManager.closeGlobalModal());
    if (saveGlobalBtn) saveGlobalBtn.addEventListener('click', () => modalManager.saveGlobalSettings());
    if (globalModal) modalManager.bindModalOverlayClose(globalModal, () => modalManager.closeGlobalModal());

    // —— 话题管理弹窗 (topics-modal) ——
    const topicsBtn = document.getElementById('topics-manage-btn');
    if (topicsBtn) topicsBtn.addEventListener('click', () => modalManager.openTopicsModal());
    const closeTopicsBtn = document.getElementById('close-topics-modal');
    const cancelTopicsBtn = document.getElementById('cancel-topics-btn');
    if (closeTopicsBtn) closeTopicsBtn.addEventListener('click', () => modalManager.closeTopicsModal());
    if (cancelTopicsBtn) cancelTopicsBtn.addEventListener('click', () => modalManager.closeTopicsModal());
    const topicsModal = document.getElementById('topics-modal');
    if (topicsModal) modalManager.bindModalOverlayClose(topicsModal, () => modalManager.closeTopicsModal());

    const newTopicModalBtn = document.getElementById('new-topic-modal-btn');
    if (newTopicModalBtn) newTopicModalBtn.addEventListener('click', () => { topicManager.startNewTopic(); modalManager.closeTopicsModal(); });

    const showAllTopicsBtn = document.getElementById('show-all-topics-btn');
    if (showAllTopicsBtn) showAllTopicsBtn.addEventListener('click', async () => { await topicManager.setCurrentTopic(null); modalManager.closeTopicsModal(); });

    // —— 知识库选择弹窗 (kb-select-modal) ——
    const closeKbModal = document.getElementById('close-kb-select-modal');
    const cancelKbBtn = document.getElementById('cancel-kb-select-btn');
    const confirmKbBtn = document.getElementById('confirm-kb-select-btn');
    if (closeKbModal) closeKbModal.addEventListener('click', () => modalManager.closeKnowledgeBaseSelector());
    if (cancelKbBtn) cancelKbBtn.addEventListener('click', () => modalManager.closeKnowledgeBaseSelector());
    if (confirmKbBtn) confirmKbBtn.addEventListener('click', () => modalManager.confirmKnowledgeBaseSelection());
    const kbModal = document.getElementById('kb-select-modal');
    if (kbModal) modalManager.bindModalOverlayClose(kbModal, () => modalManager.closeKnowledgeBaseSelector());

    // —— Escape 关闭最上层弹窗 ——
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        const openModals = document.querySelectorAll('.settings-modal[style*="display: flex"]');
        if (openModals.length > 0) {
            const topModal = openModals[openModals.length - 1];
            const closeBtn = topModal.querySelector('.modal-close');
            if (closeBtn) { closeBtn.click(); e.preventDefault(); e.stopPropagation(); }
            return;
        }
        const fileModal = document.querySelector('.file-content-modal');
        if (fileModal && fileModal.style.display === 'flex') {
            fileModal.remove();
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
}

// —— 全局设置面板内部：标签页 / 连接测试 / 头像 / 快捷键 / TTS / 模型切换 ——
function bindSettingsPanel() {
    // 标签页切换
    const menuItems = document.querySelectorAll('.settings-menu-item');
    const panes = document.querySelectorAll('.settings-tab-pane');
    menuItems.forEach(item => {
        item.addEventListener('click', () => {
            const tabId = item.getAttribute('data-tab');
            menuItems.forEach(mi => mi.classList.remove('active'));
            item.classList.add('active');
            panes.forEach(pane => pane.classList.remove('active'));
            document.getElementById(`tab-${tabId}`).classList.add('active');
            // 知识库懒加载：首次点击该标签时才请求列表
            if (tabId === 'knowledge') {
                modalManager.kbManager.ensureKnowledgeBaseLoaded();
            }
        });
    });

    // 测试连接按钮（直接从输入框读取）
    const testBtn = document.getElementById('test-model-connection-btn');
    if (testBtn) {
        // 移除旧监听，避免重复
        testBtn.removeEventListener('click', testBtn._testHandler);
        testBtn._testHandler = async function() {
            const statusEl = document.getElementById('test-connection-status');
            if (!statusEl) return;

            // 直接从输入框读取地址和密钥
            const hostInput = document.getElementById('model-host');
            const keyInput = document.getElementById('api-key');
            const providerSelect = document.getElementById('model-provider');
            const modelInput = document.getElementById('global-model-name');

            const host = hostInput ? hostInput.value.trim() : '';
            const apiKey = keyInput ? keyInput.value.trim() : '';
            const provider = providerSelect ? providerSelect.value : 'ollama';
            const model = modelInput ? modelInput.value.trim() : '';

            if (!host) {
                statusEl.innerHTML = '<span style="color: #ff7a5c;">❌ 请先填写模型主机地址</span>';
                return;
            }

            statusEl.innerHTML = '<span style="color: #b7c4ff;"><i class="fas fa-spinner fa-pulse"></i> 检测中…</span>';

            // 创建临时 ModelService 实例进行测试
            const tempService = new ModelService({
                modelHost: host,
                apiKey: apiKey,
                modelName: model || 'test',
            });

            try {
                const result = await tempService.testConnection();
                statusEl.innerHTML = result.success
                    ? `<span style="color: #2effb0;">✅ ${result.message}</span>`
                    : `<span style="color: #ff7a5c;">❌ ${result.message}</span>`;
            } catch (err) {
                statusEl.innerHTML = `<span style="color: #ff7a5c;">❌ 连接失败：${err.message}</span>`;
            }
        };
        testBtn.addEventListener('click', testBtn._testHandler);
    }

    // 左下角设置按钮（打开全局设置）
    const settingBtn = document.querySelector('.setting-btn');
    if (settingBtn) {
        const newBtn = settingBtn.cloneNode(true);
        settingBtn.parentNode.replaceChild(newBtn, settingBtn);
        newBtn.addEventListener('click', () => modalManager.openGlobalSettings());
    }

    // 头像点击 → 裁剪上传
    const avatarImg = document.getElementById('avatar-img');
    if (avatarImg) {
        avatarImg.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                modalManager.showCropModal(file, 1, { maxWidth: 1024, mimeType: 'image/jpeg', quality: 0.9 }, (croppedDataUrl) => {
                    avatarImg.src = croppedDataUrl;
                    avatarImg.setAttribute('data-custom', 'true');
                });
            };
            fileInput.click();
        });
    }

    // 重置快捷键
    document.getElementById('reset-shortcuts-btn')?.addEventListener('click', () => shortcutManager.reset());

    // 获取 TTS 音色列表
    document.getElementById('fetch-voices-btn')?.addEventListener('click', async () => {
        const apiUrl = document.getElementById('tts-api-url').value;
        if (!apiUrl) { modalManager.customAlert('请先填写 TTS API 地址'); return; }
        try {
            const response = await fetch(`${apiUrl}/voices`);
            if (!response.ok) throw new Error('获取失败');
            const data = await response.json();
            const voiceList = data.voices || [];
            const displaySpan = document.getElementById('voice-list-display');
            if (voiceList.length === 0) {
                displaySpan.innerText = '无可用音色';
            } else {
                displaySpan.innerHTML = voiceList.join(', ');
            }
        } catch (err) {
            console.error(err);
            document.getElementById('voice-list-display').innerText = '获取失败，请检查服务地址';
        }
    });

    // 快速模型切换下拉框
    modelConfigUI.bindQuickModelSwitch();
}

// —— 对话操作：新建 / 导入 / 滚动 / 返回全部 / 引用关闭 / 搜索 / 添加模型 ——
function bindChatActions() {
    const newChatBtn = document.querySelector('.new-chat-btn');
    if (newChatBtn) newChatBtn.addEventListener('click', () => chatManager.createNewChat());

    // —— 角色卡导入辅助:PNG 角色卡解析 + 确认 + 裁剪 + 建对话 ——
    function buildCardPreviewLines(card) {
        return [
            `角色名：${card.name}`,
            card.persona ? `人设：${card.persona.slice(0, 150)}${card.persona.length > 150 ? '…' : ''}` : null,
            card.greeting ? `开场白：${card.greeting.slice(0, 80)}${card.greeting.length > 80 ? '…' : ''}` : null,
        ].filter(Boolean);
    }

    // 确认后真正创建对话(PNG 分支的裁剪回调也会走这里)
    async function finalizeCharacterCardImport(card, avatarUrl) {
        const newChat = CharacterCard.buildChatFromCard(card, avatarUrl, chats);
        chats.unshift(newChat);
        setCurrentChatId(newChat.id);
        topicManager.setCurrentTopicIndex(null);
        historyListUI.renderHistoryList();
        renderMessages(currentChatId);
        applyCurrentChatSettings();
        await chatRepo.saveAllChats(chats);
        modalManager.customAlert(`角色「${card.name}」导入成功`, 'success');
    }

    async function handlePngCharacterCard(file) {
        try {
            const parsed = await CharacterCard.parseCharacterCardFile(file);
            if (!parsed) {
                modalManager.customAlert('未能识别的 PNG 文件：未找到内嵌角色卡数据（chara chunk）。', 'error');
                return;
            }
            const card = parsed.card;
            if (!confirm(`确认导入该角色卡？\n\n${buildCardPreviewLines(card).join('\n')}\n\n将创建一个新对话并应用该角色设定。`)) return;
            // 确定导入后,弹出头像裁剪弹窗(1:1 方形),裁剪结果作为角色头像
            modalManager.showCropModal(file, 1, { maxWidth: 512, mimeType: 'image/jpeg', quality: 0.9 }, async (croppedDataUrl) => {
                await finalizeCharacterCardImport(card, croppedDataUrl);
            });
        } catch (err) {
            modalManager.customAlert('角色卡解析失败：' + err.message, 'error');
        }
    }

    async function handleCharacterCardData(card, avatarDataUrl) {
        if (!confirm(`确认导入该角色卡？\n\n${buildCardPreviewLines(card).join('\n')}\n\n将创建一个新对话并应用该角色设定。`)) return;
        await finalizeCharacterCardImport(card, avatarDataUrl);
    }

    // 导入(支持:本项目对话 JSON、SillyTavern 社区标准角色卡 PNG / JSON)
    const importBtn = document.querySelector('.import-chat-btn');
    if (importBtn) {
        importBtn.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.json,.png,application/json,image/png';
            fileInput.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;

                // —— 分支一:PNG 角色卡(内嵌 chara JSON) ——
                if (file.type === 'image/png' || /\.png$/i.test(file.name)) {
                    await handlePngCharacterCard(file);
                    return;
                }

                // —— JSON 文件:角色卡 JSON 或本项目对话 JSON ——
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    try {
                        const importedData = JSON.parse(ev.target.result);
                        if (CharacterCard.isCharacterCardJSON(importedData)) {
                            await handleCharacterCardData(CharacterCard.normalizeCard(importedData), null);
                        } else {
                            const newChat = await chatIO.importFromJSON(importedData, chats);
                            chats.unshift(newChat);
                            setCurrentChatId(newChat.id);
                            topicManager.setCurrentTopicIndex(null);
                            historyListUI.renderHistoryList();
                            renderMessages(currentChatId);
                            applyCurrentChatSettings();
                            await chatRepo.saveAllChats(chats);
                            modalManager.customAlert('导入成功', 'success');
                        }
                    } catch (err) {
                        modalManager.customAlert('JSON 解析失败：' + err.message, 'error');
                    }
                };
                reader.readAsText(file, 'UTF-8');
            };
            fileInput.click();
        });
    }

    // 聊天区滚动
    if (chatMessages) chatMessages.addEventListener('scroll', () => uiScroll.updateAutoScrollFlag());

    // 返回全部话题
    const backBtn = document.getElementById('back-to-all-topics');
    if (backBtn) backBtn.addEventListener('click', async () => { await topicManager.setCurrentTopic(null, false); });

    // 引用消息关闭
    const quoteCloseBtn = document.getElementById('quote-indicator-close');
    if (quoteCloseBtn) quoteCloseBtn.addEventListener('click', () => msgActions.clearQuoteRef());

    // 添加模型
    const addModelBtn = document.getElementById('add-model-btn');
    if (addModelBtn) {
        addModelBtn.addEventListener('click', () => {
            const newModel = document.getElementById('new-model-name').value;
            if (modelConfigUI.addModel(newModel)) document.getElementById('new-model-name').value = '';
        });
    }

    // 搜索 UI
    searchManager.setupUI();
}

// 主入口：依次调用各子模块
function bindEvents() {
    bindMobileSidebar();
    bindMessageInput();
    bindToolbarButtons();
    bindModalControls();
    bindSettingsPanel();
    bindChatActions();
    suggestManager.bind();  // 消息建议按钮（聚焦输入框时从右向左滑出）
}

// (话题管理已迁移至 js/topic-manager.js;历史菜单/置顶/删除已迁移至 js/history-list.js 与 js/chat-manager.js)

// 自动调整 textarea 高度
function autoResizeTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
}

// 为指定的 textarea 绑定自动扩展事件
function bindAutoResize(textarea) {
    if (!textarea) return;
    // 移除已有监听，避免重复
    textarea.removeEventListener('input', textarea._autoResizeHandler);
    const handler = () => autoResizeTextarea(textarea);
    textarea._autoResizeHandler = handler;
    textarea.addEventListener('input', handler);
    handler(); // 初始化
}

// (话题摘要/切换已迁移至 js/topic-manager.js —— TopicManager)

// (主题 / 字体大小 / 状态指示器 已迁移至 js/ui-appearance.js —— UiAppearance)

// (对话切换已迁移至 js/chat-manager.js —— ChatManager)

// 聚焦聊天输入框
function focusChatInput() {
    const textarea = document.querySelector('.auto-expand-textarea');
    if (textarea) {
        textarea.focus();
    }
}

// 发送消息但不触发 AI 回复
async function sendMessageWithoutAI() {
    if (uiScroll.isProcessing) {
        modalManager.customAlert('AI 正在回复中，请稍候...', 'warning');
        return;
    }
    // 如果当前为”显示全部话题”模式，自动切换到最后一个话题
    if (topicManager.getCurrentTopicIndex() === null) {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (currentChat && currentChat.topics.length > 0) {
            await topicManager.setCurrentTopic(currentChat.topics.length - 1, false);
        }
    }
    let text = messageInput.value.trim();
    // 获取文件附件
    let fileAttachment = fileUpload.getFileAttachment();
    if (fileAttachment) {
        fileUpload.clearFile();  // 立即清除，避免重复使用
    }

    if (text === '' && !fileAttachment) return;

    const userTime = getCurrentTime();
    // 发给 AI 的文本保持旧格式（引用前缀 + 用户输入）
    let modelUserMsg = text;
    const quoteRef = msgActions.getQuoteRef();
    if (quoteRef) {
        msgActions.clearQuoteRef(); // 捕获并清除引用状态
        modelUserMsg = `引用消息> **${quoteRef.role}**：${quoteRef.text}\n\n` + text;
    }
    if (fileAttachment) {
        modelUserMsg = modelUserMsg + `\n\n文件内容如下：\n\`\`\`\n${fileAttachment.content}\n\`\`\``;
    }
    const targetChat = chats.find(c => c.id == currentChatId);
    if (targetChat) {
        const activeTopic = topicManager.getActiveTopic(targetChat);
        if (activeTopic) {
            activeTopic.messages.push({
                type: 'user',
                text: text,
                time: userTime,
                file: fileAttachment,
                modelInputText: modelUserMsg,
                uid: genMsgUid('user', text, userTime),
                quoteRef: quoteRef || undefined,
            });
            targetChat.date = new Date();
            historyListUI.renderHistoryList();
            await chatRepo.saveChat(targetChat);
        }
    }
    await appendMessageToDOM('user', text, userTime, false, null, null, fileAttachment, null, null, quoteRef || null);
    messageInput.value = '';
    messageInput.style.height = 'auto';
    if (SettingsManager.getAutoScrollAfterSend()) uiScroll.forceScrollToBottom();
}

// 沉浸模式切换
function toggleImmersiveMode() {
    const body = document.body;
    const isImmersive = body.classList.toggle('immersive-mode');
    
    // 移动端：退出沉浸模式时自动关闭侧边栏打开状态
    if (!isImmersive && window.innerWidth <= Constants.MOBILE_BREAKPOINT) {
        const sidebar = document.querySelector('.sidebar');
        if (sidebar && sidebar.classList.contains('open')) {
            sidebar.classList.remove('open');
        }
    }

    // 显示提示
    modalManager.showBriefToast(isImmersive ? '🌙 沉浸模式已开启 (再次按快捷键退出)' : '✨ 已退出沉浸模式')
}

// (知识库标签恢复已迁移至 js/history-list.js;知识库检索已迁移至 js/knowledge-retriever.js)

async function init() {
    // 初始化 index.html 中以 src="" 占位的元素（默认头像等）可以避免在 HTML 中硬编码超长 SVG base64 字符串。
    const defaultAvatarEl = document.getElementById('global-avatar-img');
    if (defaultAvatarEl && !defaultAvatarEl.src) {
        defaultAvatarEl.src = Constants.DEFAULT_USER_AVATAR;
    }
    // ==================== 动态注入弹窗样式 ====================
    const styleSheet = document.createElement("style");
    styleSheet.textContent = Constants.MODAL_STYLES;
    document.head.appendChild(styleSheet);
    document.body.insertAdjacentHTML('beforeend', Constants.MODAL_HTML); // 动态创建弹窗 HTML 

    // 云同步：先同步恢复 token + 应用命名空间（让 loadModelListAndInit 读到正确账号的设置）
    authManager.restoreTokenSync();
    applyNamespace();

    modelConfigUI.loadModelListAndInit();
    // 异步校验登录态（token 失效则清除）→ 校验后重应用命名空间 → 注册推送钩子 → 拉设置 → 加载聊天
    await authManager.init();
    applyNamespace();
    SettingsManager.setSyncHook((syncable) => {
        authManager.renderProfileAvatar();  // 聊天头像变化时同步刷新账号头像（复用模式）
        if (!authManager.isLoggedIn()) return;
        backendClient.putSettings(syncable).catch(() => {});
    });
    await syncSettingsFromServer();
    await initData();
    uiAppearance.applyTheme(SettingsManager.getTheme());
    initResizer();
    shortcutManager.init();
    bindEvents();
    getModelService();
    modelConfigUI.renderModelListUI();      // 渲染模型列表弹窗
    modelConfigUI.updateModelSelector();    // 更新快速切换下拉框
    // 初始化背景（自动判断全局视频 / 对话静态图 / 默认 SVG）
    applyCurrentChatSettings();
    // 清理旧版单 key 视频残留（之前用 'bg-video' 存的，现在已改为 'bg-video-{chatId}'）
    AssetStore.cleanupOrphaned().catch(() => {});
    historyListUI.restoreSelectedKnowledgeBase();

    // 初始化完成，移除遮罩并显示主界面
    const overlay = document.getElementById('loading-overlay');
    const chatApp = document.querySelector('.chat-app');
    if (overlay) {
        overlay.classList.add('fade-out');
        // 等过渡结束后移除元素
        overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    }
    if (chatApp) {
        chatApp.classList.add('visible');
    }
}
init();
