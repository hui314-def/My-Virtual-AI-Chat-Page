// 聊天页面核心交互功能
import { 
    escapeHtml, getCurrentTime, formatDate, parseThinkContent,renderMessageWithThink, 
    parseParenthesesContent, compressImage, normalizeShortcut,parseShortcut, eventToShortcutString, isBrowserReserved,
} from './js/utils.js';
import Constants from './js/constants.js'
import { ModelService } from './js/model-service.js';
import { ChatRepository } from './js/repository.js';
import { TTsService } from './js/tts-service.js';
import { ChatIO } from './js/chat-io.js';
import { FileUploadService } from './js/file-upload.js';

let cachedCSS = '';
try {
    const cssRes = await fetch('style.css');
    if (cssRes.ok) cachedCSS = await cssRes.text();
    chatIO.updateCachedCSS(cachedCSS);
} catch(e) {}

const DB_NAME = Constants.DB_NAME;
const DB_VERSION = Constants.DB_VERSION;
const STORE_NAME = Constants.STORE_NAME;
const DEFAULT_SHORTCUTS = Constants.DEFAULT_SHORTCUTS
const chatRepo = new ChatRepository();
const ttsService = new TTsService();
const chatIO = new ChatIO({
    saveAllChats: (chats) => chatRepo.saveAllChats(chats),  // 传递保存函数
    cachedCSS: cachedCSS
});
const fileUpload = new FileUploadService({
    previewArea: document.getElementById('file-preview-area'),
    fileNameSpan: document.getElementById('file-name'),
    alertFn: (msg, type) => customAlert(msg, type)
});

let chats = [];
let currentChatId = null;
let currentTopicIndex = null;
let autoScrollEnabled = true;     // 是否允许自动滚动
let searchDebounceTimer = null;
let globalModal = null;
let currentActionClickHandler = null;
let currentActionScrollHandler = null;
let isProcessing = false;   // 请求进行中（包括发送到模型返回全过程的锁）
let currentStatus = 'online';   // 记录当前指示器状态
let cropper = null;
let currentShortcuts = {};  // 当前生效的快捷键映射
let modelServiceInstance = null;
let currentActionMsgElement = null;
let currentActionMenu = null;
let currentPictureMenu = null;
let currentPictureMsgElement = null;

function getModelService() {
    if (!modelServiceInstance) {
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        modelServiceInstance = new ModelService({
            modelHost: globalSettings.modelHost || Constants.DEFAULT_MODEL_HOST,
            apiKey: globalSettings.apiKey || '',
            modelName: globalSettings.modelName || Constants.DEFAULT_MODEL_NAME,
        });
    }
    return modelServiceInstance;
}

function setCurrentChatId(id) { 
    currentChatId = id;
    localStorage.setItem('last_chat_id', id);
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

function scrollToBottom() {
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
}

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
            const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
            globalSettings.modelName = modelName;
            localStorage.setItem('global_settings', JSON.stringify(globalSettings));
            // 更新全局设置弹窗中的模型名称输入框
            const modelNameInput = document.getElementById('global-model-name');
            if (modelNameInput) modelNameInput.value = modelName;
            // 刷新快速切换下拉菜单
            updateModelSelector();
            customAlert(`已切换到模型：${modelName}`, 'success');
        });
    });
    document.querySelectorAll('.delete-model-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const modelName = btn.getAttribute('data-model');
            const currentModels = ModelService.getModels();
            if (currentModels.length === 1) {
                customAlert('至少保留一个模型');
                return;
            }
            ModelService.removeModel(modelName);
            renderModelListUI();      // 刷新列表
            updateModelSelector();    // 刷新下拉框
            // 如果删除的是当前使用的模型，则自动切换到列表第一个
            const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
            if (globalSettings.modelName === modelName) {
                globalSettings.modelName = models[0];
                localStorage.setItem('global_settings', JSON.stringify(globalSettings));
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
    const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
    const currentModel = globalSettings.modelName || Constants.DEFAULT_MODEL_NAME;
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
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        globalSettings.modelName = newModel;
        localStorage.setItem('global_settings', JSON.stringify(globalSettings));
        // 同步更新全局设置弹窗中的输入框
        const modelNameInput = document.getElementById('global-model-name');
        if (modelNameInput) modelNameInput.value = newModel;
        // 可选：显示提示
        const toast = document.createElement('div');
        toast.textContent = `已切换到模型：${newModel}`;
        toast.style.cssText = 'position:fixed; bottom:80px; right:20px; background:#2a2f55; color:white; padding:8px 16px; border-radius:20px; z-index:10000;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    });
}

// 添加模型
function addModel(modelName) {
    if (ModelService.addModel(modelName)) {
        renderModelListUI();
        updateModelSelector();
        return true;
    }
    return false;
}

// 左侧边栏拖动调整宽度
function initResizer() {
    if (window.innerWidth <= 768) return; // 移动端不启用拖动
    const resizer = document.querySelector('.resizer');
    const sidebar = document.querySelector('.sidebar');
    if (!resizer || !sidebar) return;

    let startX, startWidth;
    let isDragging = false;

    // 从 localStorage 恢复宽度
    const savedWidth = localStorage.getItem('sidebar-width');
    if (savedWidth && !isNaN(parseInt(savedWidth))) {
        sidebar.style.width = `${savedWidth}px`;
    }

    function onMouseMove(e) {
        if (!isDragging) return;
        e.preventDefault();   // 阻止默认行为（重要）
        let newWidth = startWidth + (e.clientX - startX);
        newWidth = Math.min(500, Math.max(220, newWidth));
        sidebar.style.width = `${newWidth}px`;
        localStorage.setItem('sidebar-width', newWidth);
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

// ==================== 动态注入弹窗样式 ====================
const modalStyles = Constants.MODAL_STYLES;
const styleSheet = document.createElement("style");
styleSheet.textContent = modalStyles;
document.head.appendChild(styleSheet);

// ==================== 动态创建弹窗 HTML ====================
const modalHTML = Constants.MODAL_HTML;
document.body.insertAdjacentHTML('beforeend', modalHTML);

// ==================== DOM 元素绑定 ====================
const historyList = document.querySelector('.history-list');
const newChatBtn = document.querySelector('.new-chat-btn');
const settingBtn = document.querySelector('.setting-btn');
const chatMessages = document.querySelector('.chat-messages');
const messageInput = document.querySelector('.auto-expand-textarea');
const sendBtn = document.querySelector('.send-btn');


// 从 IndexedDB 加载
async function loadFromStorage() {
    try {
        const storedChats = await chatRepo.loadAllChats();
        if (storedChats && storedChats.length > 0) {
            // 恢复日期对象（JSON 序列化会丢失 Date 类型）
            return storedChats.map(chat => ({
                ...chat,
                date: new Date(chat.date),
                messages: chat.messages.map(msg => ({ ...msg })),
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
    // 更新聊天背景
    const mainChat = document.querySelector('.main-chat');
    if (settings.bgUrl) {
        mainChat.style.backgroundImage = `linear-gradient(0deg, rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0.55)), url(${settings.bgUrl})`;
        mainChat.style.backgroundSize = 'cover';
        mainChat.style.backgroundPosition = 'center';
    } else {
        // 恢复默认背景（保持原有 SVG）
        mainChat.style.backgroundImage = `linear-gradient(0deg, rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0.55)), url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 1600'%3E%3Cdefs%3E%3ClinearGradient id='grad' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%232a2e5a'/%3E%3Cstop offset='100%25' stop-color='%2312152c'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='100%25' height='100%25' fill='url(%23grad)'/%3E%3Ccircle cx='600' cy='600' r='280' fill='%23333b6e' opacity='0.3'/%3E%3Cpath d='M520,460 L680,460 L720,540 L680,620 L520,620 L480,540 Z' fill='%235f7eff' opacity='0.45'/%3E%3Ccircle cx='600' cy='540' r='38' fill='%23aac0ff' opacity='0.6'/%3E%3Ccircle cx='550' cy='520' r='8' fill='white'/%3E%3Ccircle cx='650' cy='520' r='8' fill='white'/%3E%3Cpath d='M570 580 Q600 620 630 580' stroke='%23f0f3ff' stroke-width='5' fill='none' stroke-linecap='round' opacity='0.7'/%3E%3Ctext x='600' y='800' font-size='42' font-family='monospace' fill='%23ffffff80' text-anchor='middle'%3E⚡ AI CORE ⚡%3C/text%3E%3C/svg%3E") center/cover no-repeat`;
    }
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
        const roleName = settings.roleName || 'Nova';
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
async function appendMessageToDOM(type, text, time, saveToStorageFlag = false, chatIdForSave = null, customAvatarUrl = null, fileAttachment = null, modelName = null) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;
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
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        const userAvatar = globalSettings.avatar;
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
    
    messageDiv.innerHTML = `
        <div class="avatar-msg">${avatarHtml}</div>
        <div class="bubble">${bubbleContent}</div>
    `;
    
    const aiAvatar = messageDiv.querySelector('.avatar-msg');
    if (type === 'ai' && aiAvatar) {
        aiAvatar.style.cursor = 'pointer';
        aiAvatar.addEventListener('click', (e) => {
            e.stopPropagation();
            openSettingsModal();   // 复用已有的打开对话设置函数
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

    chatMessages.appendChild(messageDiv);
    conditionalScrollToBottom();
    
    // 绑定文件点击事件
    if (type === 'user' && fileAttachment) {
        const fileElem = messageDiv.querySelector('.file-attachment');
        if (fileElem) {
            fileElem.addEventListener('click', () => {
                showFileContentModal(fileAttachment.name, fileAttachment.content);
            });
        }
    }
    if (saveToStorageFlag) {
        const targetChatId = chatIdForSave || currentChatId;
        const targetChat = chats.find(c => c.id == targetChatId);
        if (targetChat) {
            targetChat.messages.push({ type, text, time: time || getCurrentTime() });
            if (type === 'user') {
                targetChat.date = new Date();
                renderHistoryList();
                await chatRepo.saveChat(targetChat);  // 保存单个对话（注意不要传入整个数组）
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
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        const userAvatar = globalSettings.avatar;
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
            showFullscreenImage(imgSrc);
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
            targetChat.messages.push({
                type,
                text: imgSrc,
                isImage: true,
                time: time || getCurrentTime(),
            });
            targetChat.date = new Date();
            renderHistoryList();
            await chatRepo.saveChat(targetChat);
        }
    }
}

function showPictureActions(msgElement, msgData) {
    // 关闭已有菜单
    if (currentPictureMenu) {
        currentPictureMenu.remove();
        currentPictureMenu = null;
    }
    const bubble = msgElement.querySelector('.bubble');
    if (!bubble) return;

    const rect = bubble.getBoundingClientRect();
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';
    // 仅保留保存和删除
    actionsDiv.innerHTML = `
        <button class="save-pic-btn"><i class="fas fa-download"></i> 保存</button>
        <button class="delete-btn"><i class="fas fa-trash-alt"></i> 删除</button>
    `;
    document.body.appendChild(actionsDiv);
    currentPictureMenu = actionsDiv;
    currentPictureMsgElement = msgElement;

    // 定位
    actionsDiv.style.top = `${rect.bottom + scrollTop + 8}px`;
    actionsDiv.style.left = `${rect.left + scrollLeft}px`;
    const actionsRect = actionsDiv.getBoundingClientRect();
    if (actionsRect.right > window.innerWidth) {
        actionsDiv.style.left = `${window.innerWidth - actionsRect.width - 10 + scrollLeft}px`;
    }

    // 保存图片
    const saveBtn = actionsDiv.querySelector('.save-pic-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const a = document.createElement('a');
            a.href = msgData.src;
            a.download = `generated_image_${Date.now()}.png`;
            a.click();
            closePictureMenu();
        });
    }

    // 删除图片
    const deleteBtn = actionsDiv.querySelector('.delete-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm('确定要删除这张图片吗？')) {
                await deletePictureMessage(msgElement, msgData);
                closePictureMenu();
            }
        });
    }

    // 关闭逻辑
    const closeHandler = (e) => {
        if (!actionsDiv.contains(e.target) && e.target !== msgElement && !msgElement.contains(e.target)) {
            closePictureMenu();
            document.removeEventListener('click', closeHandler);
        }
    };
    const scrollCloseHandler = () => closePictureMenu();
    setTimeout(() => {
        document.addEventListener('click', closeHandler);
        chatMessages.addEventListener('scroll', scrollCloseHandler, { once: true });
    }, 0);

    function closePictureMenu() {
        if (actionsDiv.parentNode) actionsDiv.remove();
        currentPictureMenu = null;
        currentPictureMsgElement = null;
        document.removeEventListener('click', closeHandler);
        chatMessages.removeEventListener('scroll', scrollCloseHandler);
    }
}

function renderMessages(chatId, topicIndex = null) {
    const chat = chats.find(c => c.id == chatId);
    if (!chat || !chatMessages) return;
    chatMessages.innerHTML = '';
    const currentAvatarUrl = chat.settings?.avatarUrl || null;
    
    // 获取所有消息
    let messagesToRender = chat.messages;
    
    // 如果指定了话题索引，则过滤出该话题的消息
    if (topicIndex !== null) {
        const topics = getTopicsFromMessages(chat.messages);
        if (topics[topicIndex]) {
            messagesToRender = topics[topicIndex].messages;
        }
    }
    
    // 渲染消息
    messagesToRender.forEach((msg, idx) => {
        if (msg.isImage) {
            appendImageToDOM(msg.type, msg.text, msg.time, false, null);
        } else if (msg.type === 'divider') {
            const divider = document.createElement('div');
            divider.className = 'topic-divider';
            divider.innerHTML = `<i class="fas fa-asterisk"></i> ${escapeHtml(msg.text)} <i class="fas fa-asterisk"></i>`;
            chatMessages.appendChild(divider);
        } else {
            const fileAttachment = msg.file || null;
            appendMessageToDOM(msg.type, msg.text, msg.time, false, null, currentAvatarUrl, fileAttachment, msg.modelName || null);
        }
    });
    
    // 如果处于话题视图且没有消息（理论上不会），显示提示
    if (topicIndex !== null && messagesToRender.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'topic-empty';
        emptyDiv.innerHTML = '<div style="text-align:center; padding:20px; color:#8e8eb3;">该话题暂无消息</div>';
        chatMessages.appendChild(emptyDiv);
    }
    
    conditionalScrollToBottom();
}

function getTypingSpeed() {
    const slider = document.getElementById('global-typing-speed');
    return slider ? parseFloat(slider.value) || 1 : 1;
}

async function simulateAIResponse(userMsg) {
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
    const roleName = settings.roleName || 'Nova';
    const rolePersona = settings.persona || '';

    // 显示正在输入指示器
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message ai';
    typingDiv.innerHTML = `<div class="avatar-msg"><i class="fas fa-robot"></i></div><div class="bubble typing-bubble"><div class="typing-indicator"><i class="fas fa-ellipsis-h"></i> ${roleName} 正在思考...</div></div>`;
    chatMessages.appendChild(typingDiv);
    scrollToBottom();

    try {
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        // 获取对话历史（支持话题视图）
        let historyMessages = [];
        if (currentTopicIndex !== null) {
            const topics = getTopicsFromMessages(currentChat.messages);
            if (topics[currentTopicIndex]) historyMessages = topics[currentTopicIndex].messages;
        } else {
            historyMessages = currentChat.messages;
        }
        const filteredMessages = historyMessages.filter(msg => msg.type !== 'divider');
        let messagesToUse = filteredMessages;
        const contextLimit = currentChat.settings?.contextLimit ?? 10;
        if (contextLimit !== -1 && messagesToUse.length > contextLimit) {
            messagesToUse = messagesToUse.slice(-contextLimit);
        }

        // 构建 API 消息列表
        const messages = [];
        const userName = globalSettings.username || '用户';
        const userBio = globalSettings.bio || '';

        let systemPrompt = `你的角色名称是：${roleName}。${rolePersona ? rolePersona : ''}\n\n`;
        if (userBio) {
            systemPrompt += `关于当前用户的名称是：${userName}，简介：${userBio}`;
        } else {
            systemPrompt += `当前用户名称叫：${userName}`;
        }
        systemPrompt += '\n\n重要：请严格根据上述角色设定进行角色扮演，不要打破角色，不要以助手或AI的身份回答。必须始终以角色的身份和语气回复。\n\n回复格式规则：当你的回复中包含人物动作、环境描写、情绪描述等非语言表达的内容时，请使用括号（）将这些内容包裹起来。例如：（轻轻叹气）我相信你能做到。或（窗外的雨声淅沥）今天的任务完成得不错。';
        messages.push({ role: 'system', content: systemPrompt });
        let lastUserMsgContent = '';
        for (const msg of messagesToUse) {
            const role = msg.type === 'user' ? 'user' : 'assistant';
            const content = (role === 'user' && msg.modelInputText) ? msg.modelInputText : msg.text;
            messages.push({ role, content });
            if (role === 'user') lastUserMsgContent = content;
        }
        if (lastUserMsgContent !== userMsg) {
            messages.push({ role: 'user', content: userMsg });
        }

        // 创建模型服务实例（使用当前全局设置）
        const modelService = getModelService();
        // 确保配置最新（在调用前更新配置）
        modelService.updateConfig({
            modelHost: globalSettings.modelHost || Constants.DEFAULT_MODEL_HOST,
            apiKey: globalSettings.apiKey || '',
            modelName: globalSettings.modelName || Constants.DEFAULT_MODEL_NAME,
        });

        // 准备请求选项
        const requestOptions = {
            temperature: currentChat.settings?.temperature ?? 0.7,
            topP: currentChat.settings?.topP ?? 0.9,
            maxTokens: 500,
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
                const modelNameForDisplay = globalSettings.modelName || '未知模型';
                messageDiv = createMessageBubble('ai', '', getCurrentTime(), currentChat.settings?.avatarUrl, modelNameForDisplay);
                bubbleP = messageDiv.querySelector('.bubble p');
                bubbleP.innerHTML = '';  // 清空占位
                chatMessages.appendChild(messageDiv);
                scrollToBottom();
                isFirstChunk = false;
            }
            fullReply += chunk;
            const span = document.createElement('span');
            span.className = 'fade-in-text';
            span.textContent = chunk;
            bubbleP.appendChild(span);
            conditionalScrollToBottom();
            
            // 可选：控制打字速度（原逻辑有速度调节，可以保留）
            const speed = getTypingSpeed();
            if (speed < 1) {
                await new Promise(resolve => setTimeout(resolve, (1 - speed) * 150));
            }
        }
        // 最终更新消息气泡内容（解析思考标签）
        const bubble = messageDiv.querySelector('.bubble');
        const newHtml = renderMessageWithThink(fullReply);
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
        bubble.innerHTML = newHtml + newTimeHtml;
        // 重新绑定气泡点击事件（因为 innerHTML 会清除原有监听）
        const newBubble = messageDiv.querySelector('.bubble');
        if (newBubble) {
            newBubble.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                showMessageActions(messageDiv, 'ai', fullReply, getCurrentTime(), false, null, currentChat.settings?.avatarUrl, null);
            });
        }
        scrollToBottom();
        updateStatusIndicator('online');
        // 保存消息到存储
        const targetChat = chats.find(c => c.id == currentChatId);
        if (targetChat) {
            const modelName = globalSettings.modelName || '未知模型';
            targetChat.messages.push({ type: 'ai', text: fullReply, time: getCurrentTime(), modelName: modelName });
            targetChat.date = new Date();
            renderHistoryList();
            await chatRepo.saveChat(targetChat);
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
function createMessageBubble(type, text, time, avatarUrl, modelName = null) {
    const div = document.createElement('div');
    div.className = `message ${type}`;
    const avatarHtml = avatarUrl ? `<img src="${avatarUrl}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;">` : '<i class="fas fa-robot"></i>';
    let timeHtml = `<div class="msg-time">`;
    if (type === 'ai' && modelName) {
        timeHtml += `<span style="margin-right: 8px; font-size: 0.65rem; opacity: 0.7;">🤖 ${escapeHtml(modelName)}</span>`;
    }
    timeHtml += `${escapeHtml(time)}</div>`;

    div.innerHTML = `
        <div class="avatar-msg">${avatarHtml}</div>
        <div class="bubble">
            <p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>
            ${timeHtml}
        </div>
    `;
    return div;
}

async function sendUserMessage() {
    if (isProcessing) {
        showBriefToast('请等待当前回复完成后再发送');
        return;
    }
    // 如果当前为“显示全部话题”模式，自动切换到最后一个话题
    if (currentTopicIndex === null) {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (currentChat) {
            const topics = getTopicsFromMessages(currentChat.messages);
            if (topics.length > 0) {
                await setCurrentTopic(topics.length - 1, false);
            }
        }
    }

    let text = messageInput.value.trim();
    // 获取文件附件
    let fileAttachment = fileUpload.getFileAttachment();
    if (fileAttachment) {
        fileUpload.clearFile();
    }
    
    if (text === '' && !fileAttachment) return;

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
    let modelUserMsg = text;
    // 构建发送给模型的内容（包含文件内容）
    if (fileAttachment) {
        modelUserMsg = text + `\n\n文件内容如下：\n\`\`\`\n${fileAttachment.content}\n\`\`\``;
    }
    if (targetChat) {
        targetChat.messages.push({
            type: 'user',
            text: text,
            time: userTime,
            file: fileAttachment,  // 附加文件信息
            modelInputText: modelUserMsg,
        });
        targetChat.date = new Date();
        renderHistoryList();
        await chatRepo.saveChat(targetChat);
    }
    forceScrollToBottom();
    // 渲染消息
    await appendMessageToDOM('user', text, userTime, false, null, null, fileAttachment);
    messageInput.value = '';
    if (messageInput) messageInput.style.height = 'auto';
    simulateAIResponse(modelUserMsg);
}

async function createNewChat() {
    closeSidebarOnMobile();
    const newId = Date.now();
    const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
    // 新对话的标题使用默认设置
    const newSettings = JSON.parse(JSON.stringify(Constants.DEFAULT_SETTINGS));
    newSettings.contextLimit = globalSettings.contextLimit !== undefined ? globalSettings.contextLimit : 10;
    newSettings.temperature = globalSettings.temperature !== undefined ? globalSettings.temperature : 0.7;
    newSettings.topP = globalSettings.topP !== undefined ? globalSettings.topP : 0.9;
    // 可选：也可以继承用户管理的用户名等，按需
    const newChat = {
        id: newId,
        title: `新对话 ${chats.length+1}`,
        date: new Date(),
        messages: [
            { type: 'ai', text: newSettings.greeting, time: getCurrentTime() }
        ],
        settings: newSettings,
        pinned: false
    };
    chats.unshift(newChat);
    setCurrentChatId(newId);
    renderHistoryList();
    renderMessages(currentChatId);
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
    // ✅ 自动切换到最后一个话题（如果存在）
    const chat = chats.find(c => c.id == chatId);
    if (chat) {
        const topics = getTopicsFromMessages(chat.messages);
        currentTopicIndex = topics.length > 0 ? topics.length - 1 : null;
    } else {
        currentTopicIndex = null;
    }
    renderHistoryList();
    renderMessages(currentChatId, currentTopicIndex);
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

// ==================== 弹窗逻辑（编辑当前对话的设置） ====================
const modal = document.getElementById('settings-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const cancelBtn = document.getElementById('cancel-settings-btn');
const saveBtn = document.getElementById('save-settings-btn');
const bgUpload = document.getElementById('bg-upload');
const roleNameInput = document.getElementById('role-name');
const rolePersona = document.getElementById('role-persona');
const roleGreeting = document.getElementById('role-greeting');
const avatarImg = document.getElementById('avatar-img');
const bgImg = document.getElementById('bg-img');

async function openSettingsModal() {
    const currentChat = chats.find(c => c.id == currentChatId);
    if (!currentChat) return;
    const settings = currentChat.settings || Constants.DEFAULT_SETTINGS;
    // 加载模型参数（如果不存在则使用默认值）
    const contextLimit = settings.contextLimit !== undefined ? settings.contextLimit : 10;
    const contextUnlimited = (settings.contextLimit === -1);
    const temperature = settings.temperature !== undefined ? settings.temperature : 0.7;
    const topP = settings.topP !== undefined ? settings.topP : 0.9;

    const contextLimitSlider = document.getElementById('context-limit');
    const contextLimitSpan = document.getElementById('context-limit-value');
    const contextUnlimitedCheck = document.getElementById('context-unlimited');

    const temperatureSlider = document.getElementById('temperature');
    const temperatureSpan = document.getElementById('temperature-value');
    const topPSlider = document.getElementById('top-p');
    const topPSpan = document.getElementById('top-p-value');

    if (contextLimitSlider) {
        if (contextUnlimited) {
            contextUnlimitedCheck.checked = true;
            contextLimitSlider.disabled = true;
            contextLimitSpan.innerText = '无限制';
        } else {
            contextUnlimitedCheck.checked = false;
            contextLimitSlider.disabled = false;
            contextLimitSlider.value = contextLimit;
            contextLimitSpan.innerText = contextLimit;
        }
        // 绑定复选框变化事件
        contextUnlimitedCheck.onchange = () => {
            if (contextUnlimitedCheck.checked) {
                contextLimitSlider.disabled = true;
                contextLimitSpan.innerText = '无限制';
            } else {
                contextLimitSlider.disabled = false;
                contextLimitSlider.value = contextLimit;
                contextLimitSpan.innerText = contextLimitSlider.value;
            }
        };
        contextLimitSlider.oninput = () => {
            if (!contextUnlimitedCheck.checked) {
                contextLimitSpan.innerText = contextLimitSlider.value;
            }
        };
    }
    if (temperatureSlider) {
        temperatureSlider.value = temperature;
        temperatureSpan.innerText = temperature;
        temperatureSlider.oninput = () => {
            temperatureSpan.innerText = temperatureSlider.value;
        };
    }
    if (topPSlider) {
        topPSlider.value = topP;
        topPSpan.innerText = topP;
        topPSlider.oninput = () => {
            topPSpan.innerText = topPSlider.value;
        };
    }

    roleNameInput.value = settings.roleName;
    rolePersona.value = settings.persona;
    roleGreeting.value = settings.greeting;
    if (settings.avatarUrl) avatarImg.src = settings.avatarUrl;
    else avatarImg.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='45' fill='%23333b6e'/%3E%3Ctext x='50' y='67' font-size='40' text-anchor='middle' fill='white'%3E🤖%3C/text%3E%3C/svg%3E";
    if (settings.bgUrl) bgImg.src = settings.bgUrl;
    else bgImg.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='200'%3E%3Crect width='300' height='200' fill='%231a1c2a'/%3E%3Ctext x='150' y='110' font-size='16' fill='%23a5b9ff' text-anchor='middle'%3E默认背景%3C/text%3E%3C/svg%3E";
    const ttsSwitch = document.getElementById('tts-switch');
    const ttsVoiceSelect = document.getElementById('tts-voice-select');
    const ttsVoiceGroup = document.getElementById('tts-voice-group');
    
    if (ttsSwitch) {
        ttsSwitch.checked = settings.ttsEnabled || false;
        // 根据开关状态显示/隐藏音色选择
        if (ttsVoiceGroup) {
            ttsVoiceGroup.style.display = ttsSwitch.checked ? 'block' : 'none';
        }
        if (ttsSwitch.checked && ttsVoiceSelect) {
            await TTsService.populateVoiceSelect(ttsVoiceSelect, currentChat?.settings?.ttsVoice, false);  // 使用缓存
        }
        // 绑定开关变化事件
        ttsSwitch.onchange = async () => {
            if (ttsVoiceGroup) {
                ttsVoiceGroup.style.display = ttsSwitch.checked ? 'block' : 'none';
            }
            if (ttsSwitch.checked && ttsVoiceSelect) {
            await TTsService.populateVoiceSelect(ttsVoiceSelect, currentChat?.settings?.ttsVoice, false);
        }
        };
    }

    const content = modal.querySelector('.modal-content');
    if (content) content.classList.remove('closing');
    modal.style.display = 'flex';
    // 绑定自动扩展（每次打开时重新绑定，确保生效）
    bindAutoResize(rolePersona);
    bindAutoResize(roleGreeting);
}

function closeModal() {
    const modal = document.getElementById('settings-modal');
    closeModalWithAnimation(modal);
}

function closeModalWithAnimation(modal, afterClose) {
    if (!modal) return;
    const content = modal.querySelector('.modal-content');
    if (!content) {
        modal.style.display = 'none';
        if (afterClose) afterClose();
        return;
    }
    // 如果已经在关闭动画中，不再重复触发
    if (content.classList.contains('closing')) return;
    
    content.classList.add('closing');
    const onAnimationEnd = () => {
        content.classList.remove('closing');
        modal.style.display = 'none';
        content.removeEventListener('animationend', onAnimationEnd);
        if (afterClose) afterClose();
    };
    content.addEventListener('animationend', onAnimationEnd, { once: true });
    // 安全后备：如果动画未触发，1秒后强制关闭
    setTimeout(() => {
        if (modal.style.display !== 'none') {
            content.classList.remove('closing');
            modal.style.display = 'none';
            if (afterClose) afterClose();
        }
    }, 200);
}

async function saveSettings() {
    const modelService = getModelService();
    if (modelService.isStreaming()) {
        if (confirm('当前对话正在生成回复，保存设置会中断该回复。是否继续？')) {
            modelService.abortCurrentStream();
            releaseRequestLock();
            ttsService.stop();
            await new Promise(resolve => setTimeout(resolve, 100));
        } else {
            closeModal();
            return;
        }
    }
    const currentChat = chats.find(c => c.id == currentChatId);
    if (!currentChat) return;
    const oldGreeting = currentChat.settings?.greeting || Constants.DEFAULT_SETTINGS.greeting;
    const newRoleName = roleNameInput.value.trim() || 'Nova';
    const newPersona = rolePersona.value.trim() || '暂无设定';
    const newGreeting = roleGreeting.value.trim() || '✨ 你好，我是你的虚拟AI伙伴。';
    // 获取模型参数值
    const contextUnlimited = document.getElementById('context-unlimited').checked;
    let contextLimit = parseInt(document.getElementById('context-limit').value);
    if (contextUnlimited) {
        contextLimit = -1; // 用 -1 表示无限制
    }
    currentChat.settings.contextLimit = contextLimit;
    const temperature = parseFloat(document.getElementById('temperature').value);
    const topP = parseFloat(document.getElementById('top-p').value);

    currentChat.settings.contextLimit = contextLimit;
    currentChat.settings.temperature = temperature;
    currentChat.settings.topP = topP;
    // 更新设置
    currentChat.settings = currentChat.settings || {};
    currentChat.settings.roleName = newRoleName;
    currentChat.settings.persona = newPersona;
    currentChat.settings.greeting = newGreeting;
    // 头像和背景
    const newAvatarUrl = avatarImg.src !== "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='45' fill='%23333b6e'/%3E%3Ctext x='50' y='67' font-size='40' text-anchor='middle' fill='white'%3E🤖%3C/text%3E%3C/svg%3E" ? avatarImg.src : null;
    const newBgUrl = bgImg.src !== "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='200'%3E%3Crect width='300' height='200' fill='%231a1c2a'/%3E%3Ctext x='150' y='110' font-size='16' fill='%23a5b9ff' text-anchor='middle'%3E默认背景%3C/text%3E%3C/svg%3E" ? bgImg.src : null;
    currentChat.settings.avatarUrl = newAvatarUrl;
    currentChat.settings.bgUrl = newBgUrl;
    // 保存音色设置
    const ttsEnabled = document.getElementById('tts-switch').checked;
    const ttsVoice = document.getElementById('tts-voice-select').value;
    currentChat.settings.ttsEnabled = ttsEnabled;
    currentChat.settings.ttsVoice = ttsVoice;
    // 应用界面设置（背景、名称）
    applyCurrentChatSettings();
    // 重新渲染当前对话，所有 AI 消息头像立即更新
    renderMessages(currentChatId);
    // 更新左侧历史列表
    renderHistoryList();
    await chatRepo.saveChat(currentChat);
    if (oldGreeting !== newGreeting) {
        startNewTopic();
    }
    closeModal();
}

bgUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showCropModal(file, NaN, { maxWidth: 2560, mimeType: 'image/jpeg' }, (croppedDataUrl) => {
        bgImg.src = croppedDataUrl;
        const mainChat = document.querySelector('.main-chat');
        mainChat.style.backgroundImage = `linear-gradient(0deg, rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0.55)), url(${croppedDataUrl})`;
        mainChat.style.backgroundSize = 'cover';
    });
});

// ==================== 初始化数据 ====================
async function initData() {
    // 应用已保存的字体大小
    const saved = JSON.parse(localStorage.getItem('global_settings')) || {};
    applyFontSize(saved.fontSize || 'medium');
    const stored = await loadFromStorage();
    if (stored && stored.length > 0) {
        chats = stored;
        // 读取上次对话 ID
        const lastId = localStorage.getItem('last_chat_id');
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
            messages: Constants.BASE_CHATS,
            settings: JSON.parse(JSON.stringify(Constants.DEFAULT_SETTINGS)),
            pinned: false
        };
        chats = [defaultChat];
        setCurrentChatId(defaultChat.id);
    }
    renderHistoryList();
    renderMessages(currentChatId);
    applyCurrentChatSettings();
}

function closeSidebarOnMobile() {
    if (window.innerWidth <= 768) {
        const sidebar = document.querySelector('.sidebar');
        if (sidebar && sidebar.classList.contains('open')) {
            sidebar.classList.remove('open');
        }
    }
}

// ==================== 事件绑定 ====================
function bindEvents() {
    // 移动端菜单开关
    const menuToggle = document.getElementById('mobile-menu-toggle');
    const sidebarElem = document.querySelector('.sidebar');
    if (menuToggle && sidebarElem) {
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
    // PC端代码
    const textarea = messageInput;
    if (textarea) {
        const autoResize = () => {
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        };
        textarea.addEventListener('input', autoResize);
        autoResize();
        const newSend = function() {
            if (textarea.value.trim() === '') return;
            sendUserMessage();
            setTimeout(() => { textarea.style.height = 'auto'; }, 0);
        };
        sendBtn.onclick = newSend;
        textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            if (e.ctrlKey) {
                // Ctrl+Enter：发送但不生成回复
                e.preventDefault();
                sendMessageWithoutAI();
            } else if (!e.shiftKey) {
                // 普通 Enter：发送并生成 AI 回复
                e.preventDefault();
                sendUserMessage();
                setTimeout(() => { textarea.style.height = 'auto'; }, 0);
            }
            // Shift+Enter 不处理，默认换行
        }
    });
    }
    if (newChatBtn) newChatBtn.addEventListener('click', createNewChat);
    if (settingBtn) {
        settingBtn.addEventListener('click', () => {
            const toast = document.createElement('div');
            toast.textContent = '⚙️ 个性化设置开发中 · 主题/音效即将上线';
            toast.style.position = 'fixed';
            toast.style.bottom = '80px';
            toast.style.right = '20px';
            toast.style.backgroundColor = 'rgba(20,20,40,0.9)';
            toast.style.backdropFilter = 'blur(12px)';
            toast.style.color = '#ccd6ff';
            toast.style.padding = '10px 20px';
            toast.style.borderRadius = '40px';
            toast.style.fontSize = '0.8rem';
            toast.style.border = '1px solid #5f7eff';
            toast.style.zIndex = '9999';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2500);
        });
    }
    // 头像上传预览
    document.getElementById('global-avatar-upload').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
            try {
                // 压缩图片：最大宽度 150px，质量 0.6，大幅减小 Base64 大小
                const compressedUrl = await compressImage(file, 150, 0.6);
                document.getElementById('global-avatar-img').src = compressedUrl;
            } catch (err) {
                console.error('头像压缩失败', err);
                customAlert('头像处理失败，请重试', 'error');
            }
        }
    });
    // 文件上传、语音输入按钮
    const uploadBtn = document.getElementById('upload-file-btn');
    if (uploadBtn) {
        uploadBtn.addEventListener('click', () => fileUpload.selectFile());
    }
    const removeFileBtn = document.getElementById('remove-file-btn');
    if (removeFileBtn) {
        removeFileBtn.addEventListener('click', () => fileUpload.clearFile());
    }
    const voiceBtn = document.getElementById('voice-input-btn');
    if (voiceBtn) {
        voiceBtn.addEventListener('click', startVoiceInput);
    }
    // 对话设置按钮（输入框下方）
    const chatSettingsBtn = document.getElementById('chat-settings-btn');
    if (chatSettingsBtn) chatSettingsBtn.addEventListener('click', openSettingsModal);

    const topicsBtn = document.getElementById('topics-manage-btn');
    if (topicsBtn) {
        topicsBtn.addEventListener('click', openTopicsModal);
    }

    const newTopicModalBtn = document.getElementById('new-topic-modal-btn');
    if (newTopicModalBtn) {
        newTopicModalBtn.addEventListener('click', () => {
            startNewTopic();
            closeTopicsModal();
        });
    }

    // 话题管理弹窗关闭按钮
    const closeTopicsModalBtn = document.getElementById('close-topics-modal');
    if (closeTopicsModalBtn) closeTopicsModalBtn.addEventListener('click', closeTopicsModal);
    const cancelTopicsBtn = document.getElementById('cancel-topics-btn');
    if (cancelTopicsBtn) cancelTopicsBtn.addEventListener('click', closeTopicsModal);
    // 点击遮罩关闭
    const topicsModal = document.getElementById('topics-modal');
    if (topicsModal) {
        topicsModal.addEventListener('click', (e) => {
            if (e.target === topicsModal) closeTopicsModal();
        });
    }
    const showAllTopicsBtn = document.getElementById('show-all-topics-btn');
    if (showAllTopicsBtn) {
        showAllTopicsBtn.addEventListener('click', async () => {
            await setCurrentTopic(null);
            closeTopicsModal();
        });
    }
    const addModelBtn = document.getElementById('add-model-btn');
    if (addModelBtn) {
        addModelBtn.addEventListener('click', () => {
            const newModel = document.getElementById('new-model-name').value;
            if (addModel(newModel)) {
                document.getElementById('new-model-name').value = '';
            }
        });
    }
    // // 获取拖拽目标区域（聊天消息区域）
    const dropZone = document.querySelector('.chat-messages');
    if (dropZone) {
        fileUpload.setupDragAndDrop(dropZone);
    }

    // 搜索框展开/收回动画
    const searchInput = document.getElementById('global-search-input');
    const searchToggleBtn = document.getElementById('search-toggle-btn');
    const searchDropdown = document.getElementById('search-results-dropdown');
    if (searchToggleBtn && searchInput) {
        // 点击圆形按钮 → 展开输入框并聚焦
        searchToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (searchInput.classList.contains('search-input-hidden')) {
                // 展开
                searchInput.classList.remove('search-input-hidden');
                searchToggleBtn.classList.add('hidden');
                setTimeout(() => searchInput.focus(), 50); // 等待过渡开始
            } else collapseSearch(); // 如果已展开，则关闭并清除内容
        });

        // 全局点击：点击搜索容器外部时收起
        document.addEventListener('click', (e) => {
            if (!document.getElementById('search-container').contains(e.target)) {
                collapseSearch();
            }
        });

        // ESC 键收起
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') collapseSearch();
        });

        function collapseSearch() {
            searchInput.classList.add('search-input-hidden');
            searchInput.value = '';
            searchToggleBtn.classList.remove('hidden');
            searchDropdown.style.display = 'none';
        }
    }

    // 保留原有的搜索输入监听（不变）
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                performSearch(e.target.value);
            }, 300);
        });
    }

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
                        currentTopicIndex = null;
                        renderHistoryList();
                        renderMessages(currentChatId);
                        applyCurrentChatSettings();
                        await chatRepo.saveAllChats(chats);
                        customAlert('导入成功', 'success');
                    } catch (err) {
                        customAlert('JSON 解析失败：' + err.message, 'error');
                    }
                };
                reader.readAsText(file, 'UTF-8');
            };
            fileInput.click();
        });
    }
    if (chatMessages) {
        chatMessages.addEventListener('scroll', updateAutoScrollFlag);
    }
    // 绑定“返回全部对话”按钮
    const backBtn = document.getElementById('back-to-all-topics');
    if (backBtn) {
        backBtn.addEventListener('click', async () => {
            await setCurrentTopic(null, false);
        });
    }

    // 获取元素
    globalModal = document.getElementById('global-settings-modal');
    const closeGlobalBtn = document.getElementById('close-global-settings');
    const cancelGlobalBtn = document.getElementById('cancel-global-settings');
    const saveGlobalBtn = document.getElementById('save-global-settings');

    // 菜单切换
    const menuItems = document.querySelectorAll('.settings-menu-item');
    const panes = document.querySelectorAll('.settings-tab-pane');

    menuItems.forEach(item => {
        item.addEventListener('click', () => {
            const tabId = item.getAttribute('data-tab');
            // 更新菜单激活状态
            menuItems.forEach(mi => mi.classList.remove('active'));
            item.classList.add('active');
            // 显示对应面板
            panes.forEach(pane => pane.classList.remove('active'));
            document.getElementById(`tab-${tabId}`).classList.add('active');
        });
    });

    // 绑定按钮事件
    closeGlobalBtn.addEventListener('click', closeGlobalModal);
    cancelGlobalBtn.addEventListener('click', closeGlobalModal);
    saveGlobalBtn.addEventListener('click', saveGlobalSettings);
    globalModal.addEventListener('click', (e) => { if (e.target === globalModal) closeGlobalModal(); });
    document.getElementById('test-model-connection-btn')?.addEventListener('click', async () => {
        const statusEl = document.getElementById('test-connection-status');
        if (!statusEl) return;
        statusEl.innerHTML = '<span style="color: #b7c4ff;"><i class="fas fa-spinner fa-pulse"></i> 检测中…</span>';
        
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        const modelService = new ModelService({  // 临时创建或使用单例均可，这里为了配置最新，临时创建
            modelHost: globalSettings.modelHost || Constants.DEFAULT_MODEL_HOST,
            apiKey: globalSettings.apiKey || '',
            modelName: globalSettings.modelName || Constants.DEFAULT_MODEL_NAME,
        });
        const result = await modelService.testConnection();
        statusEl.innerHTML = result.success 
            ? `<span style="color: #2effb0;">✅ ${result.message}</span>`
            : `<span style="color: #ff7a5c;">❌ ${result.message}</span>`;
    });

    // 修改左下角设置按钮的点击事件
    const originalSettingBtn = document.querySelector('.setting-btn');
    if (originalSettingBtn) {
        // 移除原有监听（避免重复）
        const newBtn = originalSettingBtn.cloneNode(true);
        originalSettingBtn.parentNode.replaceChild(newBtn, originalSettingBtn);
        newBtn.addEventListener('click', openGlobalSettings);
    } else if (settingBtn) {
        settingBtn.addEventListener('click', openGlobalSettings);
    }
    // 关闭下拉框（点击外部）
    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !searchDropdown.contains(e.target)) {
            searchDropdown.style.display = 'none';
        }
    });
    // 点击头像图片触发文件选择
    const avatarImgElement = document.getElementById('avatar-img');
    if (avatarImgElement) {
        avatarImgElement.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                showCropModal(file, 1, { maxWidth: 1024, mimeType: 'image/jpeg', quality: 0.9 }, (croppedDataUrl) => {
                    avatarImgElement.src = croppedDataUrl;
                });
            };
            fileInput.click();
        });
    }
    if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
    if (saveBtn) saveBtn.addEventListener('click', saveSettings);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeModalWithAnimation(modal); });
    bindQuickModelSwitch();
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            // 查找所有当前可见的模态框（display: flex）
            const openModals = document.querySelectorAll('.settings-modal[style*="display: flex"]');
            if (openModals.length > 0) {
                // 取最后一个（最后打开的，通常在最上层）
                const topModal = openModals[openModals.length - 1];
                const closeBtn = topModal.querySelector('.modal-close');
                if (closeBtn) {
                    closeBtn.click();   // 触发原有关闭逻辑（含裁剪清理等）
                    e.preventDefault();
                    e.stopPropagation();
                }
                return;
            }
            
            // 处理文件内容预览弹窗（没有 settings-modal 类）
            const fileModal = document.querySelector('.file-content-modal');
            if (fileModal && fileModal.style.display === 'flex') {
                fileModal.remove();
                e.preventDefault();
                e.stopPropagation();
            }
        }
    }, true);
    document.getElementById('reset-shortcuts-btn').addEventListener('click', () => {
        currentShortcuts = {};
        for (const [action, obj] of Object.entries(DEFAULT_SHORTCUTS)) {
            currentShortcuts[action] = obj.keys;
        }
        renderShortcutsPanel();
    });

    const fetchVoicesBtn = document.getElementById('fetch-voices-btn');
    if (fetchVoicesBtn) {
        fetchVoicesBtn.addEventListener('click', async () => {
            const apiUrl = document.getElementById('tts-api-url').value;
            if (!apiUrl) {
                customAlert('请先填写 TTS API 地址');
                return;
            }
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
    }
    // 打开生成图片弹窗
    const genImgBtn = document.getElementById('generate-image-btn');
    if (genImgBtn) {
        genImgBtn.addEventListener('click', () => {
            const modal = document.getElementById('image-gen-modal');
            if (modal) modal.style.display = 'flex';
        });
    }

    // 关闭按钮
    const closeImageGenBtn = document.getElementById('close-image-gen-modal');
    const cancelImageGenBtn = document.getElementById('cancel-image-gen-btn');
    if (closeImageGenBtn) closeImageGenBtn.addEventListener('click', () => {
        document.getElementById('image-gen-modal').style.display = 'none';
    });
    if (cancelImageGenBtn) cancelImageGenBtn.addEventListener('click', () => {
        document.getElementById('image-gen-modal').style.display = 'none';
    });

    // 点击遮罩关闭
    const imageGenModal = document.getElementById('image-gen-modal');
    if (imageGenModal) {
        imageGenModal.addEventListener('click', (e) => {
            if (e.target === imageGenModal) imageGenModal.style.display = 'none';
        });
    }

    // 开始生成按钮（当前仅关闭弹窗，可在此实现）
    const startImageGenBtn = document.getElementById('start-image-gen-btn');
    if (startImageGenBtn) {
        startImageGenBtn.addEventListener('click', async () => {
            const prompt = document.getElementById('image-gen-prompt').value;
            if (!prompt) {
                customAlert('请输入图片描述');
                return;
            }
            const negative = document.getElementById('image-gen-negative').value;
            const size = document.getElementById('image-gen-ratio').value;
            const count = parseInt(document.getElementById('image-gen-count').value);
            const model = document.getElementById('image-gen-model').value;
            const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
            const imgApiUrl = globalSettings.imgApiUrl || Constants.DEFAULT_IMG_API_URL;
            const imgApiKey = globalSettings.imgApiKey || '';
            const headers = { 'Content-Type': 'application/json' };
            if (imgApiKey) headers['X-API-Key'] = imgApiKey;

            // 关闭弹窗
            document.getElementById('image-gen-modal').style.display = 'none';

            // 发送提示消息
            await appendMessageToDOM('ai', `🎨 正在生成 ${count} 张图片...`, getCurrentTime(), false);
            forceScrollToBottom();
            try {
                const response = await fetch(`${imgApiUrl}/generate_image`, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ prompt, negative, size, count, model })
                });
                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.error || '生成失败');
                }
                const genParams = { prompt, negative, size, count, model };
                // 显示生成的图片
                for (const imgB64 of data.images) {
                    const imgSrc = imgB64.startsWith('data:') ? imgB64 : `data:image/png;base64,${imgB64}`;
                    await appendImageToDOM('ai', imgSrc, getCurrentTime(), true, genParams);  // 持久化
                }
            } catch (error) {
                appendMessageToDOM('ai', `❌ 图片生成失败: ${error.message}`, getCurrentTime(), true);
            }
        });
    }
}

// 开启新话题（插入分隔线 + 开场白）
function startNewTopic() {
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

    // 添加分隔线消息（存储）
    const dividerTime = getCurrentTime();
    currentChat.messages.push({
        type: 'divider',
        text: '新话题',
        time: dividerTime
    });
    // 立即在界面添加分隔线
    const divider = document.createElement('div');
    divider.className = 'topic-divider';
    divider.innerHTML = `<i class="fas fa-asterisk"></i> 新话题 <i class="fas fa-asterisk"></i>`;
    chatMessages.appendChild(divider);
    scrollToBottom();
    // 添加开场白消息（普通 AI 消息）
    const aiTime = getCurrentTime();
    appendMessageToDOM('ai', greeting, aiTime, true);
    // 自动切换到新话题视图（新话题的索引为话题总数-1）
    const topics = getTopicsFromMessages(currentChat.messages);
    const newTopicIndex = topics.length - 1;
    setCurrentTopic(newTopicIndex, false);
    // 刷新左侧历史列表（更新最后消息时间）
    currentChat.date = new Date();
    renderHistoryList();
    chatRepo.saveChat(currentChat);

    // 如果当前对话开启语音合成，则朗读开场白
    if (settings.ttsEnabled) {
        const ttsVoice = currentChat?.settings?.ttsVoice || 'default';
        updateStatusIndicator('speaking', '语音合成中 ...');
        ttsService.speak(greeting, ttsVoice)
            .finally(() => updateStatusIndicator('online'));;
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
    const toast = document.createElement('div');
    toast.textContent = chat.pinned ? '📌 已置顶该会话' : '📍 已取消置顶';
    toast.style.cssText = 'position:fixed; bottom:80px; right:20px; background:#2a2f55; color:white; padding:8px 16px; border-radius:20px; z-index:10000;';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

// 删除会话
async function deleteChat(chatId) {
    if (chats.length === 1) {
        customAlert('至少保留一个对话，无法删除最后一个。', 'warn');
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
                currentTopicIndex = null;
                renderMessages(currentChatId);
                applyCurrentChatSettings();
            }
        }
        renderHistoryList();       // 重新渲染列表（此时已无删除动画，会平滑出现）
        await chatRepo.saveAllChats(chats);

        // 提示
        const toast = document.createElement('div');
        toast.textContent = '🗑️ 会话已删除';
        toast.style.cssText = 'position:fixed; bottom:80px; right:20px; background:#2a2f55; color:white; padding:8px 16px; border-radius:20px; z-index:10000;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
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

function getTopicsFromMessages(messages, topicSummaries = {}) {
    const topics = [];
    let currentTopicMessages = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.type === 'divider') {
            if (currentTopicMessages.length > 0) {
                const idx = topics.length;
                topics.push({
                    startIndex: idx === 0 ? 0 : (topics[idx-1].endIndex + 1),
                    endIndex: i - 1,
                    messages: currentTopicMessages,
                    dividerText: msg.text,
                    dividerTime: msg.time,
                    summary: topicSummaries[idx] || null
                });
                currentTopicMessages = [];
            }
        } else {
            currentTopicMessages.push(msg);
        }
    }
    if (currentTopicMessages.length > 0) {
        const idx = topics.length;
        topics.push({
            startIndex: idx === 0 ? 0 : (topics[idx-1].endIndex + 1),
            endIndex: messages.length - 1,
            messages: currentTopicMessages,
            dividerText: null,
            dividerTime: null,
            summary: topicSummaries[idx] || null
        });
    }
    return topics;
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

function openTopicsModal() {
    const currentChat = chats.find(c => c.id == currentChatId);
    if (!currentChat) return;
    const topics = getTopicsFromMessages(currentChat.messages, currentChat.settings?.topicSummaries);
    const container = document.getElementById('topics-list-container');
    if (!container) return;

    if (topics.length === 0) {
        container.innerHTML = '<div style="padding: 20px; text-align: center;">暂无话题</div>';
    } else {
        container.innerHTML = topics.map((topic, idx) => {
            const firstMsg = topic.messages[0];
            const preview = firstMsg ? (firstMsg.text.length > 50 ? firstMsg.text.substring(0, 50) + '...' : firstMsg.text) : '无消息';
            const time = firstMsg ? firstMsg.time : '未知';
            return `
                <div class="topic-item${currentTopicIndex === idx ? ' active' : ''}" data-topic-index="${idx}">
                    <div class="topic-header">
                        <span class="topic-title">话题 ${idx + 1}</span>
                        <span class="topic-time">${time}</span>
                    </div>
                    <div class="topic-preview editable-preview" data-topic-index="${idx}" data-original="${escapeHtml(topic.summary || preview)}">${escapeHtml(topic.summary || preview)}</div>
                    <div class="topic-actions">
                        <button class="topic-gen-intro-btn" data-topic-index="${idx}"><i class="fas fa-magic"></i> 生成简介</button>
                        <button class="topic-export-btn" data-topic-index="${idx}"><i class="fas fa-download"></i> 导出</button>
                        <button class="topic-delete-btn" data-topic-index="${idx}"><i class="fas fa-trash-alt"></i> 删除</button>
                    </div>
                </div>
            `;
        }).join('');
        // 绑定可编辑预览区双击事件
        container.querySelectorAll('.editable-preview').forEach(elem => {
            elem.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                const topicIdx = parseInt(elem.getAttribute('data-topic-index'));
                const oldText = elem.innerText;
                // 创建输入框
                const input = document.createElement('input');
                input.type = 'text';
                input.value = oldText;
                input.style.width = '100%';
                input.style.background = 'rgba(30,34,55,0.9)';
                input.style.border = '1px solid #5f7eff';
                input.style.borderRadius = '8px';
                input.style.padding = '4px 8px';
                input.style.color = '#f0f3ff';
                elem.innerHTML = '';
                elem.appendChild(input);
                input.focus();
                
                const saveEdit = () => {
                    const newText = input.value.trim();
                    if (newText && newText !== oldText) {
                        // 更新存储
                        if (!currentChat.settings.topicSummaries) currentChat.settings.topicSummaries = {};
                        currentChat.settings.topicSummaries[topicIdx] = newText;
                        chatRepo.saveAllChats(chats);
                        // 更新显示
                        elem.innerText = newText;
                        elem.setAttribute('data-original', newText);
                    } else if (!newText) {
                        elem.innerText = oldText;
                    } else {
                        elem.innerText = oldText;
                    }
                };
                
                input.addEventListener('blur', saveEdit);
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        input.blur();
                    }
                });
            });
        });
        // 阻止单击简介时触发父级（.topic-item）的切换话题事件
        container.querySelectorAll('.topic-preview').forEach(preview => {
            preview.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });
        // 绑定生成简介按钮事件
        container.querySelectorAll('.topic-gen-intro-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-topic-index'));
                const topic = topics[idx];
                if (!topic) return;
                
                // 通过按钮找到所属的话题项，再找到预览区
                const topicItem = btn.closest('.topic-item');
                const summaryElem = topicItem ? topicItem.querySelector('.topic-preview') : null;
                if (summaryElem) {
                    summaryElem.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 生成中...';
                }
                
                const summary = await generateTopicSummary(idx, topic.messages);
                if (summary && summaryElem) {
                    // 保存到存储
                    if (!currentChat.settings.topicSummaries) currentChat.settings.topicSummaries = {};
                    currentChat.settings.topicSummaries[idx] = summary;
                    await chatRepo.saveAllChats(chats);
                    // 更新显示
                    summaryElem.innerHTML = escapeHtml(summary);
                    summaryElem.setAttribute('data-original', summary);  // 同步自定义属性
                } else if (summaryElem) {
                    summaryElem.innerHTML = '生成失败';
                }
            });
        });
        // 绑定切换按钮的事件
        container.querySelectorAll('.topic-item').forEach(btn => {
            btn.addEventListener('click', (e) => {
                // 如果点击的是按钮区域或其子元素，不触发切换
                if (e.target.closest('.topic-actions')) return;
                const idx = parseInt(btn.getAttribute('data-topic-index'));
                closeTopicsModal();                // 关闭话题管理弹窗
                setCurrentTopic(idx);             // 切换到该话题视图
            });
        });
        // 绑定导出和删除按钮事件
        container.querySelectorAll('.topic-export-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(btn.getAttribute('data-topic-index'));
                chatIO.exportTopic(idx, topics, currentChat);
            });
        });
        container.querySelectorAll('.topic-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-topic-index'));
                const topicItem = btn.closest('.topic-item');
                if (!topicItem || topicItem.classList.contains('removing')) return;
                // 检查流式状态
                const modelService = getModelService();
                if (modelService.isStreaming()) {
                    const confirmMsg = '当前正在生成回复，删除话题会中断本次回复。是否继续？';
                    if (!confirm(confirmMsg)) return;
                    modelService.abortCurrentStream();
                    releaseRequestLock();
                    ttsService.stop();
                }
                if (!confirm(`确定要删除话题 ${idx + 1} 吗？此操作不可撤销。`)) return;

                // 播放退出动画
                topicItem.classList.add('removing');

                // 等待动画结束或超时
                await new Promise(resolve => {
                    const onEnd = (e) => {
                        if (e.propertyName === 'transform') {
                            topicItem.removeEventListener('transitionend', onEnd);
                            resolve();
                        }
                    };
                    topicItem.addEventListener('transitionend', onEnd);
                    setTimeout(resolve, 500);   // 兜底
                });

                // 执行实际删除逻辑
                const topic = topics[idx];
                if (!topic) return;
                let start = topic.startIndex;
                let end = topic.endIndex;
                if (start > 0 && currentChat.messages[start - 1].type === 'divider') {
                    start = start - 1;
                }
                currentChat.messages.splice(start, end - start + 1);
                currentChat.date = new Date();

                // 更新聊天界面与历史列表
                renderMessages(currentChatId);
                renderHistoryList();
                chatRepo.saveAllChats(chats);

                // 若消息清空，自动开启新话题
                if (!currentChat.messages.some(msg => msg.type !== 'divider')) {
                    startNewTopic();
                }

                // 刷新话题管理弹窗（不关闭，只重绘列表）
                openTopicsModal();
            });
        });
    }

    const modal = document.getElementById('topics-modal');
    if (modal) modal.style.display = 'flex';
}

function closeTopicsModal() {
    const modal = document.getElementById('topics-modal');
    closeModalWithAnimation(modal);
}

function deleteTopic(topicIndex, topics, currentChat) {
    if (confirm(`确定要删除话题 ${topicIndex+1} 吗？此操作不可撤销。`)) {
        const topic = topics[topicIndex];
        if (!topic) return;
        // 删除该话题对应的消息（从 startIndex 到 endIndex）
        // 同时需要删除可能的前后分隔线？规则：删除话题时，如果话题前面有分隔线，则一并删除该分隔线，以保证话题列表连续
        let start = topic.startIndex;
        let end = topic.endIndex;
        // 如果 start > 0 且 messages[start-1] 是分隔线，则一并删除该分隔线
        if (start > 0 && currentChat.messages[start-1].type === 'divider') {
            start = start - 1;
        }
        // 如果 end+1 < messages.length 且 messages[end+1] 是分隔线，且该分隔线是下一个话题的开始，则也删除？通常不删，因为下一个话题需要分隔线。
        // 简单起见，只删除话题内容及其前面的分隔线（如果有）
        currentChat.messages.splice(start, end - start + 1);
        // 更新聊天记录时间
        currentChat.date = new Date();
        // 重新渲染
        renderMessages(currentChatId);
        renderHistoryList();
        chatRepo.saveChat(currentChat);
        if (!currentChat.messages.some(msg => msg.type !== 'divider')) {
            // 如果没有任何实际消息，自动开启一个新话题
            startNewTopic();
        }
        closeTopicsModal(); // 关闭弹窗
        openTopicsModal(); // 重新打开显示更新后的列表
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
        oldMessages.forEach(msg => msg.classList.add('fade-out'));
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    // 2. 临时禁用默认入场动画
    messagesContainer.classList.add('no-entry-animation');

    // 3. 更新话题索引并重新渲染
    currentTopicIndex = topicIndex;
    renderMessages(currentChatId, currentTopicIndex);

    // 4. 为新消息添加跌落动画（错开延迟）
    const newMessages = Array.from(messagesContainer.children).filter(
        child => child.classList && (child.classList.contains('message') || child.classList.contains('topic-divider'))
    );
    newMessages.forEach((msg, idx) => {
        msg.classList.add('topic-drop-in');
        msg.style.animationDelay = `${idx * 0.05}s`;
    });

    // 6. 动画结束后清理样式
    setTimeout(() => {
        newMessages.forEach(msg => {
            msg.classList.remove('topic-drop-in');
            msg.style.animationDelay = '';
        });
        messagesContainer.classList.remove('no-entry-animation');
    }, 500);
}

// 语音识别实例
let recognition = null;
let isListening = false;

function startVoiceInput() {
    // 检查安全上下文
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        customAlert('语音输入需要 HTTPS 环境，请在本地或部署到 HTTPS 站点后使用。\n当前页面协议：' + location.protocol, 'warn');
        return;
    }

    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        customAlert('您的浏览器不支持语音识别，请使用 Chrome、Edge 或 Safari 等现代浏览器。', 'warn');
        return;
    }

    if (isListening && recognition) {
        recognition.stop();
        return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.lang = Constants.SPEECH_RECOGNITION_LANG;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.start();
    isListening = true;

    const voiceBtn = document.getElementById('voice-input-btn');
    if (voiceBtn) {
        voiceBtn.style.background = '#4e6eff';
        voiceBtn.innerHTML = '<i class="fas fa-microphone-slash"></i> 语音输入 (聆听中...)';
    }

    recognition.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcript;
            } else {
                interimTranscript += transcript;
            }
        }
        const textarea = document.querySelector('.auto-expand-textarea');
        if (textarea) {
            if (interimTranscript) {
                textarea.value = interimTranscript;
                textarea.dispatchEvent(new Event('input'));
            }
            if (finalTranscript) {
                textarea.value = finalTranscript;
                textarea.dispatchEvent(new Event('input'));
            }
        }
    };

    recognition.onend = () => {
        isListening = false;
        if (voiceBtn) {
            voiceBtn.style.background = '';
            voiceBtn.innerHTML = '<i class="fas fa-microphone"></i> 语音输入';
        }
    };

    recognition.onerror = (event) => {
        console.error('语音识别错误', event.error);
        let errorMsg = '';
        switch (event.error) {
            case 'not-allowed':
                errorMsg = '请允许麦克风权限以使用语音输入。';
                break;
            case 'no-speech':
                errorMsg = '没有检测到语音，请重试。';
                break;
            case 'audio-capture':
                errorMsg = '无法获取麦克风，请检查设备连接。';
                break;
            case 'network':
                errorMsg = '网络错误，请检查网络连接，并确保页面在 HTTPS 或 localhost 环境下运行。';
                break;
            default:
                errorMsg = `语音识别失败：${event.error}`;
        }
        customAlert(errorMsg, 'error');
        recognition.stop();
        isListening = false;
        if (voiceBtn) {
            voiceBtn.style.background = '';
            voiceBtn.innerHTML = '<i class="fas fa-microphone"></i> 语音输入';
        }
    };
}

// 打开全局设置弹窗
function openGlobalSettings() {
    const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
    
    // 模型设置 - 主机和 API Key
    const modelHostInput = document.getElementById('model-host');
    const apiKeyInput = document.getElementById('api-key');
    if (modelHostInput) modelHostInput.value = globalSettings.modelHost || Constants.DEFAULT_MODEL_HOST;
    if (apiKeyInput) apiKeyInput.value = globalSettings.apiKey || '';
    
    // 用户管理
    const usernameInput = document.getElementById('global-username');
    const bioInput = document.getElementById('global-bio');
    if (usernameInput) usernameInput.value = globalSettings.username || '访客';
    if (bioInput) bioInput.value = globalSettings.bio || '';
    const avatarImg = document.getElementById('global-avatar-img');
    if (avatarImg && globalSettings.avatar) avatarImg.src = globalSettings.avatar;

    // 模型参数
    const ctxLimit = globalSettings.contextLimit !== undefined ? globalSettings.contextLimit : 10;
    const temp = globalSettings.temperature !== undefined ? globalSettings.temperature : 0.7;
    const topP = globalSettings.topP !== undefined ? globalSettings.topP : 0.9;
    
    const ctxSlider = document.getElementById('global-context-limit');
    const ctxUnlimitedCheck = document.getElementById('global-context-unlimited');
    const tempSlider = document.getElementById('global-temperature');
    const topPSlider = document.getElementById('global-top-p');
    const ttsApiUrlInput = document.getElementById('tts-api-url');
    
    // 音色克隆按钮事件
    let isCloning = false;
    const cloneBtn = document.getElementById('start-clone-btn');
    const cloneStatus = document.getElementById('clone-status');

    // 图片生成后端接口
    const imgApiUrlInput = document.getElementById('img-api-url');
    if (imgApiUrlInput) imgApiUrlInput.value = globalSettings.imgApiUrl || Constants.DEFAULT_IMG_API_URL;
    const imgApiKeyInput = document.getElementById('img-api-key');
    if (imgApiKeyInput) imgApiKeyInput.value = globalSettings.imgApiKey || '';
    
    if (cloneBtn) {
        const newCloneBtn = cloneBtn.cloneNode(true);
        cloneBtn.parentNode.replaceChild(newCloneBtn, cloneBtn);
        newCloneBtn.addEventListener('click', async () => {
            if (isCloning) {
                customAlert('正在克隆中，请稍候...');
                return;
            }
            const voiceName = document.getElementById('clone-voice-name').value.trim();
            if (!voiceName) {
                customAlert('请输入音色名称');
                return;
            }
            const audioFile = document.getElementById('clone-audio-file').files[0];
            if (!audioFile) {
                customAlert('请选择参考音频文件');
                return;
            }
            const audioText = document.getElementById('clone-audio-text').value.trim();
            if (!audioText) {
                customAlert('请填写音频对应的文本内容');
                return;
            }
            isCloning = true;
            const formData = new FormData();
            formData.append('voice_name', voiceName);
            formData.append('audio', audioFile);
            formData.append('ref_text', audioText);
            
            const ttsApiUrl = globalSettings.ttsApiUrl || Constants.DEFAULT_TTS_API_URL;
            
            cloneStatus.innerText = '正在克隆音色，请稍候...';
            cloneBtn.disabled = true;
            
            try {
                const response = await fetch(`${ttsApiUrl}/clone_voice`, {
                    method: 'POST',
                    body: formData
                });
                const result = await response.json();
                if (response.ok) {
                    cloneStatus.innerText = '✅ 音色克隆成功！已保存到音色库。';
                    TTsService.clearVoiceCache();  // 清空缓存
                    // 刷新音色列表显示
                    const voiceDisplaySpan = document.getElementById('voice-list-display');
                    if (voiceDisplaySpan) {
                        await TTsService.updateVoiceDisplay(voiceDisplaySpan, true);
                    }
                    // 清空表单
                    document.getElementById('clone-voice-name').value = '';
                    document.getElementById('clone-audio-file').value = '';
                    document.getElementById('clone-audio-text').value = '';
                } else {
                    cloneStatus.innerText = `❌ 克隆失败：${result.error}`;
                }
            } catch (err) {
                cloneStatus.innerText = `❌ 网络错误：${err.message}`;
            } finally {
                isCloning = false;
                newCloneBtn.disabled = false;
            }
        });
    }
    
    if (ttsApiUrlInput) ttsApiUrlInput.value = globalSettings.ttsApiUrl || Constants.DEFAULT_TTS_API_URL;
    const ttsApiKeyInput = document.getElementById('tts-api-key');
    if (ttsApiKeyInput) ttsApiKeyInput.value = globalSettings.ttsApiKey || '';
    if (ctxSlider) {
        if (globalSettings.contextUnlimited) {
            ctxUnlimitedCheck.checked = true;
            ctxSlider.disabled = true;
            document.getElementById('global-context-limit-value').innerText = '无限制';
        } else {
            ctxUnlimitedCheck.checked = false;
            ctxSlider.disabled = false;
            ctxSlider.value = globalSettings.contextLimit !== undefined ? globalSettings.contextLimit : 10;
            document.getElementById('global-context-limit-value').innerText = ctxSlider.value;
        }
        // 绑定复选框变化事件
        ctxUnlimitedCheck.onchange = () => {
            if (ctxUnlimitedCheck.checked) {
                ctxSlider.disabled = true;
                document.getElementById('global-context-limit-value').innerText = '无限制';
            } else {
                ctxSlider.disabled = false;
                ctxSlider.value = globalSettings.contextLimit !== undefined ? globalSettings.contextLimit : 10;
                document.getElementById('global-context-limit-value').innerText = ctxSlider.value;
            }
        };
        ctxSlider.oninput = () => {
            if (!ctxUnlimitedCheck.checked) {
                document.getElementById('global-context-limit-value').innerText = ctxSlider.value;
            }
        };
    }
    if (tempSlider) {
        tempSlider.value = temp;
        document.getElementById('global-temperature-value').innerText = temp;
        tempSlider.oninput = () => document.getElementById('global-temperature-value').innerText = tempSlider.value;
    }
    if (topPSlider) {
        topPSlider.value = topP;
        document.getElementById('global-top-p-value').innerText = topP;
        topPSlider.oninput = () => document.getElementById('global-top-p-value').innerText = topPSlider.value;
    }
    
    // 通用设置
    const themeSelect = document.getElementById('global-theme');
    const fontSizeSelect = document.getElementById('global-font-size');
    if (themeSelect) themeSelect.value = globalSettings.theme || 'dark';
    if (fontSizeSelect) fontSizeSelect.value = globalSettings.fontSize || 'medium';

    const modal = document.getElementById('global-settings-modal');
    if (modal) modal.style.display = 'flex';
    // 打字速度
    const typingSpeedSlider = document.getElementById('global-typing-speed');
    const typingSpeedSpan = document.getElementById('global-typing-speed-value');
    if (typingSpeedSlider) {
        const speed = globalSettings.typingSpeed !== undefined ? globalSettings.typingSpeed : 1.0;
        typingSpeedSlider.value = speed;
        const updateLabel = (val) => {
            if (val === 1.0) typingSpeedSpan.textContent = '原速';
            else typingSpeedSpan.textContent = val.toFixed(1) + 'x';
        };
        updateLabel(speed);
        typingSpeedSlider.oninput = () => updateLabel(parseFloat(typingSpeedSlider.value));
    }

    renderShortcutsPanel();
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

// 保存全局设置
function saveGlobalSettings() {
    const avatarImg = document.getElementById('global-avatar-img');
    let avatarSrc = avatarImg.src;
    const fontSize = document.getElementById('global-font-size').value;
    
    // 如果头像 Base64 长度超过 200KB（约 270,000 字符），尝试重新压缩或提示
    if (avatarSrc && avatarSrc.startsWith('data:image') && avatarSrc.length > 300000) {
        if (!confirm('头像图片过大，可能导致存储失败。是否继续保存？点击“确定”将尝试自动压缩。')) {
            return;
        }
        // 自动压缩：从当前图片元素重新生成压缩版（需要将 img 转为 canvas 再压缩）
        const tempImg = new Image();
        tempImg.onload = () => {
            const canvas = document.createElement('canvas');
            const maxWidth = 150;
            let width = tempImg.width;
            let height = tempImg.height;
            if (width > maxWidth) {
                height = (height * maxWidth) / width;
                width = maxWidth;
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(tempImg, 0, 0, width, height);
            const compressed = canvas.toDataURL('image/jpeg', 0.6);
            avatarImg.src = compressed;
            // 递归调用自身（但避免无限循环）
            setTimeout(() => saveGlobalSettings(), 10);
        };
        tempImg.src = avatarSrc;
        return;
    }
    const ctxUnlimited = document.getElementById('global-context-unlimited').checked;
    let contextLimit = parseInt(document.getElementById('global-context-limit').value);
    if (ctxUnlimited) contextLimit = -1; // 用 -1 表示无限制
    const quickSelect = document.getElementById('quick-model-select');
    let currentModel = Constants.DEFAULT_MODEL_NAME;
    if (quickSelect) {
        currentModel = quickSelect.value;
    } else {
        const models = ModelService.getModels();
        currentModel = models[0] || Constants.DEFAULT_MODEL_NAME;
    }
    const globalSettings = {
        modelHost: document.getElementById('model-host').value,
        apiKey: document.getElementById('api-key').value,
        username: document.getElementById('global-username').value,
        bio: document.getElementById('global-bio').value,
        avatar: document.getElementById('global-avatar-img').src,
        contextLimit: contextLimit,
        contextUnlimited: ctxUnlimited,
        temperature: parseFloat(document.getElementById('global-temperature').value),
        topP: parseFloat(document.getElementById('global-top-p').value),
        theme: document.getElementById('global-theme').value,
        fontSize: document.getElementById('global-font-size').value,
        modelName: currentModel,
        ttsApiUrl: document.getElementById('tts-api-url').value,
        shortcuts: currentShortcuts,
        imgApiUrl: document.getElementById('img-api-url').value,
        ttsApiKey: document.getElementById('tts-api-key').value,
        imgApiKey: document.getElementById('img-api-key').value,
        typingSpeed: parseFloat(document.getElementById('global-typing-speed').value),
    };
    if (modelServiceInstance) {
        const latestSettings = JSON.parse(localStorage.getItem('global_settings'));
        modelServiceInstance.updateConfig({
            modelHost: latestSettings.modelHost || Constants.DEFAULT_MODEL_HOST,
            apiKey: latestSettings.apiKey || '',
            modelName: latestSettings.modelName || Constants.DEFAULT_MODEL_NAME,
        });
    }
    try {
        localStorage.setItem('global_settings', JSON.stringify(globalSettings));
        closeGlobalModal();
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            customAlert('存储空间不足！请尝试：\n1. 删除一些旧对话\n2. 使用更小的头像图片\n3. 清理浏览器缓存', 'error');
        } else {
            customAlert('保存失败：' + e.message, 'error');
        }
    }
    
    // 应用主题
    applyTheme(globalSettings.theme);
    
    // 应用字体大小
    applyFontSize(fontSize);
    if (currentChatId) {
        renderMessages(currentChatId);
    }
    closeGlobalModal();
}

function closeGlobalModal() {
    const modal = document.getElementById('global-settings-modal');
    closeModalWithAnimation(modal);
}

function showFileContentModal(filename, content) {
    // 创建模态框
    const modal = document.createElement('div');
    modal.className = 'file-content-modal';
    modal.innerHTML = `
        <div class="file-content-modal-content">
            <div class="file-content-header">
                <span>${escapeHtml(filename)}</span>
                <button class="file-content-close">&times;</button>
            </div>
            <div class="file-content-body">
                <pre>${escapeHtml(content)}</pre>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.style.display = 'flex';
    const closeBtn = modal.querySelector('.file-content-close');
    closeBtn.addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
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

function showMessageActions(msgElement, type, text, time, saveToStorageFlag, chatIdForSave, customAvatarUrl, fileAttachment) {
    // 移除已存在的操作栏
    if (currentActionMenu) {
        if (currentActionClickHandler) {
            document.removeEventListener('click', currentActionClickHandler);
            currentActionClickHandler = null;
        }
        if (currentActionScrollHandler) {
            document.removeEventListener('scroll', currentActionScrollHandler);
            currentActionScrollHandler = null;
        }
        currentActionMenu.remove();
        currentActionMenu = null;
        currentActionMsgElement = null;
    }
    
    const bubble = msgElement.querySelector('.bubble');
    if (!bubble) return;
    
    // 获取气泡位置
    const rect = bubble.getBoundingClientRect();
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    
    // 创建操作栏
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';
    
    // 判断是否为最新的 AI 消息
    const currentChat = chats.find(c => c.id == currentChatId);
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
    currentActionMenu = actionsDiv;
    currentActionMsgElement = msgElement;
    
    // 定位操作栏
    const top = rect.bottom + scrollTop + 8;
    const left = rect.left + scrollLeft;
    actionsDiv.style.top = `${top}px`;
    actionsDiv.style.left = `${left}px`;
    const actionsRect = actionsDiv.getBoundingClientRect();
    if (actionsRect.right > window.innerWidth) {
        actionsDiv.style.left = `${window.innerWidth - actionsRect.width - 10 + scrollLeft}px`;
    }
    
    // 删除按钮
    const deleteBtn = actionsDiv.querySelector('.delete-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm('确定要删除这条消息吗？')) {
                await deleteMessageFromChat(type, text, time);
                closeActionMenu();
            }
        });
    }

    // 播放按钮
    const playBtn = actionsDiv.querySelector('.play-msg-btn');
    if (playBtn) {
        playBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            closeActionMenu();
            // 检查是否正在语音合成/播放
            if (ttsService.isSpeaking()) {
                customAlert('正在合成和播放语音，请稍后再试');
                return;
            }
            const currentChat = chats.find(c => c.id == currentChatId);
            const ttsEnabled = currentChat?.settings?.ttsEnabled;
            const ttsVoice = currentChat?.settings?.ttsVoice || 'default';
            if (ttsEnabled) {
                const { replyContent } = parseThinkContent(text);
                const contentToSpeak = replyContent || text;
                const parts = parseParenthesesContent(contentToSpeak);
                const speechText = parts.filter(p => p.type === 'speech').map(p => p.text).join('');
                if (speechText.trim()) {
                    updateStatusIndicator('speaking', '语音合成中 ...');
                    ttsService.speak(speechText, ttsVoice, playBtn)
                        .finally(() => updateStatusIndicator('online'));;
                } else {
                    customAlert('当前消息没有可朗读的语言内容');
                }
            } else {
                customAlert('当前对话未开启语音合成，请在对话设置中开启 TTS 开关');
            }
        });
    }
    // 生成按钮
    const generateReplyBtn = actionsDiv.querySelector('.generate-reply-btn');
    if (generateReplyBtn) {
        generateReplyBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            closeActionMenu();
            // 调用 AI 回复该用户消息
            await simulateAIResponse(text);
        });
    }
    // 重新生成按钮
    const regenBtn = actionsDiv.querySelector('.regenerate-btn');
    if (regenBtn) {
        regenBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            closeActionMenu();
            await regenerateAIMessage(text, time);
        });
    }
    
    // 继续说按钮
    const continueBtn = actionsDiv.querySelector('.continue-btn');
    if (continueBtn) {
        continueBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            closeActionMenu();
            if (isProcessing) {
                showBriefToast('请等待当前请求完成');
                return;
            }
            await continueAIMessage();
        });
    }

    // 引用按钮
    const quoteBtn = actionsDiv.querySelector('.quote-btn');
    if (quoteBtn) {
        quoteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // 构建引用文本（标记原消息角色）
            const chat = chats.find(c => c.id == currentChatId);
            if (!chat) return;
            const settings = chat.settings || Constants.DEFAULT_SETTINGS;
            const role = type === 'ai' ? settings.roleName : '用户';
            const quoteText = `引用消息> **${role}**：${text}\n\n`;
            // 插入到输入框
            const textarea = document.querySelector('.auto-expand-textarea');
            if (textarea) {
                // 若输入框已有内容，则在后面追加；否则直接设置
                textarea.value = textarea.value ? textarea.value + '\n' + quoteText : quoteText;
                textarea.dispatchEvent(new Event('input')); // 触发自动高度
                textarea.focus();
            }
            closeActionMenu();
        });
    }
    // 点击外部关闭
    const closeHandler = (e) => {
        if (!actionsDiv.contains(e.target) && e.target !== msgElement && !msgElement.contains(e.target)) {
            closeActionMenu();
            document.removeEventListener('click', closeHandler);
            document.removeEventListener('scroll', scrollCloseHandler);
        }
    };
    const scrollCloseHandler = () => closeActionMenu();
    chatMessages.addEventListener('scroll', scrollCloseHandler);
    setTimeout(() => {
        document.addEventListener('click', closeHandler);
    }, 0);
    currentActionClickHandler = closeHandler;
    currentActionScrollHandler = scrollCloseHandler;
    function closeActionMenu() {
        // 移除事件监听器
        if (currentActionClickHandler) {
            document.removeEventListener('click', currentActionClickHandler);
            currentActionClickHandler = null;
        }
        if (currentActionScrollHandler) {
            document.removeEventListener('scroll', currentActionScrollHandler);
            currentActionScrollHandler = null;
        }
        // 移除 DOM 元素
        if (actionsDiv && actionsDiv.parentNode) actionsDiv.remove();
        currentActionMenu = null;
        currentActionMsgElement = null;
    }
}

async function deleteMessageFromChat(type, text, time) {
    const currentChat = chats.find(c => c.id == currentChatId);
    if (!currentChat) return;
    
    // 查找匹配的消息（根据 type, text, time）
    const index = currentChat.messages.findIndex(msg => msg.type === type && msg.text === text && msg.time === time);
    if (index !== -1) {
        currentChat.messages.splice(index, 1);
        // 重新渲染当前对话
        renderMessages(currentChatId, currentTopicIndex);
        await chatRepo.saveChat(currentChat);
        // 更新历史列表时间（可选）
        if (currentChat.messages.length > 0) {
            currentChat.date = new Date();
            renderHistoryList();
        }
    } else {
        customAlert('无法找到该消息，删除失败', 'error');
    }
}

async function regenerateAIMessage(oldText, oldTime) {
    if (isProcessing) {
        showBriefToast('请等待当前请求完成');
        return;
    }
    const currentChat = chats.find(c => c.id == currentChatId);
    if (!currentChat) return;
    
    // 找到最后一条 AI 消息（应该是触发重新生成的那条）
    const lastIndex = currentChat.messages.length - 1;
    if (lastIndex < 0 || currentChat.messages[lastIndex].type !== 'ai') return;
    
    // 获取触发重新生成的用户消息（上一条用户消息）
    let userMsg = '';
    for (let i = lastIndex - 1; i >= 0; i--) {
        if (currentChat.messages[i].type === 'user') {
            userMsg = currentChat.messages[i].modelInputText || currentChat.messages[i].text;
            break;
        }
    }
    if (!userMsg) {
        appendMessageToDOM('ai', '无法找到对应的用户消息，无法重新生成。', getCurrentTime(), true);
        return;
    }
    
    // 删除原 AI 消息
    currentChat.messages.splice(lastIndex, 1);
    await chatRepo.saveChat(currentChat);
    // 重新渲染界面（移除原消息）
    renderMessages(currentChatId, currentTopicIndex);
    
    await simulateAIResponse(userMsg);
}

async function continueAIMessage() {
    const currentChat = chats.find(c => c.id == currentChatId);
    if (!currentChat) return;
    
    // 获取最后一条 AI 消息的内容（作为继续对话的上下文）
    const lastMsg = currentChat.messages[currentChat.messages.length - 1];
    if (!lastMsg || lastMsg.type !== 'ai') return;
    
    // 构造一个“继续说”的提示，例如：“请继续”
    const continuePrompt = '请继续刚才的话题，接着上面的内容继续说。';
    // 将该提示作为用户消息临时添加并发送
    // 为了用户体验，我们将在界面上显示一条用户消息“继续说”。
    const userTime = getCurrentTime();
    currentChat.messages.push({
        type: 'user',
        text: continuePrompt,
        time: userTime
    });
    await chatRepo.saveChat(currentChat);
    await appendMessageToDOM('user', continuePrompt, userTime, false);
    
    // 调用模型回复
    await simulateAIResponse(continuePrompt);
}

function performSearch(keyword) {
    if (!keyword.trim()) {
        const searchDropdown = document.getElementById('search-results-dropdown');
        searchDropdown.style.display = 'none';
        return;
    }
    const results = [];
    const lowerKeyword = keyword.toLowerCase();
    for (const chat of chats) {
        const settings = chat.settings || Constants.DEFAULT_SETTINGS;
        const roleName = settings.roleName || 'Nova';
        // 匹配会话标题（角色名）
        if (roleName.toLowerCase().includes(lowerKeyword)) {
            results.push({
                type: 'chat',
                chatId: chat.id,
                title: roleName,
                preview: '会话标题匹配'
            });
        }
        // 匹配消息内容
        let msgIndex = 0; // 普通消息的顺序索引
        for (let i = 0; i < chat.messages.length; i++) {
            const msg = chat.messages[i];
            if (msg.type === 'divider') continue;
            if (msg.text.toLowerCase().includes(lowerKeyword)) {
                results.push({
                    type: 'message',
                    chatId: chat.id,
                    messageIndex: msgIndex,
                    title: roleName,
                    preview: msg.text.length > 60 ? msg.text.substring(0, 60) + '...' : msg.text,
                    time: msg.time
                });
            }
            msgIndex++;
        }
    }
    renderSearchResults(results.slice(0, 20)); // 最多显示20条
}

function renderSearchResults(results) {
    const searchDropdown = document.getElementById('search-results-dropdown');
    if (results.length === 0) {
        searchDropdown.innerHTML = '<div class="search-dropdown-item" style="color:#8e8eb3;">未找到相关结果</div>';
        searchDropdown.style.display = 'block';
        return;
    }
    searchDropdown.innerHTML = results.map(result => {
        if (result.type === 'chat') {
            return `
                <div class="search-dropdown-item" data-chat-id="${result.chatId}" data-type="chat">
                    <div class="search-dropdown-title">
                        <i class="fas fa-comment"></i> ${escapeHtml(result.title)}
                        <span class="search-dropdown-badge">会话</span>
                    </div>
                    <div class="search-dropdown-preview">${escapeHtml(result.preview)}</div>
                </div>
            `;
        } else {
            return `
                <div class="search-dropdown-item" data-chat-id="${result.chatId}" data-type="message" data-message-index="${result.messageIndex}">
                    <div class="search-dropdown-title">
                        <i class="fas fa-comment-dots"></i> ${escapeHtml(result.title)}
                        <span class="search-dropdown-badge">消息</span>
                    </div>
                    <div class="search-dropdown-preview">${escapeHtml(result.preview)}</div>
                    <div style="font-size: 0.65rem; color:#8e8eb3; margin-top: 4px;">${escapeHtml(result.time)}</div>
                </div>
            `;
        }
    }).join('');
    searchDropdown.style.display = 'block';
    
    // 绑定点击事件
    document.querySelectorAll('.search-dropdown-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const chatId = parseInt(item.getAttribute('data-chat-id'));
            const type = item.getAttribute('data-type');
            const messageIndex = item.getAttribute('data-message-index');
            
            // 切换会话
            if (currentChatId !== chatId) {
                switchChat(chatId);
                // 等待渲染完成再滚动
                setTimeout(() => {
                    if (type === 'message' && messageIndex !== null) {
                        scrollToMessage(parseInt(messageIndex));
                    }
                }, 100);
            } else {
                // 同一会话
                if (type === 'message' && messageIndex !== null) {
                    scrollToMessage(parseInt(messageIndex));
                }
            }
            searchDropdown.style.display = 'none';
            const searchInput = document.getElementById('global-search-input');
            searchInput.value = ''; // 清空搜索框
        });
    });
}

function scrollToMessage(index) {
    const messages = document.querySelectorAll('.chat-messages .message');
    if (messages[index]) {
        messages[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
        // 高亮效果
        messages[index].style.transition = 'background 0.3s';
        messages[index].style.backgroundColor = 'rgba(95, 126, 255, 0.3)';
        setTimeout(() => {
            messages[index].style.backgroundColor = '';
        }, 1500);
    } else {
        // 如果消息未渲染（可能因为话题视图），先重置话题视图再滚动
        if (currentTopicIndex !== null) {
            currentTopicIndex = null;
            renderMessages(currentChatId);
            setTimeout(() => scrollToMessage(index), 100);
        }
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

function showBriefToast(message) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = 'position:fixed; bottom:80px; right:20px; background:#2a2f55; color:white; padding:8px 16px; border-radius:20px; z-index:10000;';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

function showCropModal(file, aspectRatio, options = {}, callback) {
    const modal = document.getElementById('crop-modal');
    const img = document.getElementById('crop-image');
    const closeBtn = document.getElementById('close-crop-modal');
    const cancelBtn = document.getElementById('cancel-crop-btn');
    const applyBtn = document.getElementById('apply-crop-btn');
    const content = modal.querySelector('.modal-content');

    if (cropper) {
        cropper.destroy();
        cropper = null;
    }

    let objectUrl = null;   // 用于后续释放

    const closeCropModal = () => {
        if (cropper) {
            cropper.destroy();
            cropper = null;
        }
        if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
        }
        content.classList.add('closing');
        content.addEventListener('animationend', function onAnimEnd() {
            content.classList.remove('closing');
            modal.style.display = 'none';
            content.removeEventListener('animationend', onAnimEnd);
        }, { once: true });
    };

    // 关键：使用 Object URL 代替 Data URL
    objectUrl = URL.createObjectURL(file);
    img.src = objectUrl;
    img.onload = () => {
        cropper = new Cropper(img, {
            aspectRatio: isNaN(aspectRatio) ? NaN : aspectRatio,
            viewMode: 1,
            autoCropArea: 1,
            responsive: true,
            background: false,
        });
        content.classList.remove('closing');
        modal.style.display = 'flex';
    };

    applyBtn.onclick = () => {
        if (!cropper) return;

        const { maxWidth, mimeType = 'image/jpeg', quality = 0.9 } = options;
        const canvasOptions = {};
        // 设置最大宽度限制，防止输出巨大 canvas
        if (maxWidth && maxWidth > 0) {
            canvasOptions.maxWidth = maxWidth;
        } else {
            canvasOptions.maxWidth = 1920;   // 默认上限，避免卡死
        }
        const canvas = cropper.getCroppedCanvas(canvasOptions);
        const dataUrl = canvas.toDataURL(mimeType, quality);

        cropper.destroy();
        cropper = null;
        closeCropModal();
        callback(dataUrl);
    };

    cancelBtn.onclick = closeCropModal;
    closeBtn.onclick = closeCropModal;
    modal.onclick = (e) => {
        if (e.target === modal) closeCropModal();
    };
}

// 全局快捷键处理
function handleKeyDown(e) {
    const pressed = eventToShortcutString(e);
    if (!pressed) return;

    // 先解析出动作
    let targetAction = null;
    for (const [action, keys] of Object.entries(currentShortcuts)) {
        if (normalizeShortcut(keys) === pressed) {
            targetAction = action;
            break;
        }
    }
    if (!targetAction) return;

    // 如果是聚焦类操作，不管焦点在哪里都执行
    if (targetAction === 'focus-input' || targetAction === 'focus-search') {
        e.preventDefault();
        e.stopPropagation();
        executeAction(targetAction);
        return;
    }

    // 其他快捷键：焦点在输入框或编辑区则忽略
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        return;
    }

    // 执行
    e.preventDefault();
    e.stopPropagation();
    executeAction(targetAction);
}


function executeAction(action) {
    switch (action) {
        case 'new-chat':          createNewChat(); break;
        case 'new-topic':         startNewTopic(); break;
        case 'prev-chat':         switchToPreviousChat(); break;
        case 'next-chat':         switchToNextChat(); break;
        case 'export-json':       chatIO.exportAsJSON(chats.find(c => c.id == currentChatId)); break;
        case 'focus-input':       focusChatInput(); break;
        case 'send-no-ai':        sendMessageWithoutAI(); break;
        case 'focus-search':      focusSearchInput(); break;
        case 'toggle-immersive':  toggleImmersiveMode(); break;
    }
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

// 聚焦搜索框
function focusSearchInput() {
    const searchInput = document.getElementById('global-search-input');
    const searchToggleBtn = document.getElementById('search-toggle-btn');
    if (searchInput) {
        // 如果输入框处于隐藏状态，先展开
        searchInput.classList.remove('search-input-hidden');
        searchToggleBtn.classList.add('hidden');
        // 等待一帧确保过渡开始后再聚焦
        requestAnimationFrame(() => searchInput.focus());
    }
}

// 发送消息但不触发 AI 回复
async function sendMessageWithoutAI() {
    if (isProcessing) {
        customAlert('AI 正在回复中，请稍候...', 'warning');
        return;
    }
    // 如果当前为“显示全部话题”模式，自动切换到最后一个话题
    if (currentTopicIndex === null) {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (currentChat) {
            const topics = getTopicsFromMessages(currentChat.messages);
            if (topics.length > 0) {
                await setCurrentTopic(topics.length - 1, false);
            }
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
    let modelUserMsg = text;
    if (fileAttachment) {
        modelUserMsg = text + `\n\n文件内容如下：\n\`\`\`\n${fileAttachment.content}\n\`\`\``;
    }
    const targetChat = chats.find(c => c.id == currentChatId);
    if (targetChat) {
        targetChat.messages.push({
            type: 'user',
            text: text,
            time: userTime,
            file: fileAttachment,
            modelInputText: modelUserMsg,
        });
        targetChat.date = new Date();
        renderHistoryList();
        await chatRepo.saveChat(targetChat);
    }
    await appendMessageToDOM('user', text, userTime, false, null, null, fileAttachment);
    messageInput.value = '';
    messageInput.style.height = 'auto';
    forceScrollToBottom();
}

function loadShortcutsFromStorage() {
    const global = JSON.parse(localStorage.getItem('global_settings')) || {};
    const storedShortcuts = global.shortcuts || {};

    // 构建默认快捷键映射（从 DEFAULT_SHORTCUTS 提取 keys 字符串）
    const defaultsMap = {};
    for (const [action, obj] of Object.entries(DEFAULT_SHORTCUTS)) {
        defaultsMap[action] = obj.keys;
    }

    // 用户存储的优先级更高，但默认值补齐未定义的项
    currentShortcuts = { ...defaultsMap, ...storedShortcuts };
    // 移除旧的监听器（如果存在）
    document.removeEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
}

function renderShortcutsPanel() {
    const container = document.getElementById('shortcuts-list');
    if (!container) return;
    loadShortcutsFromStorage(); // 确保 currentShortcuts 是最新的
    let html = '';
    for (const [action, keys] of Object.entries(currentShortcuts)) {
        const desc = DEFAULT_SHORTCUTS[action]?.description || action;
        html += `
            <div class="shortcut-row" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; background: rgba(30,34,55,0.5); border-radius:12px; padding:10px 16px;">
                <span>${desc}</span>
                <div style="display:flex; align-items:center; gap:8px;">
                    <kbd style="background: #1a1c2a; padding: 4px 10px; border-radius:6px; border:1px solid #5f7eff; min-width:80px; text-align:center; cursor:pointer;" class="shortcut-key" data-action="${action}">${keys.toUpperCase()}</kbd>
                </div>
            </div>`;
    }
    container.innerHTML = html;

    // 绑定记录按钮和点击kbd也可以触发记录
    document.querySelectorAll('.record-shortcut-btn, .shortcut-key').forEach(el => {
        el.addEventListener('click', (e) => {
            const action = el.getAttribute('data-action');
            const kbd = container.querySelector(`.shortcut-key[data-action="${action}"]`);
            if (kbd) kbd.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> 按下组合键...';
            startRecordShortcut(action, kbd);
        });
    });
}

function startRecordShortcut(action, displayElement) {
    const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const shortcut = eventToShortcutString(e);
        if (!shortcut) return;
        
        // 检查常见不可覆盖组合
        const conflict = isBrowserReserved(shortcut);
        if (conflict) {
            customAlert(`组合键 ${shortcut.toUpperCase()} 可能被浏览器保留，仍可设置但可能无法完全拦截默认行为。`);
        }
        currentShortcuts[action] = shortcut;
        if (displayElement) displayElement.textContent = shortcut.toUpperCase();
        document.removeEventListener('keydown', handler, true);
    };
    document.addEventListener('keydown', handler, true);
    // ... 超时回调 ...
}

function showFullscreenImage(src) {
    // 移除已有的全屏层
    const existing = document.querySelector('.fullscreen-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'fullscreen-overlay';
    overlay.innerHTML = `<img src="${src}" alt="预览">`;
    // 点击关闭
    overlay.addEventListener('click', () => overlay.remove());
    // Esc 关闭（全局 Esc 监听中需追加处理，见后文）
    document.addEventListener('keydown', function onEsc(e) {
        if (e.key === 'Escape') {
            overlay.remove();
            document.removeEventListener('keydown', onEsc);
        }
    });
    document.body.appendChild(overlay);
}

async function deletePictureMessage(msgElement, msgData) {
    const currentChat = chats.find(c => c.id == currentChatId);
    if (!currentChat) return;

    const index = currentChat.messages.findIndex(m => m.isImage && m.time === msgData.time && m.text === msgData.src);
    if (index !== -1) {
        currentChat.messages.splice(index, 1);
        await chatRepo.saveChat(currentChat);
        msgElement.remove();
        renderHistoryList();
    }
}

// ========== 自定义弹窗 ==========
function showCustomDialog(options) {
    const {
        title = '提示',
        message = '',
        buttons = [{ text: '确定', value: true, className: 'save' }],
        closable = true
    } = options;

    const modal = document.getElementById('custom-dialog');
    const titleEl = document.getElementById('custom-dialog-title');
    const messageEl = document.getElementById('custom-dialog-message');
    const footerEl = document.getElementById('custom-dialog-footer');
    const closeBtn = document.getElementById('custom-dialog-close');

    return new Promise((resolve) => {
        // 清理旧事件（通过克隆节点移除监听器）
        footerEl.innerHTML = '';

        // 设置标题和消息
        titleEl.innerHTML = title;
        messageEl.innerHTML = message.replace(/\n/g, '<br>'); // 支持换行

        // 创建按钮
        buttons.forEach(btn => {
            const button = document.createElement('button');
            button.className = `modal-btn ${btn.className || ''}`;
            button.textContent = btn.text;
            button.addEventListener('click', () => {
                closeModal();
                resolve(btn.value);
            });
            footerEl.appendChild(button);
        });

        // 关闭行为
        const closeModal = () => {
            modal.style.display = 'none';
            cleanup();
        };

        // 清理事件监听
        const cleanup = () => {
            closeBtn.removeEventListener('click', onClose);
            modal.removeEventListener('click', onOverlayClick);
            document.removeEventListener('keydown', onEsc);
        };

        const onClose = () => {
            if (closable) {
                resolve(buttons.length > 0 ? buttons[0].value : null); // 默认返回第一个按钮的值或null
                closeModal();
            }
        };

        const onOverlayClick = (e) => {
            if (e.target === modal && closable) {
                onClose();
            }
        };

        const onEsc = (e) => {
            if (e.key === 'Escape' && closable) {
                onClose();
            }
        };

        closeBtn.addEventListener('click', onClose);
        modal.addEventListener('click', onOverlayClick);
        document.addEventListener('keydown', onEsc);

        modal.style.display = 'flex';
    });
}

async function customAlert(message, type = 'info') {
    const typeMap = {
        info:    { title: '提示', icon: 'fa-info-circle' },
        warning: { title: '警告', icon: 'fa-exclamation-triangle' },
        error:   { title: '错误', icon: 'fa-times-circle' },
        success: { title: '成功', icon: 'fa-check-circle' }
    };
    const { title, icon } = typeMap[type] || typeMap.info;
    await showCustomDialog({
        title: `<i class="fas ${icon}"></i> ${title}`,
        message: message,
        buttons: [{ text: '确定', value: undefined, className: 'save' }]
    });
}

// 暂未使用
// async function customConfirm(message) {
//     const result = await showCustomDialog({
//         title: '确认操作',
//         message: message,
//         buttons: [
//             { text: '取消', value: false, className: 'cancel' },
//             { text: '确定', value: true, className: 'save' }
//         ],
//         closable: true  // 点击关闭或遮罩也视为取消
//     });
//     return result === true;
// }

// 沉浸模式切换
function toggleImmersiveMode() {
    const body = document.body;
    const isImmersive = body.classList.toggle('immersive-mode');
    
    // 移动端：退出沉浸模式时自动关闭侧边栏打开状态
    if (!isImmersive && window.innerWidth <= 768) {
        const sidebar = document.querySelector('.sidebar');
        if (sidebar && sidebar.classList.contains('open')) {
            sidebar.classList.remove('open');
        }
    }
    
    // 可选：显示提示（非必须，可取消注释）
    const toast = document.createElement('div');
    toast.textContent = isImmersive ? '🌙 沉浸模式已开启 (再次按快捷键退出)' : '✨ 已退出沉浸模式';
    toast.style.cssText = 'position:fixed; bottom:80px; right:20px; background:#2a2f55; color:white; padding:8px 16px; border-radius:20px; z-index:10000;';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

async function init() {
    await initData();
    const savedGlobal = JSON.parse(localStorage.getItem('global_settings')) || {};
    applyTheme(savedGlobal.theme || 'dark');
    initResizer();
    loadShortcutsFromStorage();
    bindEvents();
    getModelService();
    renderModelListUI();      // 渲染模型列表弹窗
    updateModelSelector();    // 更新快速切换下拉框
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
