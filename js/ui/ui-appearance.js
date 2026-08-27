// 界面外观控制:主题切换、消息字体大小、状态指示器
// 从 script.js 分离(阶段1),风格与其余 js/ 模块一致(构造注入依赖)
export class UiAppearance {
    /**
     * @param {Object} deps
     * @param {HTMLElement} deps.chatMessagesEl 消息容器(切换字体大小时需强制重绘)
     */
    constructor({ chatMessagesEl }) {
        this.chatMessages = chatMessagesEl;
        this.currentStatus = 'online';  // 记录当前状态指示器状态
    }

    // 应用主题(明亮/暗黑)
    applyTheme(theme) {
        // 计算实际应使用的主题(亮色/暗色)
        let effectiveTheme = theme;
        if (theme === 'auto') {
            effectiveTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        }

        if (effectiveTheme === 'light') {
            document.body.classList.add('light-theme');
        } else {
            document.body.classList.remove('light-theme');
        }

        // 同步下拉框的值(如果与传入的 theme 不同,说明是 auto 触发的实际显示,但下拉框保留 auto)
        const themeSelect = document.getElementById('global-theme');
        if (themeSelect && themeSelect.value !== theme) {
            themeSelect.value = theme;
        }
    }

    // 应用消息字体大小
    applyFontSize(size) {
        let fontSizeValue = '14px';
        if (size === 'small') fontSizeValue = '12px';
        else if (size === 'large') fontSizeValue = '16px';
        else fontSizeValue = '14px';

        // 移除旧的 style 标签,重新添加确保优先级
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

        // 强制重绘当前聊天区域(可选,确保所有消息重新计算样式)
        if (this.chatMessages) {
            this.chatMessages.style.display = 'none';
            this.chatMessages.offsetHeight; // 强制重排
            this.chatMessages.style.display = '';
        }
    }

    // 状态指示器控制
    updateStatusIndicator(state, customText = null) {
        const statusTextElem = document.querySelector('.user-details p');
        if (!statusTextElem) return;
        this.currentStatus = state;

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
}
