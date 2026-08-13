// 图片生成模块
// 处理图片生成弹窗的交互和 API 调用。
import { getCurrentTime } from './utils.js';

export class ImageGenService {
    /**
     * @param {Object} ctx
     * @param {Function} ctx.isProcessing        — () => boolean，检查 AI 是否正在回复
     * @param {Function} ctx.customAlert          — (msg, type) => void
     * @param {Function} ctx.getImgApiUrl         — () => string
     * @param {Function} ctx.getImgApiKey         — () => string
     * @param {Function} ctx.appendMessageToDOM   — (type, text, time, saveToStorageFlag?) => Promise
     * @param {Function} ctx.appendImageToDOM     — (type, imgSrc, time, saveToStorageFlag?) => Promise
     * @param {Function} ctx.forceScrollToBottom  — () => void
     * @param {Function} ctx.getAutoScrollAfterSend — () => boolean
     */
    constructor(ctx) {
        this.ctx = ctx;
    }

    /** 绑定图片生成弹窗的所有事件 */
    bindImageGeneration() {
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
        if (startBtn) startBtn.addEventListener('click', () => this.startImageGen());
    }

    /** 执行图片生成（读取表单 → 调用后端 API → 将结果追加到聊天区） */
    async startImageGen() {
        if (this.ctx.isProcessing()) {
            this.ctx.customAlert('AI 正在回复中，请等待完成后再生成图片。', 'warning');
            return;
        }
        const prompt = document.getElementById('image-gen-prompt').value;
        if (!prompt) { this.ctx.customAlert('请输入图片描述'); return; }

        const negative = document.getElementById('image-gen-negative').value;
        const size = document.getElementById('image-gen-ratio').value;
        const count = parseInt(document.getElementById('image-gen-count').value);
        const model = document.getElementById('image-gen-model').value;
        const imgApiUrl = this.ctx.getImgApiUrl();
        const imgApiKey = this.ctx.getImgApiKey();
        const headers = { 'Content-Type': 'application/json' };
        if (imgApiKey) headers['X-API-Key'] = imgApiKey;

        document.getElementById('image-gen-modal').style.display = 'none';
        await this.ctx.appendMessageToDOM('ai', `🎨 正在生成 ${count} 张图片...`, getCurrentTime(), false);
        if (this.ctx.getAutoScrollAfterSend()) this.ctx.forceScrollToBottom();

        try {
            const response = await fetch(`${imgApiUrl}/generate_image`, {
                method: 'POST', headers,
                body: JSON.stringify({ prompt, negative, size, count, model })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '生成失败');
            for (const imgB64 of data.images) {
                const imgSrc = imgB64.startsWith('data:') ? imgB64 : `data:image/png;base64,${imgB64}`;
                await this.ctx.appendImageToDOM('ai', imgSrc, getCurrentTime(), true);
            }
        } catch (error) {
            this.ctx.appendMessageToDOM('ai', `❌ 图片生成失败: ${error.message}`, getCurrentTime(), true);
        }
    }
}
