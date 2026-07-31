// 聊天页面核心交互功能
import { 
    escapeHtml, getCurrentTime, formatDate, parseThinkContent,renderMessageWithThink, genMsgUid,
    parseParenthesesContent, compressImage, isImageUrl, eventToShortcutString,
} from './js/utils.js';
import Constants from './js/constants.js'
import { ModelService } from './js/model-service.js';
import { ChatRepository } from './js/repository.js';
import { TTsService } from './js/tts-service.js';
import { ChatIO } from './js/chat-io.js';
import { FileUploadService } from './js/file-upload.js';
import { SettingsManager } from './js/settings-manager.js';
import ModalManager from './js/modal-manager.js';
import { TokenTracker } from './js/token-tracker.js';
import VoiceInput from './js/voice-input.js';
import BackgroundManager from './js/background-manager.js';
import AssetStore from './js/asset-store.js';
import SearchManager from './js/search.js';
import MessageActions from './js/message-actions.js';
import ShortcutManager from './js/shortcut-manager.js';


// ==================== DOM 元素绑定 ====================
const historyList = document.querySelector('.history-list');
const chatMessages = document.querySelector('.chat-messages');
const messageInput = document.querySelector('.auto-expand-textarea');
const sendBtn = document.querySelector('.send-btn');


const DB_NAME = Constants.DB_NAME;
const DB_VERSION = Constants.DB_VERSION;
const STORE_NAME = Constants.STORE_NAME;
const DEFAULT_SHORTCUTS = Constants.DEFAULT_SHORTCUTS
const chatRepo = new ChatRepository();
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
let autoScrollEnabled = true;     // 是否允许自动滚动
let isProcessing = false;   // 请求进行中（包括发送到模型返回全过程的锁）
let currentStatus = 'online';   // 记录当前指示器状态
const cropperRef = { value: null };
const modelServiceInstanceRef = { value: null };

// ==================== 话题辅助函数 ====================
// currentTopicIndex 移入 chat 对象，不再使用全局变量
function getCurrentTopicIndex() {
    const chat = chats.find(c => c.id == currentChatId);
    return chat ? chat.currentTopicIndex : null;
}

function setCurrentTopicIndex(value) {
    const chat = chats.find(c => c.id == currentChatId);
    if (chat) chat.currentTopicIndex = value;
}

/** 获取当前对话的活跃话题（当前选中话题），可能为 null */
function getActiveTopic(chat) {
    if (!chat || !chat.topics) return null;
    const idx = chat.currentTopicIndex;
    if (idx === null || idx === undefined || idx < 0 || idx >= chat.topics.length) return null;
    return chat.topics[idx];
}

// ==================== 快捷键管理器 ====================
// 注意：先于 modalManager 构造，因为 modalManager 依赖 shortcutManager。
// customAlert 在 modalManager 创建后注入。
const shortcutManager = new ShortcutManager({
    defaultShortcuts: DEFAULT_SHORTCUTS,
    getStoredShortcuts: () => SettingsManager.getShortcuts(),
    saveShortcuts: (shortcuts) => SettingsManager.update({ shortcuts }),
    actionCallbacks: {
        'new-chat':          () => createNewChat(),
        'new-topic':         () => startNewTopic(),
        'prev-chat':         () => switchToPreviousChat(),
        'next-chat':         () => switchToNextChat(),
        'export-json':       () => chatIO.exportAsJSON(chats.find(c => c.id == currentChatId)),
        'focus-input':       () => focusChatInput(),
        'send-no-ai':        () => sendMessageWithoutAI(),
        'focus-search':      () => searchManager.focusSearchInput(),
        'toggle-immersive':  () => toggleImmersiveMode(),
    },
});

// ==================== 弹窗管理器 ====================
// 注意：ctx 中的回调函数（renderMessages 等）由 function 声明定义在下方，JS 会提升声明，因此引用安全。
const modalManager = new ModalManager({
    get chats() { return chats; },            // getter：initData 会重新赋值 chats，必须动态读取
    get currentChatId() { return currentChatId; },
    get currentTopicIndex() { return getCurrentTopicIndex(); },
    chatRepo,
    chatIO,
    ttsService,
    modelServiceInstanceRef,
    cropperRef,
    getShortcuts: () => shortcutManager.getShortcuts(),
    getModelService,
    releaseRequestLock,
    updateStatusIndicator,
    // 以下回调函数由下方 function 声明定义（JS 提升），在构造时引用安全：
    renderMessages: (chatId, topicIdx) => renderMessages(chatId, topicIdx),
    renderHistoryList: () => renderHistoryList(),
    applyCurrentChatSettings: () => applyCurrentChatSettings(),
    startNewTopic: () => startNewTopic(),
    setCurrentTopic: (idx) => setCurrentTopic(idx),
    applyTheme: (theme) => applyTheme(theme),
    applyFontSize: (size) => applyFontSize(size),
    renderShortcutsPanel: () => shortcutManager.renderPanel(),
    bindAutoResize: (el) => bindAutoResize(el),
    updateModelSelector: () => updateModelSelector(),
    renderModelListUI: () => renderModelListUI(),
    saveModelListToStorage: () => saveModelListToStorage(),
    addModel: (name) => addModel(name),
    generateTopicSummary: (idx, msgs) => generateTopicSummary(idx, msgs),
    focusChatInput: () => focusChatInput(),
    focusSearchInput: () => searchManager.focusSearchInput(),
    createNewChat: () => createNewChat(),
    switchToPreviousChat: () => switchToPreviousChat(),
    switchToNextChat: () => switchToNextChat(),
    sendMessageWithoutAI: () => sendMessageWithoutAI(),
    toggleImmersiveMode: () => toggleImmersiveMode(),
    executeAction: (action) => shortcutManager.executeAction(action),
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
    getCurrentTopicIndex: () => getCurrentTopicIndex(),
    setCurrentTopicIndex: (v) => setCurrentTopicIndex(v),
    switchChat,
    renderMessages: (chatId, topicIdx) => renderMessages(chatId, topicIdx),
});

// ==================== 消息操作菜单 ====================
const msgActions = new MessageActions({
    getChats: () => chats,
    getCurrentChatId: () => currentChatId,
    getCurrentTopicIndex: () => getCurrentTopicIndex(),
    isProcessing: () => isProcessing,
    chatRepo,
    ttsService,
    chatMessages,
    renderMessages: (chatId, topicIdx) => renderMessages(chatId, topicIdx),
    renderHistoryList: () => renderHistoryList(),
    customAlert: (msg, type) => modalManager.customAlert(msg, type),
    showBriefToast: (msg) => modalManager.showBriefToast(msg),
    simulateAIResponse,
    appendMessageToDOM,
    updateStatusIndicator,
});
function showMessageActions(...args) { msgActions.showMessageActions(...args); }
function showPictureActions(...args) { msgActions.showPictureActions(...args); }

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

// 禁用输入区域
function disableInput() {
    const sendBtn = document.querySelector('.send-btn');
    if (sendBtn) {
        sendBtn.style.pointerEvents = 'none';
        sendBtn.style.opacity = '0.5';
    }
}

// 启用输入区域
function enableInput() {
    const sendBtn = document.querySelector('.send-btn');
    if (sendBtn) {
        sendBtn.style.pointerEvents = 'auto';
        sendBtn.style.opacity = '1';
    }
}

// ==================== 请求生命周期管理（避免并发与竞态） ====================
// acquireRequestLock: 返回 true 表示取得锁并开始请求，false 表示已有请求在进行
function acquireRequestLock() {
    if (isProcessing) return false;
    isProcessing = true;
    disableInput();
    return true;
}

// releaseRequestLock: 结束请求，并根据传入的 controller 清理匹配的控制器
function releaseRequestLock() {
    isProcessing = false;
    enableInput();
}

function updateAutoScrollFlag() {
    if (!chatMessages) return;
    const { scrollTop, scrollHeight, clientHeight } = chatMessages;
    const atBottom = scrollHeight - scrollTop - clientHeight <= Constants.SCROLL_THRESHOLD;// 距离底部阈值（px）
    autoScrollEnabled = atBottom;
}

function conditionalScrollToBottom() {
    if (autoScrollEnabled) {
        scrollToBottom();
    }
}

function forceScrollToBottom() {
    autoScrollEnabled = true;
    scrollToBottom();
}

function scrollToBottom() {if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;}

function renderModelListUI() {
    const models = ModelService.getModels();
    const container = document.getElementById('model-list-container');
    if (!container) return;
    if (models.length === 0) {
        container.innerHTML = '<div style="padding: 8px; text-align: center; opacity: 0.6;">暂无模型，请添加</div>';
        return;
    }
    container.innerHTML = models.map(model => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-bottom: 1px solid rgba(100,130,255,0.2);">
            <span>🤖 ${escapeHtml(model)}</span>
            <div>
                <button class="select-model-btn" data-model="${escapeHtml(model)}" style="background: none; border: none; color: #5f7eff; cursor: pointer; margin-right: 8px;">✓ 使用</button>
                <button class="delete-model-btn" data-model="${escapeHtml(model)}" style="background: none; border: none; color: #ff8a7a; cursor: pointer;">🗑 删除</button>
            </div>
        </div>
    `).join('');

    // 绑定使用和删除事件
    document.querySelectorAll('.select-model-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const modelName = btn.getAttribute('data-model');
            // 更新全局设置中的当前模型
            SettingsManager.update({ modelName });
            // 更新全局设置弹窗中的模型名称输入框
            const modelNameInput = document.getElementById('global-model-name');
            if (modelNameInput) modelNameInput.value = modelName;
            // 刷新快速切换下拉菜单
            updateModelSelector();
            modalManager.customAlert(`已切换到模型：${modelName}`, 'success');
        });
    });
    document.querySelectorAll('.delete-model-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const modelName = btn.getAttribute('data-model');
            const currentModels = ModelService.getModels();
            if (currentModels.length === 1) {
                modalManager.customAlert('至少保留一个模型');
                return;
            }
            ModelService.removeModel(modelName);
            saveModelListToStorage();
            renderModelListUI();      // 刷新列表
            updateModelSelector();    // 刷新下拉框
            // 如果删除的是当前使用的模型，则自动切换到列表第一个
            if (SettingsManager.getModelName() === modelName) {
                SettingsManager.update({ modelName: models[0] });
                const modelNameInput = document.getElementById('global-model-name');
                if (modelNameInput) modelNameInput.value = models[0];
                updateModelSelector();
            }
        });
    });
}

function updateModelSelector() {
    const models = ModelService.getModels();
    const select = document.getElementById('quick-model-select');
    if (!select) return;
    const currentModel = SettingsManager.getModelName();
    select.innerHTML = '';
    models.forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        if (model === currentModel) option.selected = true;
        select.appendChild(option);
    });
    if (models.length === 0) {
        select.innerHTML = '<option>无模型</option>';
    }
}

// 监听快速切换
function bindQuickModelSwitch() {
    const select = document.getElementById('quick-model-select');
    if (!select) return;
    select.addEventListener('change', (e) => {
        const newModel = e.target.value;
        SettingsManager.update({ modelName: newModel });
        // 同步更新全局设置弹窗中的输入框
        const modelNameInput = document.getElementById('global-model-name');
        if (modelNameInput) modelNameInput.value = newModel;
        // 显示提示
        modalManager.showBriefToast(`已切换到模型：${newModel}`)
    });
}

// 添加模型
function addModel(modelName) {
    if (ModelService.addModel(modelName)) {
        saveModelListToStorage();
        renderModelListUI();
        updateModelSelector();
        return true;
    }
    return false;
}

// 保存模型列表到 localStorage（由 script.js 负责持久化）
function saveModelListToStorage() {
    const models = ModelService.getModels();
    localStorage.setItem(Constants.STORAGE_KEYS.MODEL_LIST, JSON.stringify(models));
    // 同步更新当前厂商模型列表（保留已有的 apiKey / modelHost）
    const currentProvider = SettingsManager.getModelProvider();
    const existing = SettingsManager.loadProviderState(currentProvider) || {};
    SettingsManager.saveProviderState(currentProvider, {
        apiKey: existing.apiKey ?? SettingsManager.getApiKey(),
        modelHost: existing.modelHost ?? SettingsManager.getModelHost(),
        models: models,
        currentModel: SettingsManager.getModelName(),
    });
}

// 加载模型列表并初始化 ModelService 的静态列表
function loadModelListAndInit() {
    const currentProvider = SettingsManager.getModelProvider();
    // 优先从厂商独立状态中恢复模型列表
    const savedState = SettingsManager.loadProviderState(currentProvider);
    let models = [];
    if (savedState && savedState.models && savedState.models.length > 0) {
        models = savedState.models;
        // 同时恢复该厂商的当前模型
        if (savedState.currentModel) {
            SettingsManager.update({ modelName: savedState.currentModel });
        }
    } else {
        // 回退到旧的全局 model_list
        const stored = localStorage.getItem(Constants.STORAGE_KEYS.MODEL_LIST);
        if (stored) {
            models = JSON.parse(stored);
        } else {
            models = [SettingsManager.getModelName()];
            localStorage.setItem(Constants.STORAGE_KEYS.MODEL_LIST, JSON.stringify(models));
        }
    }
    ModelService.setModels(models);
}
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
            // 恢复日期对象（JSON 序列化会丢失 Date 类型）
            return storedChats.map(chat => ({
                ...chat,
                date: new Date(chat.date),
                topics: (chat.topics || []).map(topic => ({
                    ...topic,
                    messages: topic.messages.map(msg => ({ ...msg }))
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
}

// 渲染左侧历史列表
function renderHistoryList() {
    if (!historyList) return;
    historyList.innerHTML = '';
    // 排序：置顶的在前，然后按时间倒序（最新的在前）
    const sortedChats = [...chats].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.date - a.date;
    });
    sortedChats.forEach(chat => {
        const settings = chat.settings || Constants.DEFAULT_SETTINGS;
        const roleName = settings.roleName || Constants.DEFAULT_ROLE_NAME;
        const avatarUrl = settings.avatarUrl;
        
        const historyItem = document.createElement('div');
        historyItem.className = `history-item ${currentChatId === chat.id ? 'active' : ''}`;
        historyItem.setAttribute('data-id', chat.id);
        
        let avatarHtml = '';
        if (avatarUrl) {
            avatarHtml = `<img src="${avatarUrl}" class="history-avatar-img" alt="avatar">`;
        } else {
            avatarHtml = `<i class="fas fa-robot history-default-icon"></i>`;
        }
        
        // 标题行：角色名称 + 星星（如果置顶）
        const starHtml = chat.pinned ? '<i class="fas fa-star pin-star"></i>' : '';
        
        historyItem.innerHTML = `
            <div class="history-avatar">
                ${avatarHtml}
            </div>
            <div class="history-info">
                <div class="title">
                    ${escapeHtml(roleName)}
                    ${starHtml}
                </div>
                <div class="date">${formatDate(chat.date)}</div>
            </div>
        `;
        const menuTrigger = document.createElement('div');
        menuTrigger.className = 'history-menu-trigger';
        menuTrigger.innerHTML = '<i class="fas fa-ellipsis-v"></i>';
        historyItem.appendChild(menuTrigger);
        historyList.appendChild(historyItem);
        
        attachMenuEvents(historyItem, chat);
    });
    if (chats.length === 0) {
        historyList.innerHTML = '<div style="padding:20px; text-align:center; opacity:0.5;">暂无对话，点击“新对话”开始</div>';
    }
    attachHistoryClickEvents();
}

// 追加消息到DOM
async function appendMessageToDOM(type, text, time, saveToStorageFlag = false, chatIdForSave = null, customAvatarUrl = null, fileAttachment = null, modelName = null, msgUid = null, quoteRef = null, knowledgeSources = null, imageAttachments = null) {
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
            avatarHtml = `<img src="${avatarUrl}" style="width:50px; height:50px; border-radius:50%; object-fit:cover;">`;
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
        bubbleContent = renderMessageWithThink(text);
    } else {
        bubbleContent = `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
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
            const thumbSrc = img.dataUrl;                        // 缩略图（旧格式兼容：即为完整图）
            const fullSrc = img.fullDataUrl || img.dataUrl;      // 完整图用于点击放大
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
            showMessageActions(messageDiv, type, text, displayTime, saveToStorageFlag, chatIdForSave, customAvatarUrl, fileAttachment);
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
    conditionalScrollToBottom();
    
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
            const activeTopic = getActiveTopic(targetChat);
            if (activeTopic) {
                const msgUid = genMsgUid(type, text, time || getCurrentTime());
                activeTopic.messages.push({ type, text, time: time || getCurrentTime(), uid: msgUid });
                if (messageDiv) messageDiv.dataset.msgUid = msgUid;
                if (type === 'user') {
                    targetChat.date = new Date();
                    renderHistoryList();
                    await chatRepo.saveChat(targetChat);
                }
            }
        }
    }
}

// 向聊天区追加一张图片（支持 base64 或 URL）
async function appendImageToDOM(type, imgSrc, time, saveToStorageFlag = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;

    // 头像
    let avatarHtml = '<i class="fas fa-robot"></i>';
    if (type === 'ai') {
        const currentChat = chats.find(c => c.id == currentChatId);
        const avatarUrl = currentChat?.settings?.avatarUrl;
        avatarHtml = avatarUrl ? `<img src="${avatarUrl}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;">` 
                            : '<i class="fas fa-robot"></i>';
    } else {
        const userAvatar = SettingsManager.getAvatar();
        avatarHtml = (userAvatar && userAvatar.startsWith('data:image'))
            ? `<img src="${userAvatar}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;">`
            : '<i class="fas fa-user-astronaut"></i>';
    }

    // 气泡：图片 + 时间
    const imgTag = `<img src="${imgSrc}" class="message-image" alt="生成图片">`;
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
            modalManager.showFullscreenImage(imgSrc);
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
    conditionalScrollToBottom();

    // 持久化（消息对象里附带 isImage 和生成参数）
    if (saveToStorageFlag) {
        const targetChat = chats.find(c => c.id == currentChatId);
        if (targetChat) {
            const activeTopic = getActiveTopic(targetChat);
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
                renderHistoryList();
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
                appendMessageToDOM(msg.type, msg.text, msg.time, false, null, currentAvatarUrl, fileAttachment, msg.modelName || null, msg.uid, msg.quoteRef || null, msg.knowledgeSources || null, imageAttachments);
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
                    appendMessageToDOM(msg.type, msg.text, msg.time, false, null, currentAvatarUrl, fileAttachment, msg.modelName || null, msg.uid, msg.quoteRef || null, msg.knowledgeSources || null, imageAttachments);
                }
            });
        }
    }

    conditionalScrollToBottom();
}

function getTypingSpeed() {
    const slider = document.getElementById('global-typing-speed');
    return slider ? parseFloat(slider.value) || 1 : 1;
}

async function simulateAIResponse(userMsg, imageUrls = []) {
    // 🔒 请求开始：集中管理请求生命周期
    if (!acquireRequestLock()) {
        console.warn('已有请求正在处理，丢弃本次调用');
        return;
    }
    const currentChat = chats.find(c => c.id == currentChatId);
    if (!currentChat) {
        appendMessageToDOM('ai', '系统错误：无法找到当前对话。', getCurrentTime(), true);
        // 发生错误，释放锁
        releaseRequestLock();
        return;
    }
    updateStatusIndicator('thinking', '模型思考中 ...');
    const settings = currentChat.settings || Constants.DEFAULT_SETTINGS;
    const roleName = settings.roleName || Constants.DEFAULT_ROLE_NAME;
    const rolePersona = settings.persona || '';

    // 显示正在输入指示器
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message ai';
    typingDiv.innerHTML = `<div class="avatar-msg"><i class="fas fa-robot"></i></div><div class="bubble typing-bubble"><div class="typing-indicator"><i class="fas fa-ellipsis-h"></i> ${roleName} 正在思考...</div></div>`;
    chatMessages.appendChild(typingDiv);
    if (SettingsManager.getAutoScrollAfterSend()) scrollToBottom();

    try {
        // 获取对话历史（支持话题视图）
        let historyMessages = [];
        const topicIdx = getCurrentTopicIndex();
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
        // 系统提示中的用户名默认值与设置面板不同：系统提示用 '用户'，设置面板用 '访客'，保持原行为
        const userName = SettingsManager.getUsername() === Constants.DEFAULT_USERNAME ? '用户' : SettingsManager.getUsername();
        const userBio = SettingsManager.getBio();

        let systemPrompt = `你是一位角色扮演者，你的姓名是“ ${roleName} ”。关于你的角色简介是：\n\n${rolePersona ? rolePersona : ''}\n\n总之你需要始终以“ ${roleName} ”的身份和口吻回应\n\n`;
        if (userBio) systemPrompt += `关于和你对话的当前用户的名称是：${userName}，简介：${userBio}`;
        else systemPrompt += `关于和你对话的当前用户名称叫：${userName}。`;
        systemPrompt += '\n\n重要：请严格根据上述角色设定进行角色扮演，不要打破角色，不要以助手或AI的身份回答。必须始终以角色的身份和语气回复。\n\n回复格式规则：你的回复可以包含人物动作、环境描写、情绪描述等非语言表达内容，当你的回复中包含这样的的内容时，请使用括号（）将这些内容包裹起来。例如：“（轻轻叹气）我相信你能做到”。或“（窗外的雨声淅沥）今天的任务完成得不错。”';
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

        const SIMILARITY_THRESHOLD = Constants.SIMILARITY_THRESHOLD; // 相似度分数阈值（0~1）
        let finalUserMsg = null;
        let knowledgeSources = null;

        const selectedIdsStr = localStorage.getItem(Constants.STORAGE_KEYS.SELECTED_KB_IDS) || '';
        if (selectedIdsStr.trim() !== '') {
            const kbIds = selectedIdsStr.split(',').filter(id => id.trim());
            if (kbIds.length > 0) {
                try {
                    const kbResults = await retrieveKnowledge(kbIds, userMsg);
                    const relevant = kbResults.filter(item => (item.score || 0) >= SIMILARITY_THRESHOLD);
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
        let bubbleP = null;

        for await (const chunk of generator) {
            if (isFirstChunk) {
                // 第一次收到数据时，移除指示器并创建消息气泡
                if (typingDiv.parentNode) typingDiv.remove();
                // 创建消息气泡（复用原 createMessageBubble 或直接构建）
                const modelNameForDisplay = SettingsManager.getModelName();
                messageDiv = createMessageBubble('ai', '', getCurrentTime(), currentChat.settings?.avatarUrl, modelNameForDisplay, knowledgeSources);
                bubbleP = messageDiv.querySelector('.bubble p');
                bubbleP.innerHTML = '';  // 清空占位
                bubbleP.style.whiteSpace = 'pre-wrap';
                chatMessages.appendChild(messageDiv);
                if (SettingsManager.getAutoScrollAfterSend()) scrollToBottom();
                isFirstChunk = false;
            }
            fullReply += chunk;
            const span = document.createElement('span');
            span.className = 'fade-in-text';
            span.textContent = chunk;
            bubbleP.appendChild(span);
            conditionalScrollToBottom();
            
            // 控制打字速度
            const speed = getTypingSpeed();
            if (speed < 1) {
                await new Promise(resolve => setTimeout(resolve, (1 - speed) * 150));
            }
        }
        // 最终更新消息气泡内容（解析思考标签）
        const bubble = messageDiv.querySelector('.bubble');
        const showThinking = (currentChat.settings?.thinkLevel ?? 0) > 0;
        const newHtml = renderMessageWithThink(fullReply, showThinking);
        // 保留原有的模型名称（如果存在）
        const oldMsgTime = bubble.querySelector('.msg-time');
        let modelNameSpan = '';
        if (oldMsgTime) {
            const modelSpan = oldMsgTime.querySelector('span');
            if (modelSpan) {
                modelNameSpan = modelSpan.outerHTML;
            }
        }
        const newTimeHtml = `<div class="msg-time">${modelNameSpan}${getCurrentTime()}</div>`;

        const oldKbSources = bubble.querySelector('.kb-sources');
        let kbSourcesHtml = '';
        if (oldKbSources) {
            kbSourcesHtml = oldKbSources.outerHTML;
        } else if (knowledgeSources && knowledgeSources.length > 0) {
            // 如果当前消息有知识库引用但尚未渲染，则重新生成
            kbSourcesHtml = `<div class="kb-sources">` +
                knowledgeSources.map(src =>
                    `<span class="kb-source-tag" title="相似度: ${src.score}">
                        <i class="fas fa-database"></i> ${escapeHtml(src.filename)}
                    </span>`
                ).join('') +
                `</div>`;
        }

        bubble.innerHTML = newHtml + newTimeHtml + kbSourcesHtml;
        // 重新绑定气泡点击事件（因为 innerHTML 会清除原有监听）
        const newBubble = messageDiv.querySelector('.bubble');
        if (newBubble) {
            newBubble.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                showMessageActions(messageDiv, 'ai', fullReply, getCurrentTime(), false, null, currentChat.settings?.avatarUrl, null);
            });
        }
        if (SettingsManager.getAutoScrollAfterSend()) scrollToBottom();
        updateStatusIndicator('online');
        // 保存消息到存储
        const targetChat = chats.find(c => c.id == currentChatId);
        if (targetChat) {
            const activeTopic = getActiveTopic(targetChat);
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
                // 如果有知识库引用，添加该字段
                if (knowledgeSources && knowledgeSources.length > 0) {
                    msgData.knowledgeSources = knowledgeSources;
                }
                activeTopic.messages.push(msgData);
                targetChat.date = new Date();
                renderHistoryList();
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
                    updateStatusIndicator('speaking', '语音合成中 ...');
                    ttsService.speak(speechText, ttsVoice)
                        .finally(() => updateStatusIndicator('online'));;
                }
            }
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('流式请求已被取消');
        } else {
            console.error('模型调用失败:', error);
            updateStatusIndicator('offline', '离线 · 模型调用失败');

            appendMessageToDOM('ai', `❌ 模型调用失败：${error.message}\n请检查模型地址和 API Key 是否正确。`, getCurrentTime(), true);
        }
    } finally {
        // 🔓 请求结束，恢复输入并清理控制器
        if (typingDiv && typingDiv.parentNode) typingDiv.remove();
        releaseRequestLock();
    }
}

// 辅助函数：创建消息气泡（复用）
function createMessageBubble(type, text, time, avatarUrl, modelName = null, knowledgeSources = null) {
    const div = document.createElement('div');
    div.className = `message ${type}`;
    const avatarHtml = avatarUrl ? `<img src="${avatarUrl}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;">` : '<i class="fas fa-robot"></i>';
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
    if (isProcessing) {
        modalManager.showBriefToast('请等待当前回复完成后再发送');
        return;
    }
    // 如果当前为”显示全部话题”模式，自动切换到最后一个话题
    if (getCurrentTopicIndex() === null) {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (currentChat && currentChat.topics.length > 0) {
            await setCurrentTopic(currentChat.topics.length - 1, false);
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

    if (text === '' && !fileAttachment && imageAttachments.length === 0) return;

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
        const activeTopic = getActiveTopic(targetChat);
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
            renderHistoryList();
            await chatRepo.saveChat(targetChat);
        }
    }
    if (SettingsManager.getAutoScrollAfterSend()) forceScrollToBottom();
    // 渲染消息
    await appendMessageToDOM('user', text, userTime, false, null, null, fileAttachment, null, null, quoteRef || null, null, imageAttachments);
    messageInput.value = '';
    if (messageInput) messageInput.style.height = 'auto';
    simulateAIResponse(modelUserMsg, imageUrls);
}

async function createNewChat() {
    closeSidebarOnMobile();
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
        title: `新对话 ${chats.length+1}`,
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
    chats.unshift(newChat);
    setCurrentChatId(newId);
    renderHistoryList();
    renderMessages(currentChatId, 0);
    applyCurrentChatSettings();   // 应用新对话的设置（背景、名称等）
    await chatRepo.saveAllChats(chats);

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

function switchChat(chatId) {
    const modelService = getModelService();
    ttsService.stop();
    if (currentStatus === 'thinking' || currentStatus === 'speaking') {
        updateStatusIndicator('online');
    }
    // 检查是否有正在进行的流式回复
    if (modelService.isStreaming()) {
        if (confirm('当前对话正在生成回复，切换对话会中断当前回复。是否继续？')) {
            modelService.abortCurrentStream()
            // 释放请求锁（如果有）
            releaseRequestLock();
            ttsService.stop();
        } else {
            return;
        }
    }
    closeSidebarOnMobile();
    if (currentChatId == chatId) return;
    setCurrentChatId(chatId);
    // ✅ 使用 chat 自身存储的 currentTopicIndex，未设置时默认最后一个话题
    const chat = chats.find(c => c.id == chatId);
    if (chat) {
        if (chat.currentTopicIndex === undefined || chat.currentTopicIndex === null) {
            chat.currentTopicIndex = chat.topics.length > 0 ? chat.topics.length - 1 : null;
        }
    }
    renderHistoryList();
    renderMessages(currentChatId, getCurrentTopicIndex());
    applyCurrentChatSettings();
}

function attachHistoryClickEvents() {
    const items = document.querySelectorAll('.history-item');
    items.forEach(item => {
        item.removeEventListener('click', historyClickHandler);
        item.addEventListener('click', historyClickHandler);
    });
}

function historyClickHandler(e) {
    const targetItem = e.currentTarget;
    const chatId = parseInt(targetItem.getAttribute('data-id'));
    if (!isNaN(chatId)) {
        closeSidebarOnMobile();
        switchChat(chatId);
    }
}

// ==================== 初始化数据 ====================
async function initData() {
    // 应用已保存的字体大小
    applyFontSize(SettingsManager.getFontSize());
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
    }
    renderHistoryList();
    renderMessages(currentChatId, getCurrentTopicIndex());
    applyCurrentChatSettings();
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
    // 背景图片上传
    const bgUpload = document.getElementById('bg-upload');
    if (bgUpload) {
        bgUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            modalManager.showCropModal(file, NaN, { maxWidth: Constants.BG_CROP_MAX_WIDTH, mimeType: 'image/jpeg' }, (croppedDataUrl) => {
                const bgImgEl = document.getElementById('bg-img');
                if (bgImgEl) { bgImgEl.src = croppedDataUrl; bgImgEl.setAttribute('data-custom', 'true'); }
                // 确保 bg-type 切换到静态图片
                const bgTypeSel = document.getElementById('bg-type');
                if (bgTypeSel) bgTypeSel.value = 'image';
                document.getElementById('bg-image-section').style.display = 'block';
                // 实时预览
                BackgroundManager.apply({ bgType: 'image', bgImageUrl: croppedDataUrl });
            });
        });
    }

    // 头像上传
    const avatarUpload = document.getElementById('global-avatar-upload');
    if (avatarUpload) {
        avatarUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const compressedUrl = await compressImage(file, Constants.AVATAR_MAX_WIDTH, Constants.AVATAR_JPEG_QUALITY);
                document.getElementById('global-avatar-img').src = compressedUrl;
            } catch (err) {
                console.error('头像压缩失败', err);
                modalManager.customAlert('头像处理失败，请重试', 'error');
            }
        });
    }

    // 文件上传 / 清除 / 语音
    const uploadBtn = document.getElementById('upload-file-btn');
    if (uploadBtn) uploadBtn.addEventListener('click', () => fileUpload.selectFileOrImage());
    const removeFileBtn = document.getElementById('remove-file-btn');
    if (removeFileBtn) removeFileBtn.addEventListener('click', () => fileUpload.clearFile());
    const voiceBtn = document.getElementById('voice-input-btn');
    if (voiceBtn) voiceBtn.addEventListener('click', startVoiceInput);

    // 粘贴图片（Ctrl+V）
    const chatInput = document.querySelector('.auto-expand-textarea');
    if (chatInput) {
        chatInput.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    fileUpload.handleFile(file);
                }
            }
        });
    }

    // 拖拽上传
    const dropZone = document.querySelector('.chat-messages');
    if (dropZone) fileUpload.setupDragAndDrop(dropZone);

    // 知识库选择
    const kbSelectBtn = document.getElementById('kb-select-btn');
    if (kbSelectBtn) kbSelectBtn.addEventListener('click', () => modalManager.openKnowledgeBaseSelector());

    // 折叠按钮（PC 展开/收起 + 移动端弹出菜单）
    bindCollapseToggle();

    // 图片生成
    bindImageGeneration();

    // 点击消息中的图片放大查看
    const chatMessages = document.querySelector('.chat-messages');
    if (chatMessages) {
        chatMessages.addEventListener('click', (e) => {
            const img = e.target.closest('.message-image');
            if (!img) return;
            // 优先使用完整图（data-full-img），回退到 src（旧格式兼容）
            const src = img.dataset.fullImg || img.src;
            if (!src) return;
            // 全屏预览
            const overlay = document.createElement('div');
            overlay.className = 'fullscreen-overlay';
            overlay.innerHTML = `<img src="${src}" style="max-width:90vw;max-height:90vh;border-radius:12px;box-shadow:0 0 40px rgba(0,0,0,0.6);">`;
            overlay.addEventListener('click', () => overlay.remove());
            document.body.appendChild(overlay);
        });
    }
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
    overlay.className = 'mobile-collapse-overlay';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.4); z-index: 9999;
        display: flex; align-items: flex-end; justify-content: center;
        animation: fadeIn 0.2s ease;
    `;

    const menu = document.createElement('div');
    menu.className = 'mobile-collapse-menu';
    menu.style.cssText = `
        background: rgba(20,24,45,0.95); backdrop-filter: blur(12px);
        border-radius: 20px 20px 0 0; padding: 20px 16px 30px;
        width: 100%; max-width: 500px;
        box-shadow: 0 -8px 30px rgba(0,0,0,0.5);
        animation: slideUp 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
        display: flex; flex-direction: column; gap: 12px;
    `;

    btns.forEach((btnData) => {
        const btn = document.createElement('button');
        btn.className = 'action-btn mobile-collapse-item';
        btn.style.cssText = `
            width: 100%; padding: 14px 16px; justify-content: center;
            font-size: 1rem; border-radius: 16px;
            background: rgba(30,34,55,0.6);
            border: 1px solid rgba(100,130,255,0.3);
            color: #f0f3ff; cursor: pointer; transition: 0.2s;
        `;
        btn.innerHTML = btnData.label;
        btn.addEventListener('click', () => {
            const originalBtn = document.getElementById(btnData.id);
            if (originalBtn) originalBtn.click();
            closeMobileMenu();
        });
        menu.appendChild(btn);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'action-btn';
    closeBtn.style.cssText = `
        width: 100%; padding: 12px; justify-content: center;
        background: rgba(255,80,80,0.15);
        border: 1px solid rgba(255,80,80,0.3);
        border-radius: 16px; color: #ff8a7a;
        cursor: pointer; font-size: 0.9rem; margin-top: 8px;
    `;
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

    if (!document.getElementById('mobile-collapse-styles')) {
        const style = document.createElement('style');
        style.id = 'mobile-collapse-styles';
        style.textContent = `
            @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        `;
        document.head.appendChild(style);
    }
}

// —— 图片生成弹窗及生成逻辑 ——
function bindImageGeneration() {
    const genImgBtn = document.getElementById('generate-image-btn');
    if (genImgBtn) {
        genImgBtn.addEventListener('click', () => {
            const modal = document.getElementById('image-gen-modal');
            if (modal) modal.style.display = 'flex';
        });
    }

    const closeBtn = document.getElementById('close-image-gen-modal');
    const cancelBtn = document.getElementById('cancel-image-gen-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => { document.getElementById('image-gen-modal').style.display = 'none'; });
    if (cancelBtn) cancelBtn.addEventListener('click', () => { document.getElementById('image-gen-modal').style.display = 'none'; });

    const imageGenModal = document.getElementById('image-gen-modal');
    if (imageGenModal) {
        // 防止拖选文本时误关闭
        let _imgGenMousedownOnOverlay = false;
        imageGenModal.addEventListener('mousedown', (e) => { _imgGenMousedownOnOverlay = (e.target === imageGenModal); });
        imageGenModal.addEventListener('click', (e) => { if (e.target === imageGenModal && _imgGenMousedownOnOverlay) imageGenModal.style.display = 'none'; });
    }

    const startBtn = document.getElementById('start-image-gen-btn');
    if (startBtn) startBtn.addEventListener('click', onStartImageGen);
}

async function onStartImageGen() {
    if (isProcessing) {
        modalManager.customAlert('AI 正在回复中，请等待完成后再生成图片。', 'warning');
        return;
    }
    const prompt = document.getElementById('image-gen-prompt').value;
    if (!prompt) { modalManager.customAlert('请输入图片描述'); return; }

    const negative = document.getElementById('image-gen-negative').value;
    const size = document.getElementById('image-gen-ratio').value;
    const count = parseInt(document.getElementById('image-gen-count').value);
    const model = document.getElementById('image-gen-model').value;
    const imgApiUrl = SettingsManager.getImgApiUrl();
    const imgApiKey = SettingsManager.getImgApiKey();
    const headers = { 'Content-Type': 'application/json' };
    if (imgApiKey) headers['X-API-Key'] = imgApiKey;

    document.getElementById('image-gen-modal').style.display = 'none';
    await appendMessageToDOM('ai', `🎨 正在生成 ${count} 张图片...`, getCurrentTime(), false);
    if (SettingsManager.getAutoScrollAfterSend()) forceScrollToBottom();

    try {
        const response = await fetch(`${imgApiUrl}/generate_image`, {
            method: 'POST', headers,
            body: JSON.stringify({ prompt, negative, size, count, model })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '生成失败');
        for (const imgB64 of data.images) {
            const imgSrc = imgB64.startsWith('data:') ? imgB64 : `data:image/png;base64,${imgB64}`;
            await appendImageToDOM('ai', imgSrc, getCurrentTime(), true);
        }
    } catch (error) {
        appendMessageToDOM('ai', `❌ 图片生成失败: ${error.message}`, getCurrentTime(), true);
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
    if (modal) modalManager.bindModalOverlayClose(modal, () => modalManager.closeModalWithAnimation(modal));

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
    if (newTopicModalBtn) newTopicModalBtn.addEventListener('click', () => { startNewTopic(); modalManager.closeTopicsModal(); });

    const showAllTopicsBtn = document.getElementById('show-all-topics-btn');
    if (showAllTopicsBtn) showAllTopicsBtn.addEventListener('click', async () => { await setCurrentTopic(null); modalManager.closeTopicsModal(); });

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
    bindQuickModelSwitch();
}

// —— 对话操作：新建 / 导入 / 滚动 / 返回全部 / 引用关闭 / 搜索 / 添加模型 ——
function bindChatActions() {
    const newChatBtn = document.querySelector('.new-chat-btn');
    if (newChatBtn) newChatBtn.addEventListener('click', createNewChat);

    // 导入 JSON
    const importBtn = document.querySelector('.import-chat-btn');
    if (importBtn) {
        importBtn.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'application/json';
            fileInput.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    try {
                        const importedData = JSON.parse(ev.target.result);
                        const newChat = await chatIO.importFromJSON(importedData, chats);
                        chats.unshift(newChat);
                        setCurrentChatId(newChat.id);
                        setCurrentTopicIndex(null);
                        renderHistoryList();
                        renderMessages(currentChatId);
                        applyCurrentChatSettings();
                        await chatRepo.saveAllChats(chats);
                        modalManager.customAlert('导入成功', 'success');
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
    if (chatMessages) chatMessages.addEventListener('scroll', updateAutoScrollFlag);

    // 返回全部话题
    const backBtn = document.getElementById('back-to-all-topics');
    if (backBtn) backBtn.addEventListener('click', async () => { await setCurrentTopic(null, false); });

    // 引用消息关闭
    const quoteCloseBtn = document.getElementById('quote-indicator-close');
    if (quoteCloseBtn) quoteCloseBtn.addEventListener('click', () => msgActions.clearQuoteRef());

    // 添加模型
    const addModelBtn = document.getElementById('add-model-btn');
    if (addModelBtn) {
        addModelBtn.addEventListener('click', () => {
            const newModel = document.getElementById('new-model-name').value;
            if (addModel(newModel)) document.getElementById('new-model-name').value = '';
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
}

// 开启新话题（创建独立话题对象 + 开场白）
async function startNewTopic() {
    const modelService = getModelService();
    if (modelService.isStreaming()) {
        if (confirm('当前正在生成回复，开启新话题会中断本次回复。是否继续？')) {
            modelService.abortCurrentStream();
            releaseRequestLock();
            ttsService.stop();
        } else {
            return;
        }
    }
    const currentChat = chats.find(c => c.id == currentChatId);
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
    await setCurrentTopic(newTopicIndex, false);

    // 刷新左侧历史列表
    currentChat.date = new Date();
    renderHistoryList();
    await chatRepo.saveChat(currentChat);

    // 如果当前对话开启语音合成，则朗读开场白（跳过括号内的非语言内容）
    if (settings.ttsEnabled) {
        const { replyContent } = parseThinkContent(greeting);
        const contentToSpeak = replyContent || greeting;
        const parts = parseParenthesesContent(contentToSpeak);
        const speechText = parts.filter(p => p.type === 'speech').map(p => p.text).join('');
        if (speechText.trim()) {
            const ttsVoice = currentChat?.settings?.ttsVoice || 'default';
            updateStatusIndicator('speaking', '语音合成中 ...');
            ttsService.speak(speechText, ttsVoice)
                .finally(() => updateStatusIndicator('online'));
        }
    }
}

// 为每个历史项绑定菜单弹出逻辑
function attachMenuEvents(historyItem, chat) {
    const trigger = historyItem.querySelector('.history-menu-trigger');
    if (!trigger) return;
    let currentMenu = null;
    let scrollCloseHandler = null;
    
    const closeMenu = () => {
        if (currentMenu && currentMenu.parentNode) currentMenu.remove();
        currentMenu = null;
        document.removeEventListener('click', outsideClickListener);
        if (scrollCloseHandler && historyList) {
            historyList.removeEventListener('scroll', scrollCloseHandler);
            scrollCloseHandler = null;
        }
    };
    
    const outsideClickListener = (e) => {
        if (!historyItem.contains(e.target) && currentMenu && !currentMenu.contains(e.target)) {
            closeMenu();
        }
    };
    
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentMenu) {
            closeMenu();
            return;
        }
        // 获取触发按钮的位置
        const rect = trigger.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
        // 创建菜单
        const menu = document.createElement('div');
        menu.className = 'history-menu';
        const pinText = chat.pinned ? '取消置顶' : '收藏置顶';
        const pinIcon = chat.pinned ? 'fa-thumbtack' : 'fa-thumbtack';
        menu.innerHTML = `
            <div class="history-menu-item" data-action="export-json">
                <i class="fas fa-download"></i> 导出 JSON
            </div>
            <div class="history-menu-item" data-action="export-html">
                <i class="fas fa-file-code"></i> 导出 HTML
            </div>
            <div class="history-menu-item" data-action="pin">
                <i class="fas ${pinIcon}"></i> ${pinText}
            </div>
            <div class="history-menu-item delete-item" data-action="delete">
                <i class="fas fa-trash-alt"></i> 删除会话
            </div>
        `;
        // 设置菜单位置（默认在触发按钮下方右对齐）
        menu.style.position = 'absolute';
        menu.style.top = `${rect.bottom + scrollTop + 4}px`;
        menu.style.left = `${rect.right + scrollLeft - 140}px`; // 菜单宽度约140px
        menu.style.zIndex = '10001';
        document.body.appendChild(menu);
        currentMenu = menu;
        // 边界检测：防止菜单超出视口右侧
        const menuRect = menu.getBoundingClientRect();
        if (menuRect.right > window.innerWidth) {
            menu.style.left = `${window.innerWidth - menuRect.width - 10 + scrollLeft}px`;
        }
        // 边界检测：防止菜单超出视口底部
        if (menuRect.bottom > window.innerHeight) {
            menu.style.top = `${rect.top + scrollTop - menuRect.height - 4}px`;
        }
        
        // 绑定菜单项点击
        menu.querySelectorAll('.history-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.getAttribute('data-action');
                if (action === 'export-json') chatIO.exportAsJSON(chat);
                else if (action === 'export-html') chatIO.exportAsHTML(chat);
                else if (action === 'pin') togglePinChat(chat);
                else if (action === 'delete') deleteChat(chat.id);
                closeMenu();
            });
        });
        
        // 绑定滚动关闭：滚动历史列表时关闭菜单
        scrollCloseHandler = () => closeMenu();
        historyList.addEventListener('scroll', scrollCloseHandler);
        // 点击外部关闭
        setTimeout(() => {
            document.addEventListener('click', outsideClickListener);
        }, 0);
    });
}

// 收藏置顶（将对话移到列表最上方）
async function togglePinChat(chat) {
    chat.pinned = !chat.pinned;
    // 重新排序并渲染列表
    renderHistoryList();
    await chatRepo.saveChat(chat);
    modalManager.showBriefToast(chat.pinned ? '📌 已置顶该会话' : '📍 已取消置顶')
}

// 删除会话
async function deleteChat(chatId) {
    if (chats.length === 1) {
        modalManager.customAlert('至少保留一个对话，无法删除最后一个。', 'warn');
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

    // 实际的删除逻辑
    async function performDelete(id) {
        const index = chats.findIndex(c => c.id === id);
        if (index !== -1) {
            chats.splice(index, 1);
            if (currentChatId === id) {
                setCurrentChatId(chats[0].id);
                setCurrentTopicIndex(null);
                renderMessages(currentChatId);
                applyCurrentChatSettings();
            }
        }
        renderHistoryList();       // 重新渲染列表（此时已无删除动画，会平滑出现）
        await chatRepo.saveAllChats(chats);

        // 提示
        modalManager.showBriefToast('🗑️ 会话已删除')
    }
}

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

async function generateTopicSummary(topicIndex, topicMessages) {
    const currentChat = chats.find(c => c.id == currentChatId);
    if (!currentChat) return null;
    
    // 提取话题中所有用户和AI的消息文本
    const conversationText = topicMessages.map(msg => `${msg.type === 'user' ? '用户' : '助手'}：${msg.text}`).join('\n');
    if (!conversationText.trim()) return '（无内容）';
    
    const prompt = `请为以下对话生成一句简短的摘要（10-30字），简明扼要地概括主要内容：\n${conversationText}`;
    
    const modelService = getModelService();
    try {
        const summary = await modelService.generateText(prompt, { temperature: 0.3, maxTokens: 100 });
        return summary.trim() || '生成失败';
    } catch (err) {
        console.error('生成简介失败', err);
        return '生成失败，请检查模型配置';
    }
}

async function setCurrentTopic(topicIndex) {
    const modelService = getModelService();
    if (modelService.isStreaming()) {
        if (confirm('正在生成回复，切换话题会中断当前回复。是否继续？')) {
            modelService.abortCurrentStream();
            // 释放请求锁
            releaseRequestLock();
            ttsService.stop();
        } else {
            return;
        }
    }

    const messagesContainer = chatMessages;
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
    setCurrentTopicIndex(topicIndex);
    renderMessages(currentChatId, topicIndex);

    // 4. 为新消息添加跌落动画（错开延迟）
    const newMessages = Array.from(messagesContainer.children).filter(
        child => child.classList && (child.classList.contains('message') || child.classList.contains('topic-divider'))
    );
    newMessages.forEach((msg, idx) => {
        msg.classList.add('topic-drop-in');
        msg.style.animationDelay = `${idx * 0.05}s`;
    });

    // 6. 动画结束后清理样式
    // 先给当前消息加上 no-animation 防止移除 no-entry-animation 时重新触发入场动画
    setTimeout(() => {
        newMessages.forEach(msg => {
            msg.classList.remove('topic-drop-in');
            msg.classList.add('no-animation');
            msg.style.animationDelay = '';
        });
        messagesContainer.classList.remove('no-entry-animation');
    }, 500);
}

// 应用主题（明亮/暗黑）
function applyTheme(theme) {
    // 计算实际应使用的主题（亮色/暗色）
    let effectiveTheme = theme;
    if (theme === 'auto') {
        effectiveTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    
    if (effectiveTheme === 'light') {
        document.body.classList.add('light-theme');
    } else {
        document.body.classList.remove('light-theme');
    }
    
    // 同步下拉框的值（如果与传入的 theme 不同，说明是 auto 触发的实际显示，但下拉框保留 auto）
    const themeSelect = document.getElementById('global-theme');
    if (themeSelect && themeSelect.value !== theme) {
        themeSelect.value = theme;
    }
}

function applyFontSize(size) {
    let fontSizeValue = '14px';
    if (size === 'small') fontSizeValue = '12px';
    else if (size === 'large') fontSizeValue = '16px';
    else fontSizeValue = '14px';
    
    // 移除旧的 style 标签，重新添加确保优先级
    const styleId = 'dynamic-font-size-style';
    const oldStyle = document.getElementById(styleId);
    if (oldStyle) oldStyle.remove();
    
    const styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.textContent = `
        .chat-messages .bubble p {
            font-size: ${fontSizeValue} !important;
            line-height: 1.5 !important;
            white-space: pre-wrap;
        }
        .chat-messages .bubble {
            font-size: ${fontSizeValue} !important;
        }
        .message .bubble p {
            font-size: ${fontSizeValue} !important;
        }
    `;
    document.head.appendChild(styleEl);
    
    // 强制重绘当前聊天区域（可选，确保所有消息重新计算样式）
    if (chatMessages) {
        chatMessages.style.display = 'none';
        chatMessages.offsetHeight; // 强制重排
        chatMessages.style.display = '';
    }
}

// 状态指示器控制
function updateStatusIndicator(state, customText = null) {
    const statusTextElem = document.querySelector('.user-details p');
    if (!statusTextElem) return;
    currentStatus = state; 
    
    const dotIcon = statusTextElem.querySelector('i');
    let dotHtml = '';
    let text = '';
    
    switch (state) {
        case 'online':
            dotHtml = '<i class="fas fa-circle" style="color: #2effb0; font-size: 0.6rem; text-shadow: 0 0 3px #2effb0;"></i>';
            text = customText || '在线 · AI 智能体';
            break;
        case 'thinking':
            dotHtml = '<i class="fas fa-spinner fa-pulse" style="color: #ffd966; font-size: 0.6rem;"></i>';
            text = customText || '思考中 ...';
            break;
        case 'speaking':
            dotHtml = '<i class="fas fa-volume-up fa-fade" style="color: #5f7eff; font-size: 0.6rem;"></i>';
            text = customText || '语音生成中 ...';
            break;
        case 'offline':
            dotHtml = '<i class="fas fa-circle" style="color: #ff5c4a; font-size: 0.6rem;"></i>';
            text = customText || '离线 · 连接失败';
            break;
        default:
            return;
    }
    
    statusTextElem.innerHTML = `${dotHtml} ${text}`;
}

// 切换到上一个/下一个对话（在chats数组中按排序顺序）
function switchToPreviousChat() {
    // 按置顶 + 时间倒序排列（与 renderHistoryList 相同）
    const sorted = [...chats].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.date - a.date;
    });
    const idx = sorted.findIndex(c => c.id == currentChatId);
    if (idx > 0) switchChat(sorted[idx - 1].id);
}

function switchToNextChat() {
    const sorted = [...chats].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.date - a.date;
    });
    const idx = sorted.findIndex(c => c.id == currentChatId);
    if (idx < sorted.length - 1) switchChat(sorted[idx + 1].id);
}

// 聚焦聊天输入框
function focusChatInput() {
    const textarea = document.querySelector('.auto-expand-textarea');
    if (textarea) {
        textarea.focus();
    }
}

// 发送消息但不触发 AI 回复
async function sendMessageWithoutAI() {
    if (isProcessing) {
        modalManager.customAlert('AI 正在回复中，请稍候...', 'warning');
        return;
    }
    // 如果当前为”显示全部话题”模式，自动切换到最后一个话题
    if (getCurrentTopicIndex() === null) {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (currentChat && currentChat.topics.length > 0) {
            await setCurrentTopic(currentChat.topics.length - 1, false);
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
        const activeTopic = getActiveTopic(targetChat);
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
            renderHistoryList();
            await chatRepo.saveChat(targetChat);
        }
    }
    await appendMessageToDOM('user', text, userTime, false, null, null, fileAttachment, null, null, quoteRef || null);
    messageInput.value = '';
    messageInput.style.height = 'auto';
    if (SettingsManager.getAutoScrollAfterSend()) forceScrollToBottom();
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

// 恢复上次选中的知识库
function restoreSelectedKnowledgeBase() {
    const namesStr = localStorage.getItem(Constants.STORAGE_KEYS.SELECTED_KB_NAMES);
    const label = document.getElementById('kb-btn-label');
    if (!label) return;
    if (namesStr && namesStr.trim() !== '') {
        const names = namesStr.split(',');
        if (names.length === 1) {
            const name = names[0];
            label.textContent = name.length > 8 ? name.substring(0, 8) + '…' : name;
            label.title = name;
        } else {
            label.textContent = `📚 ${names.length}个`;
            label.title = names.join('、');
        }
    } else {
        label.textContent = '选择知识库';
        label.title = '';
    }
}

/**
 * 从多个知识库中检索与查询相关的文档片段
 * @param {string[]} kbIds - 知识库ID列表
 * @param {string} query - 用户查询文本
 * @returns {Promise<Array<{content: string, filename: string, score: number}>>}
 */
async function retrieveKnowledge(kbIds, query) {
    const base = modalManager.kbManager.apiBase;
    const promises = kbIds.map(async (kbId) => {
        try {
            const response = await fetch(`${base}/knowledge_bases/${kbId}/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, top_k: Constants.KB_TOP_K })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            return (data.results || []).map(item => ({
                content: item.content,
                filename: item.filename || '未知',
                score: item.score || 0
            }));
        } catch (err) {
            console.warn(`知识库 ${kbId} 检索失败:`, err);
            return [];
        }
    });
    const allResults = await Promise.all(promises);
    const merged = allResults.flat();
    merged.sort((a, b) => (b.score || 0) - (a.score || 0));
    return merged.slice(0, Constants.KB_MAX_RESULTS); // 最多取N条
}

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

    loadModelListAndInit();
    await initData();
    applyTheme(SettingsManager.getTheme());
    initResizer();
    shortcutManager.init();
    bindEvents();
    getModelService();
    renderModelListUI();      // 渲染模型列表弹窗
    updateModelSelector();    // 更新快速切换下拉框
    // 初始化背景（自动判断全局视频 / 对话静态图 / 默认 SVG）
    applyCurrentChatSettings();
    // 清理旧版单 key 视频残留（之前用 'bg-video' 存的，现在已改为 'bg-video-{chatId}'）
    AssetStore.cleanupOrphaned().catch(() => {});
    restoreSelectedKnowledgeBase();

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
