// 搜索模块，负责全局搜索逻辑与 UI 事件绑定。
import { escapeHtml } from './utils.js';
import Constants from './constants.js';

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
            const roleName = settings.roleName || Constants.DEFAULT_ROLE_NAME;

            // 匹配会话标题
            if (roleName.toLowerCase().includes(lowerKeyword)) {
                results.push({
                    type: 'chat',
                    chatId: chat.id,
                    title: roleName,
                    preview: '会话标题匹配'
                });
            }

            // 匹配消息内容（遍历话题 → 消息）
            const topics = chat.topics || [];
            for (let topicIdx = 0; topicIdx < topics.length; topicIdx++) {
                const topic = topics[topicIdx];
                for (let msgIdx = 0; msgIdx < topic.messages.length; msgIdx++) {
                    const msg = topic.messages[msgIdx];
                    if (msg.text.toLowerCase().includes(lowerKeyword)) {
                        results.push({
                            type: 'message',
                            chatId: chat.id,
                            topicIndex: topicIdx,
                            messageIndex: msgIdx,
                            title: roleName,
                            preview: msg.text.length > Constants.QUOTE_PREVIEW_MAX_LEN ? msg.text.substring(0, Constants.QUOTE_PREVIEW_MAX_LEN) + '...' : msg.text,
                            time: msg.time
                        });
                    }
                }
            }
        }
        this.#renderResults(results.slice(0, Constants.SEARCH_RESULT_LIMIT));
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
            return `<div class="search-dropdown-item" data-chat-id="${result.chatId}" data-type="message" data-topic-index="${result.topicIndex}" data-message-index="${result.messageIndex}">
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
                const topicIndex = item.getAttribute('data-topic-index');
                const messageIndex = item.getAttribute('data-message-index');

                if (this.ctx.getCurrentChatId() !== chatId) {
                    this.ctx.switchChat(chatId);
                    setTimeout(() => {
                        if (type === 'message' && topicIndex !== null && messageIndex !== null) {
                            this.scrollToMessage(parseInt(topicIndex), parseInt(messageIndex));
                        }
                    }, 100);
                } else {
                    if (type === 'message' && topicIndex !== null && messageIndex !== null) {
                        this.scrollToMessage(parseInt(topicIndex), parseInt(messageIndex));
                    }
                }
                dropdown.style.display = 'none';
                document.getElementById('global-search-input').value = '';
            });
        });
    }

    /**
     * 滚动到指定话题的消息并高亮
     * @param {number} topicIndex
     * @param {number} messageIndex
     */
    scrollToMessage(topicIndex, messageIndex) {
        // 如果当前话题不匹配，先切换到正确的话题
        if (this.ctx.getCurrentTopicIndex() !== topicIndex) {
            this.ctx.setCurrentTopicIndex(topicIndex);
            this.ctx.renderMessages(this.ctx.getCurrentChatId(), topicIndex);
            setTimeout(() => this.scrollToMessage(topicIndex, messageIndex), 100);
            return;
        }
        const messages = document.querySelectorAll('.chat-messages .message');
        if (messages[messageIndex]) {
            messages[messageIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
            messages[messageIndex].style.transition = 'background 0.3s';
            messages[messageIndex].style.backgroundColor = 'rgba(95, 126, 255, 0.3)';
            setTimeout(() => { messages[messageIndex].style.backgroundColor = ''; }, Constants.HIGHLIGHT_DURATION_MS);
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
                }, Constants.SEARCH_DEBOUNCE_MS);
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
