// js/file-upload.js
import Constants from './constants.js';

export class FileUploadService {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.previewArea - 显示文件预览的区域
     * @param {HTMLElement} options.fileNameSpan - 显示文件名的 span 元素
     * @param {Function} options.onFileLoaded - 文件加载完成的回调 (file, content)
     * @param {Function} options.onFileCleared - 文件清除的回调
     * @param {string[]} options.allowedExtensions - 允许的扩展名，默认使用 Constants.ALLOWED_FILE_EXTENSIONS
     * @param {number} options.maxSize - 最大文件大小（字节），默认 Constants.MAX_FILE_SIZE
     * @param {Function} options.alertFn - 提示函数，默认 alert
     */
    constructor(options = {}) {
        this.previewArea = options.previewArea || null;
        this.fileNameSpan = options.fileNameSpan || null;
        this.onFileLoaded = options.onFileLoaded || null;
        this.onFileCleared = options.onFileCleared || null;
        this.allowedExtensions = options.allowedExtensions || Constants.ALLOWED_FILE_EXTENSIONS;
        this.maxSize = options.maxSize || Constants.MAX_FILE_SIZE;
        this.alertFn = options.alertFn || ((msg, type) => alert(msg));
        this.#currentFile = null;     // 存储当前选中的文件对象
        this.#currentContent = null;  // 存储读取的文件内容
    }
    // 私有字段（使用 # 确保真正私有，或使用 this._ 约定）
    #currentFile = null;
    #currentContent = null;

    // 公开 getter 方法
    getCurrentFile() { return this.#currentFile; }
    getCurrentContent() { return this.#currentContent; }

    /**
     * 获取文件附件对象（用于消息）
     * @returns {Object|null} { name, content } 或 null
     */
    getFileAttachment() {
        if (this.#currentFile && this.#currentContent) {
            return {
                name: this.#currentFile.name,
                content: this.#currentContent
            };
        }
        return null;
    }
    /**
     * 处理选中的文件（校验 + 读取）
     * @param {File} file
     * @returns {Promise<boolean>} 是否成功
     */
    async handleFile(file) {
        if (!file) return false;
        // 校验扩展名
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        if (!this.allowedExtensions.includes(ext)) {
            this.alertFn(`不支持的文件类型，请上传以下类型：${this.allowedExtensions.join(', ')}`, 'error');
            return false;
        }
        // 校验大小
        if (file.size > this.maxSize) {
            this.alertFn(`文件过大，请选择小于 ${this.maxSize / (1024 * 1024)} MB 的文件`, 'error');
            return false;
        }
        // 读取文件内容
        try {
            const content = await this.#readFileAsText(file);
            this.#currentFile = file;
            this.#currentContent = content;
            this.#showPreview(file.name);
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

    #showPreview(filename) {
        if (this.previewArea && this.fileNameSpan) {
            this.fileNameSpan.innerText = filename;
            this.previewArea.style.display = 'block';
        }
    }

    #hidePreview() {
        if (this.previewArea) this.previewArea.style.display = 'none';
    }

    // 清除当前文件
    clearFile() {
        this.#currentFile = null;
        this.#currentContent = null;
        this.#hidePreview();
        if (this.onFileCleared) this.onFileCleared();
    }

    // 打开文件选择对话框
    selectFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = this.allowedExtensions.map(ext => ext).join(',');
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) this.handleFile(file);
        };
        input.click();
    }

    /**
     * 设置拖拽区域
     * @param {HTMLElement} dropZoneElement
     */
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
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                await this.handleFile(files[0]);
            }
        });
    }
}