// js/file-upload.js
import Constants from './constants.js';
import { compressImage, createThumbnail } from './utils.js';

export class FileUploadService {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.previewArea - 文本文件预览区域
     * @param {HTMLElement} options.fileNameSpan - 显示文件名的 span
     * @param {HTMLElement} options.imagePreviewArea - 图片预览区域
     * @param {Function} options.onFileLoaded - 文本文件加载完成的回调 (file, content)
     * @param {Function} options.onFileCleared - 文本文件清除的回调
     * @param {Function} options.onImageAdded - 图片添加回调 (dataUrl, index)
     * @param {Function} options.onImageRemoved - 图片移除回调 (index)
     * @param {string[]} options.allowedExtensions - 文本文件允许的扩展名
     * @param {string[]} options.allowedImageExtensions - 图片允许的扩展名
     * @param {number} options.maxSize - 文本文件最大大小
     * @param {number} options.maxImageSize - 图片最大大小
     * @param {Function} options.alertFn - 提示函数
     */
    constructor(options = {}) {
        this.previewArea = options.previewArea || null;
        this.fileNameSpan = options.fileNameSpan || null;
        this.imagePreviewArea = options.imagePreviewArea || null;
        this.onFileLoaded = options.onFileLoaded || null;
        this.onFileCleared = options.onFileCleared || null;
        this.onImageAdded = options.onImageAdded || null;
        this.onImageRemoved = options.onImageRemoved || null;
        this.allowedExtensions = options.allowedExtensions || Constants.ALLOWED_FILE_EXTENSIONS;
        this.allowedImageExtensions = options.allowedImageExtensions || Constants.ALLOWED_IMAGE_EXTENSIONS;
        this.maxSize = options.maxSize || Constants.MAX_FILE_SIZE;
        this.maxImageSize = options.maxImageSize || Constants.MAX_IMAGE_SIZE;
        this.maxImageDim = options.maxImageDim || Constants.IMAGE_MAX_DIMENSION;
        this.imageQuality = options.imageQuality || Constants.IMAGE_QUALITY;
        this.alertFn = options.alertFn || ((msg, type) => alert(msg));
    }

    // 文本文件
    #currentFile = null;
    #currentContent = null;

    // 图片列表（支持多张）
    #currentImages = [];       // [{ name, dataUrl }]
    #currentImageFiles = [];   // File 对象引用

    // ========== 文本文件 getter ==========
    getCurrentFile() { return this.#currentFile; }
    getCurrentContent() { return this.#currentContent; }

    getFileAttachment() {
        if (this.#currentFile && this.#currentContent) {
            return { name: this.#currentFile.name, content: this.#currentContent };
        }
        return null;
    }

    // ========== 图片 getter ==========
    getImageCount() { return this.#currentImages.length; }

    /** @returns {Array<{name: string, dataUrl: string}>} */
    getImageAttachments() { return [...this.#currentImages]; }

    /** @returns {string[]} 完整图 dataUrl 数组（用于 API 请求，保证图片质量） */
    getImageDataUrls() { return this.#currentImages.map(img => img.fullDataUrl || img.dataUrl); }

    // ========== 文件类型检测 ==========
    #isImageFile(file) {
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        return this.allowedImageExtensions.includes(ext);
    }

    #isAllowedTextFile(file) {
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        return this.allowedExtensions.includes(ext);
    }

    // ========== 处理文件入口 ==========
    /**
     * @param {File} file
     * @returns {Promise<boolean>}
     */
    async handleFile(file) {
        if (!file) return false;
        if (this.#isImageFile(file)) {
            return this.#handleImageFile(file);
        }
        if (this.#isAllowedTextFile(file)) {
            return this.#handleTextFile(file);
        }
        this.alertFn(`不支持的文件类型 (${file.name})`, 'error');
        return false;
    }

    // ========== 文本文件处理 ==========
    async #handleTextFile(file) {
        if (file.size > this.maxSize) {
            this.alertFn(`文件过大，请选择小于 ${this.maxSize / (1024 * 1024)} MB 的文件`, 'error');
            return false;
        }
        try {
            const content = await this.#readFileAsText(file);
            this.#currentFile = file;
            this.#currentContent = content;
            this.#showTextPreview(file.name);
            if (this.onFileLoaded) this.onFileLoaded(file, content);
            return true;
        } catch (err) {
            this.alertFn('文件读取失败，请重试', 'error');
            return false;
        }
    }

    #readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file, 'UTF-8');
        });
    }

    #showTextPreview(filename) {
        if (this.previewArea && this.fileNameSpan) {
            this.fileNameSpan.innerText = filename;
            this.previewArea.style.display = 'block';
        }
    }

    #hideTextPreview() {
        if (this.previewArea) this.previewArea.style.display = 'none';
    }

    // ========== 图片文件处理 ==========
    async #handleImageFile(file) {
        if (file.size > this.maxImageSize) {
            this.alertFn(`图片过大，请选择小于 ${this.maxImageSize / (1024 * 1024)} MB 的图片`, 'error');
            return false;
        }
        try {
            // 1. 压缩到完整尺寸（用于 API 传输和点击放大）
            const fullDataUrl = await compressImage(file, this.maxImageDim, this.imageQuality);
            // 2. 生成缩略图（用于聊天列表展示，节省 IndexedDB 存储和 DOM 内存）
            const thumbnailDataUrl = await createThumbnail(fullDataUrl, 300, 0.7);
            const idx = this.#currentImages.length;
            this.#currentImages.push({
                name: file.name,
                dataUrl: thumbnailDataUrl,       // 缩略图 → 聊天展示
                fullDataUrl: fullDataUrl         // 完整图 → API / 点击放大
            });
            this.#currentImageFiles.push(file);
            this.#showImagePreviews();
            if (this.onImageAdded) this.onImageAdded(thumbnailDataUrl, idx);
            return true;
        } catch (err) {
            this.alertFn('图片读取失败，请重试', 'error');
            return false;
        }
    }

    /** 移除指定索引的图片 */
    removeImage(index) {
        if (index >= 0 && index < this.#currentImages.length) {
            this.#currentImages.splice(index, 1);
            this.#currentImageFiles.splice(index, 1);
            this.#showImagePreviews();
            if (this.onImageRemoved) this.onImageRemoved(index);
        }
    }

    #showImagePreviews() {
        if (!this.imagePreviewArea) return;
        if (this.#currentImages.length === 0) {
            this.imagePreviewArea.style.display = 'none';
            this.imagePreviewArea.innerHTML = '';
            return;
        }
        this.imagePreviewArea.style.display = 'flex';
        this.imagePreviewArea.innerHTML = this.#currentImages.map((img, i) => `
            <div class="image-preview-item" data-index="${i}">
                <img src="${img.dataUrl}" alt="${img.name}" title="${img.name}">
                <button type="button" class="image-remove-btn" data-index="${i}" title="移除图片">&times;</button>
            </div>
        `).join('');
        // 绑定移除按钮
        this.imagePreviewArea.querySelectorAll('.image-remove-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index);
                this.removeImage(idx);
            });
        });
    }

    // ========== 清除 ==========
    clearFile() {
        this.#currentFile = null;
        this.#currentContent = null;
        this.#hideTextPreview();
        if (this.onFileCleared) this.onFileCleared();
    }

    clearImages() {
        this.#currentImages = [];
        this.#currentImageFiles = [];
        if (this.imagePreviewArea) {
            this.imagePreviewArea.style.display = 'none';
            this.imagePreviewArea.innerHTML = '';
        }
    }

    clearAll() {
        this.clearFile();
        this.clearImages();
    }

    // ========== 文件/图片选择对话框（合并入口） ==========
    selectFileOrImage() {
        const input = document.createElement('input');
        input.type = 'file';
        // 合并文本文件和图片的 accept
        input.accept = [...this.allowedExtensions, ...this.allowedImageExtensions].join(',');
        input.multiple = true;
        input.onchange = async (e) => {
            for (const file of e.target.files) {
                await this.handleFile(file);
            }
        };
        input.click();
    }

    // ========== 拖拽支持 ==========
    setupDragAndDrop(dropZoneElement) {
        if (!dropZoneElement) return;

        const dragEvents = ['dragenter', 'dragover', 'dragleave', 'drop'];
        dragEvents.forEach(eventName => {
            dropZoneElement.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
        });

        dropZoneElement.addEventListener('dragenter', () => {
            dropZoneElement.classList.add('drag-over');
        });
        dropZoneElement.addEventListener('dragleave', () => {
            dropZoneElement.classList.remove('drag-over');
        });
        dropZoneElement.addEventListener('drop', async (e) => {
            dropZoneElement.classList.remove('drag-over');
            for (const file of e.dataTransfer.files) {
                await this.handleFile(file);
            }
        });
    }
}
