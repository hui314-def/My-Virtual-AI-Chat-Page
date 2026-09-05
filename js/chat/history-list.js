// 历史列表渲染、会话菜单(导出/置顶/删除)、知识库标签恢复
// 从 script.js 分离(阶段2),风格与其余 js/ 模块一致(构造注入依赖)
import Constants from '../core/constants.js';
import { escapeHtml, formatDate } from '../core/utils.js';
import { resolveAssetUrl } from '../network/asset-sync.js';

export class HistoryList {
    /**
     * @param {Object} deps
     * @param {() => Array} deps.getChats
     * @param {() => number|string|null} deps.getCurrentChatId
     * @param {HTMLElement} deps.historyListEl 历史列表容器(.history-list)
     * @param {Object} deps.chatIO 导入导出服务
     * @param {() => Object} deps.getChatManager 惰性获取 chatManager(切换/置顶/删除)
     * @param {() => void} deps.closeSidebarOnMobile 移动端关闭侧边栏
     */
    constructor({ getChats, getCurrentChatId, historyListEl, chatIO, getChatManager, closeSidebarOnMobile }) {
        this.getChats = getChats;
        this.getCurrentChatId = getCurrentChatId;
        this.historyList = historyListEl;
        this.chatIO = chatIO;
        this.getChatManager = getChatManager;
        this.closeSidebarOnMobile = closeSidebarOnMobile;
        // 保持稳定引用,便于 removeEventListener / addEventListener 配对
        this.historyClickHandler = (e) => this.handleHistoryClick(e);
    }

    get chats() { return this.getChats(); }
    get currentChatId() { return this.getCurrentChatId(); }
    get chatManager() { return this.getChatManager(); }

    // 渲染左侧历史列表
    renderHistoryList() {
        if (!this.historyList) return;
        this.historyList.innerHTML = '';
        // 排序：置顶的在前，然后按时间倒序（最新的在前）
        const sortedChats = [...this.chats].sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return b.date - a.date;
        });
        sortedChats.forEach(chat => {
            const settings = chat.settings || Constants.DEFAULT_SETTINGS;
            const roleName = settings.roleName || Constants.DEFAULT_ROLE_NAME;
            const avatarUrl = settings.avatarUrl;

            const historyItem = document.createElement('div');
            historyItem.className = `history-item ${this.currentChatId === chat.id ? 'active' : ''}`;
            historyItem.setAttribute('data-id', chat.id);

            let avatarHtml = '';
            if (avatarUrl) {
                avatarHtml = `<img src="${resolveAssetUrl(avatarUrl)}" class="history-avatar-img" alt="avatar">`;
            } else {
                avatarHtml = `<i class="fas fa-robot history-default-icon"></i>`;
            }

            // 标题行：角色名称 + 星星（如果置顶）
            const starHtml = chat.pinned ? '<i class="fas fa-star pin-star"></i>' : '';

            historyItem.innerHTML = `
                <div class="history-avatar">
                    ${avatarHtml}
                </div >
                <div class="history-info">
                    <div class="title">
                        ${escapeHtml(roleName)}
                        ${starHtml}
                    </div >
                    <div class="date">${formatDate(chat.date)}</div >
                </div >
            `;
            const menuTrigger = document.createElement('div');
            menuTrigger.className = 'history-menu-trigger';
            menuTrigger.innerHTML = '<i class="fas fa-ellipsis-v"></i>';
            historyItem.appendChild(menuTrigger);
            this.historyList.appendChild(historyItem);

            this.attachMenuEvents(historyItem, chat);
        });
        if (this.chats.length === 0) {
            this.historyList.innerHTML = '<div style="padding:20px; text-align:center; opacity:0.5;">暂无对话，点击“新对话”开始</div >';
        }
        this.attachHistoryClickEvents();
    }

    // 为历史项绑定点击切换
    attachHistoryClickEvents() {
        const items = document.querySelectorAll('.history-item');
        items.forEach(item => {
            item.removeEventListener('click', this.historyClickHandler);
            item.addEventListener('click', this.historyClickHandler);
        });
    }

    handleHistoryClick(e) {
        const targetItem = e.currentTarget;
        const chatId = parseInt(targetItem.getAttribute('data-id'));
        if (!isNaN(chatId)) {
            this.closeSidebarOnMobile();
            this.chatManager.switchChat(chatId);
        }
    }

    // 为每个历史项绑定菜单弹出逻辑
    attachMenuEvents(historyItem, chat) {
        const trigger = historyItem.querySelector('.history-menu-trigger');
        if (!trigger) return;
        let currentMenu = null;
        let scrollCloseHandler = null;

        const closeMenu = () => {
            if (currentMenu && currentMenu.parentNode) currentMenu.remove();
            currentMenu = null;
            document.removeEventListener('click', outsideClickListener);
            if (scrollCloseHandler && this.historyList) {
                this.historyList.removeEventListener('scroll', scrollCloseHandler);
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
                </div >
                <div class="history-menu-item" data-action="pin">
                    <i class="fas ${pinIcon}"></i> ${pinText}
                </div >
                <div class="history-menu-item delete-item" data-action="delete">
                    <i class="fas fa-trash-alt"></i> 删除会话
                </div >
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
                    if (action === 'export-json') this.chatIO.exportAsJSON(chat);
                    else if (action === 'pin') this.chatManager.togglePinChat(chat);
                    else if (action === 'delete') this.chatManager.deleteChat(chat.id);
                    closeMenu();
                });
            });

            // 绑定滚动关闭：滚动历史列表时关闭菜单
            scrollCloseHandler = () => closeMenu();
            this.historyList.addEventListener('scroll', scrollCloseHandler);
            // 点击外部关闭
            setTimeout(() => {
                document.addEventListener('click', outsideClickListener);
            }, 0);
        });
    }

    // 恢复上次选中的知识库(更新工具栏按钮标签)
    restoreSelectedKnowledgeBase() {
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
}
