// 上传与媒体预览绑定:背景/头像/文件上传、粘贴图片、拖拽上传、全屏图片预览
// 从 script.js 的 bindToolbarButtons 分离(阶段4),风格与其余 js/ 模块一致(构造注入依赖)
import Constants from './constants.js';
import { compressImage } from './utils.js';
import BackgroundManager from './background-manager.js';

export class UploadBindings {
    /**
     * @param {Object} deps
     * @param {Object} deps.fileUpload FileUploadService 实例
     * @param {() => Object} deps.getModalManager 惰性获取 modalManager(裁剪弹窗/提示,运行时才调用)
     */
    constructor({ fileUpload, getModalManager }) {
        this.fileUpload = fileUpload;
        this.getModalManager = getModalManager;
    }

    /** 运行时才解析 modalManager 引用 */
    get modalManager() {
        return this.getModalManager();
    }

    /** 绑定所有上传与媒体预览事件 */
    bind() {
        this.bindBackgroundUpload();
        this.bindAvatarUpload();
        this.bindFileButtons();
        this.bindPasteImage();
        this.bindDragAndDrop();
        this.bindImagePreview();
    }

    // 背景图片上传(裁剪后实时预览)
    bindBackgroundUpload() {
        const bgUpload = document.getElementById('bg-upload');
        if (!bgUpload) return;
        bgUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            this.modalManager.showCropModal(file, NaN, { maxWidth: Constants.BG_CROP_MAX_WIDTH, mimeType: 'image/jpeg' }, (croppedDataUrl) => {
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

    // 头像上传(压缩后预览)
    bindAvatarUpload() {
        const avatarUpload = document.getElementById('global-avatar-upload');
        if (!avatarUpload) return;
        avatarUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const compressedUrl = await compressImage(file, Constants.AVATAR_MAX_WIDTH, Constants.AVATAR_JPEG_QUALITY);
                document.getElementById('global-avatar-img').src = compressedUrl;
            } catch (err) {
                console.error('头像压缩失败', err);
                this.modalManager.customAlert('头像处理失败，请重试', 'error');
            }
        });
    }

    // 文件上传 / 清除按钮
    bindFileButtons() {
        const uploadBtn = document.getElementById('upload-file-btn');
        if (uploadBtn) uploadBtn.addEventListener('click', () => this.fileUpload.selectFileOrImage());
        const removeFileBtn = document.getElementById('remove-file-btn');
        if (removeFileBtn) removeFileBtn.addEventListener('click', () => this.fileUpload.clearFile());
    }

    // 粘贴图片(Ctrl+V)
    bindPasteImage() {
        const chatInput = document.querySelector('.auto-expand-textarea');
        if (!chatInput) return;
        chatInput.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    this.fileUpload.handleFile(file);
                }
            }
        });
    }

    // 拖拽上传
    bindDragAndDrop() {
        const dropZone = document.querySelector('.chat-messages');
        if (dropZone) this.fileUpload.setupDragAndDrop(dropZone);
    }

    // 点击消息中的图片放大查看(样式由 CSS .fullscreen-overlay 提供)
    bindImagePreview() {
        const chatMessages = document.querySelector('.chat-messages');
        if (!chatMessages) return;
        chatMessages.addEventListener('click', (e) => {
            const img = e.target.closest('.message-image');
            if (!img) return;
            // 优先使用完整图(data-full-img)，回退到 src(旧格式兼容)
            const src = img.dataset.fullImg || img.src;
            if (!src) return;
            // 全屏预览
            const overlay = document.createElement('div');
            overlay.className = 'fullscreen-overlay';
            overlay.innerHTML = `<img src="${src}" alt="图片预览">`;
            overlay.addEventListener('click', () => overlay.remove());
            document.body.appendChild(overlay);
        });
    }
}
