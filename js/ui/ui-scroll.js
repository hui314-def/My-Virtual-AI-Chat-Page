// 滚动控制与请求锁管理
// 负责:输入区禁用/启用、请求锁(isProcessing)、自动滚动逻辑
// 从 script.js 分离(阶段1),风格与其余 js/ 模块一致(构造注入依赖)
import Constants from '../core/constants.js';

export class UiScroll {
    /**
     * @param {Object} deps
     * @param {HTMLElement} deps.chatMessagesEl 消息滚动容器(.chat-messages)
     * @param {HTMLElement} deps.sendBtnEl 发送按钮(.send-btn)
     */
    constructor({ chatMessagesEl, sendBtnEl }) {
        this.chatMessages = chatMessagesEl;
        this.sendBtn = sendBtnEl;
        this.isProcessing = false;      // 请求进行中(全局唯一锁)
        this.autoScrollEnabled = true;  // 是否允许自动滚动
    }

    // ==================== 请求生命周期管理(避免并发与竞态) ====================
    /** 返回 true 表示取得锁并开始请求,false 表示已有请求在进行 */
    acquireRequestLock() {
        if (this.isProcessing) return false;
        this.isProcessing = true;
        this.disableInput();
        return true;
    }

    /** 结束请求,恢复输入 */
    releaseRequestLock() {
        this.isProcessing = false;
        this.enableInput();
    }

    // 禁用输入区域
    disableInput() {
        if (this.sendBtn) {
            this.sendBtn.style.pointerEvents = 'none';
            this.sendBtn.style.opacity = '0.5';
        }
    }

    // 启用输入区域
    enableInput() {
        if (this.sendBtn) {
            this.sendBtn.style.pointerEvents = 'auto';
            this.sendBtn.style.opacity = '1';
        }
    }

    // ==================== 滚动控制 ====================
    updateAutoScrollFlag() {
        if (!this.chatMessages) return;
        const { scrollTop, scrollHeight, clientHeight } = this.chatMessages;
        const atBottom = scrollHeight - scrollTop - clientHeight <= Constants.SCROLL_THRESHOLD; // 距离底部阈值(px)
        this.autoScrollEnabled = atBottom;
    }

    conditionalScrollToBottom() {
        if (this.autoScrollEnabled) {
            this.scrollToBottom();
        }
    }

    forceScrollToBottom() {
        this.autoScrollEnabled = true;
        this.scrollToBottom();
    }

    scrollToBottom() {
        if (this.chatMessages) this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }
}
