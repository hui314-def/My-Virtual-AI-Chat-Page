// 搜索模块，负责全局搜索逻辑与 UI 事件绑定。
import { escapeHtml } from './utils.js';

export class SearchManager {
    /**
     * @param {Object} ctx — 由 script.js 注入的依赖
     * @param {Function} ctx.getChats          — () => Array  获取当前 chats 数组
     * @param {Function} ctx.getCurrentChatId  — () => number 获取当前对话 ID
     * @param {Function} ctx.setCurrentTopicIndex — (v) 设置当前话题索引
     * @param {Function} ctx.getCurrentTopicIndex — () => number
     * @param {Function} ctx.switchChat        — (chatId) 切换对话
     * @param {Function} ctx.renderMessages    — (chatId, topicIdx?) 渲染消息
     */
    #debounceTimer = null;

    constructor(ctx) {
        this.ctx = ctx;
    }

    // ==================== 搜索逻辑 ====================

    /**
     * 全量搜索所有会话的消息和标题
     * @param {string} keyword
     */
    performSearch(keyword) {
        const dropdown = document.getElementById('search-results-dropdown');
        if (!keyword.trim()) {
            dropdown.style.display = 'none';
            return;
        }
        const results = [];
        const lowerKeyword = keyword.toLowerCase();
        const chats = this.ctx.getChats();

        for (const chat of chats) {
            const settings = chat.settings || {};
            const roleName = settings.roleName || 'Nova';

            // 匹配会话标题
            if (roleName.toLowerCase().includes(lowerKeyword)) {
                results.push({
                    type: 'chat',
                    chatId: chat.id,
                    title: roleName,
                    preview: '会话标题匹配'
                });
            }

            // 匹配消息内容
            let msgIndex = 0;
            for (const msg of chat.messages) {
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
        this.#renderResults(results.slice(0, 20));
    }

    /** 渲染搜索结果下拉 */
    #renderResults(results) {
        const dropdown = document.getElementById('search-results-dropdown');
        if (results.length === 0) {
            dropdown.innerHTML = '<div class="search-dropdown-item" style="color:#8e8eb3;">未找到相关结果</div>';
            dropdown.style.display = 'block';
            return;
        }
        dropdown.innerHTML = results.map(result => {
            const escapedTitle = escapeHtml(result.title);
            const escapedPreview = escapeHtml(result.preview);
            if (result.type === 'chat') {
                return `<div class="search-dropdown-item" data-chat-id="${result.chatId}" data-type="chat">
                    <div class="search-dropdown-title"><i class="fas fa-comment"></i> ${escapedTitle}<span class="search-dropdown-badge">会话</span></div>
                    <div class="search-dropdown-preview">${escapedPreview}</div>
                </div>`;
            }
            return `<div class="search-dropdown-item" data-chat-id="${result.chatId}" data-type="message" data-message-index="${result.messageIndex}">
                <div class="search-dropdown-title"><i class="fas fa-comment-dots"></i> ${escapedTitle}<span class="search-dropdown-badge">消息</span></div>
                <div class="search-dropdown-preview">${escapedPreview}</div>
                <div style="font-size:0.65rem;color:#8e8eb3;margin-top:4px;">${escapeHtml(result.time)}</div>
            </div>`;
        }).join('');
        dropdown.style.display = 'block';

        // 绑定结果点击
        dropdown.querySelectorAll('.search-dropdown-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const chatId = parseInt(item.getAttribute('data-chat-id'));
                const type = item.getAttribute('data-type');
                const messageIndex = item.getAttribute('data-message-index');

                if (this.ctx.getCurrentChatId() !== chatId) {
                    this.ctx.switchChat(chatId);
                    setTimeout(() => {
                        if (type === 'message' && messageIndex !== null) {
                            this.scrollToMessage(parseInt(messageIndex));
                        }
                    }, 100);
                } else {
                    if (type === 'message' && messageIndex !== null) {
                        this.scrollToMessage(parseInt(messageIndex));
                    }
                }
                dropdown.style.display = 'none';
                document.getElementById('global-search-input').value = '';
            });
        });
    }

    /**
     * 滚动到指定消息索引并高亮
     * @param {number} index
     */
    scrollToMessage(index) {
        const messages = document.querySelectorAll('.chat-messages .message');
        if (messages[index]) {
            messages[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
            messages[index].style.transition = 'background 0.3s';
            messages[index].style.backgroundColor = 'rgba(95, 126, 255, 0.3)';
            setTimeout(() => { messages[index].style.backgroundColor = ''; }, 1500);
        } else {
            // 如果消息未渲染（话题视图），先重置
            if (this.ctx.getCurrentTopicIndex() !== null) {
                this.ctx.setCurrentTopicIndex(null);
                this.ctx.renderMessages(this.ctx.getCurrentChatId());
                setTimeout(() => this.scrollToMessage(index), 100);
            }
        }
    }

    // ==================== UI 事件绑定 ====================

    /**
     * 绑定搜索框的展开/收起/输入/ESC 等事件。
     * 由 script.js 的 bindEvents() 中调用。
     */
    setupUI() {
        const searchInput = document.getElementById('global-search-input');
        const searchToggleBtn = document.getElementById('search-toggle-btn');
        const searchDropdown = document.getElementById('search-results-dropdown');

        const collapseSearch = () => {
            searchInput.classList.add('search-input-hidden');
            searchInput.value = '';
            searchToggleBtn.classList.remove('hidden');
            searchDropdown.style.display = 'none';
        };

        if (searchToggleBtn && searchInput) {
            searchToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (searchInput.classList.contains('search-input-hidden')) {
                    searchInput.classList.remove('search-input-hidden');
                    searchToggleBtn.classList.add('hidden');
                    setTimeout(() => searchInput.focus(), 50);
                } else {
                    collapseSearch();
                }
            });

            // 点击搜索容器外部时收起
            document.addEventListener('click', (e) => {
                if (!document.getElementById('search-container').contains(e.target)) {
                    collapseSearch();
                }
            });

            // ESC 键收起
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') collapseSearch();
            });
        }

        // 搜索输入（300ms 防抖）
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                clearTimeout(this.#debounceTimer);
                this.#debounceTimer = setTimeout(() => {
                    this.performSearch(e.target.value);
                }, 300);
            });
        }

        // 点击搜索下拉框外部时隐藏
        document.addEventListener('click', (e) => {
            const si = document.getElementById('global-search-input');
            const sd = document.getElementById('search-results-dropdown');
            if (si && sd && !si.contains(e.target) && !sd.contains(e.target)) {
                sd.style.display = 'none';
            }
        });
    }

    /** 展开搜索框并聚焦 */
    focusSearchInput() {
        const searchInput = document.getElementById('global-search-input');
        const searchToggleBtn = document.getElementById('search-toggle-btn');
        if (searchInput) {
            searchInput.classList.remove('search-input-hidden');
            if (searchToggleBtn) searchToggleBtn.classList.add('hidden');
            requestAnimationFrame(() => searchInput.focus());
        }
    }
}

export default SearchManager;
