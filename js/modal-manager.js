// 弹窗管理模块，负责所有模态框的打开/关闭/保存逻辑。
// 依赖通过构造函数注入，避免循环引用。
import Constants from './constants.js';
import { SettingsManager } from './settings-manager.js';
import { TTsService } from './tts-service.js';
import { ModelService } from './model-service.js';
import { KnowledgeBaseManager } from './knowledge-base-manager.js';
import { TokenTracker } from './token-tracker.js';
import { escapeHtml } from './utils.js';
import AssetStore from './asset-store.js';

export class ModalManager {
    /**
     * @param {Object} ctx — 由 script.js 注入的上下文依赖
     * @param {Array}  ctx.chats           — 所有对话数组（可变引用）
     * @param {number} ctx.currentChatId   — 当前对话 ID（可变引用，通过 getter/setter 访问）
     * @param {number} ctx.currentTopicIndex — 当前话题索引（可变引用）
     * @param {Object} ctx.chatRepo        — ChatRepository 实例
     * @param {Object} ctx.chatIO          — ChatIO 实例
     * @param {Object} ctx.ttsService      — TTsService 实例
     * @param {Object} ctx.modelServiceInstanceRef — { value: ModelService|null } 模型服务实例的包装引用
     * @param {Object} ctx.cropperRef      — { value: Cropper|null } 裁剪器实例的包装引用
     * @param {Function} ctx.getShortcuts — () => Object  获取当前快捷键映射
     * @param {Function} ctx.getModelService    — () => ModelService
     * @param {Function} ctx.releaseRequestLock — 释放请求锁
     * @param {Function} ctx.renderMessages     — (chatId, topicIndex?) 渲染消息
     * @param {Function} ctx.renderHistoryList  — 渲染左侧历史列表
     * @param {Function} ctx.applyCurrentChatSettings — 应用当前对话设置
     * @param {Function} ctx.startNewTopic      — 开启新话题
     * @param {Function} ctx.setCurrentTopic    — (topicIndex) 切换话题视图
     * @param {Function} ctx.applyTheme         — (theme) 应用主题
     * @param {Function} ctx.applyFontSize      — (size) 应用字体大小
     * @param {Function} ctx.renderShortcutsPanel — 渲染快捷键面板
     * @param {Function} ctx.bindAutoResize     — (textarea) 绑定自动扩展
     * @param {Function} ctx.updateModelSelector — 更新快速切换下拉框
     * @param {Function} ctx.renderModelListUI  — 渲染模型列表 UI
     * @param {Function} ctx.saveModelListToStorage — 保存模型列表
     * @param {Function} ctx.addModel           — (name) 添加模型
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.kbManager = new KnowledgeBaseManager({
            customAlert: (msg, type) => this.customAlert(msg, type),
            showCustomDialog: (opts) => this.showCustomDialog(opts),
        });
    }

    // ==================== 工具方法 ====================

    /**
     * 关闭弹窗（带动画）
     * @param {HTMLElement} modal - 弹窗元素
     * @param {Function} [afterClose] - 关闭后的回调
     */
    closeModalWithAnimation(modal, afterClose) {
        if (!modal) return;
        const content = modal.querySelector('.modal-content');
        if (!content) {
            modal.style.display = 'none';
            if (afterClose) afterClose();
            return;
        }
        if (content.classList.contains('closing')) return;

        content.classList.add('closing');
        const onAnimationEnd = () => {
            content.classList.remove('closing');
            modal.style.display = 'none';
            content.removeEventListener('animationend', onAnimationEnd);
            if (afterClose) afterClose();
        };
        content.addEventListener('animationend', onAnimationEnd, { once: true });
        setTimeout(() => {
            if (modal.style.display !== 'none') {
                content.classList.remove('closing');
                modal.style.display = 'none';
                if (afterClose) afterClose();
            }
        }, 200);
    }

    /** 显示轻量 toast 提示 */
    showBriefToast(message) {
        const toast = document.createElement('div');
        toast.textContent = message;
        toast.style.cssText = 'position:fixed; bottom:80px; right:20px; background:#2a2f55; color:white; padding:8px 16px; border-radius:20px; z-index:10000;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    /**
     * 绑定弹窗遮罩点击关闭事件（防止拖选文本时误关闭）
     * 只有当 mousedown 和 click 都发生在遮罩上时才关闭弹窗。
     * @param {HTMLElement} modal - 弹窗元素
     * @param {Function} closeCallback - 关闭回调
     * @returns {{ unbind: Function }} 返回包含 unbind 方法的对象，用于解绑
     */
    bindModalOverlayClose(modal, closeCallback) {
        let mousedownOnOverlay = false;
        const onMouseDown = (e) => {
            mousedownOnOverlay = (e.target === modal);
        };
        const onClick = (e) => {
            if (e.target === modal && mousedownOnOverlay) {
                closeCallback();
            }
        };
        modal.addEventListener('mousedown', onMouseDown);
        modal.addEventListener('click', onClick);
        return {
            unbind: () => {
                modal.removeEventListener('mousedown', onMouseDown);
                modal.removeEventListener('click', onClick);
            }
        };
    }

    // ==================== 通用弹窗 ====================

    /**
     * 自定义弹窗（异步，返回用户选择的值）
     * @param {Object} options
     * @param {string} options.title
     * @param {string} options.message
     * @param {Array<{text:string, value:any, className?:string}>} options.buttons
     * @param {boolean} options.closable
     * @returns {Promise<any>}
     */
    showCustomDialog(options) {
        const {
            title = '提示',
            message = '',
            buttons = [{ text: '确定', value: true, className: 'save' }],
            closable = true,
            isHtml = false
        } = options;

        const modal = document.getElementById('custom-dialog');
        const titleEl = document.getElementById('custom-dialog-title');
        const messageEl = document.getElementById('custom-dialog-message');
        const footerEl = document.getElementById('custom-dialog-footer');
        const closeBtn = document.getElementById('custom-dialog-close');

        return new Promise((resolve) => {
            footerEl.innerHTML = '';
            titleEl.innerHTML = title;
            if (isHtml) messageEl.innerHTML = message;
            else messageEl.innerHTML = message.replace(/\n/g, '<br>');

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

            const closeModal = () => {
                modal.style.display = 'none';
                cleanup();
            };

            const cleanup = () => {
                closeBtn.removeEventListener('click', onClose);
                if (overlayBinding) overlayBinding.unbind();
                document.removeEventListener('keydown', onEsc);
            };

            const onClose = () => {
                if (closable) {
                    resolve(buttons.length > 0 ? buttons[0].value : null);
                    closeModal();
                }
            };

            const onEsc = (e) => {
                if (e.key === 'Escape' && closable) onClose();
            };

            closeBtn.addEventListener('click', onClose);
            const overlayBinding = closable ? this.bindModalOverlayClose(modal, onClose) : null;
            document.addEventListener('keydown', onEsc);
            modal.style.display = 'flex';
        });
    }

    /** 异步 alert 弹窗 */
    async customAlert(message, type = 'info') {
        const typeMap = {
            info:    { title: '提示', icon: 'fa-info-circle' },
            warning: { title: '警告', icon: 'fa-exclamation-triangle' },
            error:   { title: '错误', icon: 'fa-times-circle' },
            success: { title: '成功', icon: 'fa-check-circle' }
        };
        const { title, icon } = typeMap[type] || typeMap.info;
        await this.showCustomDialog({
            title: `<i class="fas ${icon}"></i> ${title}`,
            message: message,
            buttons: [{ text: '确定', value: undefined, className: 'save' }]
        });
    }

    // ==================== 文件内容弹窗 / 全屏图片 ====================

    showFileContentModal(filename, content) {
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
        this.bindModalOverlayClose(modal, () => modal.remove());
    }

    showFullscreenImage(src) {
        const existing = document.querySelector('.fullscreen-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'fullscreen-overlay';
        overlay.innerHTML = `<img src="${src}" alt="预览">`;
        overlay.addEventListener('click', () => overlay.remove());
        document.addEventListener('keydown', function onEsc(e) {
            if (e.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', onEsc);
            }
        });
        document.body.appendChild(overlay);
    }

    // ==================== 裁剪弹窗 ====================

    showCropModal(file, aspectRatio, options = {}, callback) {
        const modal = document.getElementById('crop-modal');
        const img = document.getElementById('crop-image');
        const closeBtn = document.getElementById('close-crop-modal');
        const cancelBtn = document.getElementById('cancel-crop-btn');
        const applyBtn = document.getElementById('apply-crop-btn');
        const content = modal.querySelector('.modal-content');

        if (this.ctx.cropperRef.value) {
            this.ctx.cropperRef.value.destroy();
            this.ctx.cropperRef.value = null;
        }

        // 解绑上次的遮罩点击事件，避免重复绑定
        if (this._cropOverlayBinding) {
            this._cropOverlayBinding.unbind();
            this._cropOverlayBinding = null;
        }

        let objectUrl = null;

        const closeCropModal = () => {
            // 解绑遮罩点击事件
            if (this._cropOverlayBinding) {
                this._cropOverlayBinding.unbind();
                this._cropOverlayBinding = null;
            }
            if (this.ctx.cropperRef.value) {
                this.ctx.cropperRef.value.destroy();
                this.ctx.cropperRef.value = null;
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

        objectUrl = URL.createObjectURL(file);
        img.src = objectUrl;
        img.onload = () => {
            this.ctx.cropperRef.value = new Cropper(img, {
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
            if (!this.ctx.cropperRef.value) return;
            const { maxWidth, mimeType = 'image/jpeg', quality = 0.9 } = options;
            const canvasOptions = {};
            if (maxWidth && maxWidth > 0) canvasOptions.maxWidth = maxWidth;
            else canvasOptions.maxWidth = 1920;
            const canvas = this.ctx.cropperRef.value.getCroppedCanvas(canvasOptions);
            const dataUrl = canvas.toDataURL(mimeType, quality);
            this.ctx.cropperRef.value.destroy();
            this.ctx.cropperRef.value = null;
            closeCropModal();
            callback(dataUrl);
        };

        cancelBtn.onclick = closeCropModal;
        closeBtn.onclick = closeCropModal;
        this._cropOverlayBinding = this.bindModalOverlayClose(modal, closeCropModal);
    }

    // ==================== 对话设置弹窗（per-chat settings） ====================

    openSettingsModal() {
        const ctx = this.ctx;
        const currentChat = ctx.chats.find(c => c.id == ctx.currentChatId);
        if (!currentChat) return;
        const settings = currentChat.settings || Constants.DEFAULT_SETTINGS;

        const contextLimit = settings.contextLimit !== undefined ? settings.contextLimit : 10;
        const contextUnlimited = (settings.contextLimit === -1);
        const temperature = settings.temperature !== undefined ? settings.temperature : 0.7;
        const topP = settings.topP !== undefined ? settings.topP : 0.9;
        const thinkLevel = settings.thinkLevel !== undefined ? settings.thinkLevel : 0;
        const maxTokens = settings.maxTokens !== undefined ? settings.maxTokens : 500;

        const modal = document.getElementById('settings-modal');
        const roleNameInput = document.getElementById('role-name');
        const rolePersona = document.getElementById('role-persona');
        const roleGreeting = document.getElementById('role-greeting');
        const avatarImg = document.getElementById('avatar-img');
        const bgImg = document.getElementById('bg-img');
        const contextLimitSlider = document.getElementById('context-limit');
        const contextLimitSpan = document.getElementById('context-limit-value');
        const contextUnlimitedCheck = document.getElementById('context-unlimited');
        const temperatureSlider = document.getElementById('temperature');
        const temperatureSpan = document.getElementById('temperature-value');
        const topPSlider = document.getElementById('top-p');
        const topPSpan = document.getElementById('top-p-value');
        const thinkLevelSlider = document.getElementById('think-level');
        const thinkLevelSpan = document.getElementById('think-level-value');
        const maxTokensSlider = document.getElementById('max-tokens');
        const maxTokensSpan = document.getElementById('max-tokens-value');
        const ttsSwitch = document.getElementById('tts-switch');
        const ttsVoiceSelect = document.getElementById('tts-voice-select');
        const ttsVoiceGroup = document.getElementById('tts-voice-group');

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
            temperatureSlider.oninput = () => { temperatureSpan.innerText = temperatureSlider.value; };
        }
        if (topPSlider) {
            topPSlider.value = topP;
            topPSpan.innerText = topP;
            topPSlider.oninput = () => { topPSpan.innerText = topPSlider.value; };
        }
        if (thinkLevelSlider) {
            thinkLevelSlider.value = thinkLevel;
            thinkLevelSpan.innerText = Constants.THINK_LEVELS[thinkLevel];
            thinkLevelSlider.oninput = () => {
                const idx = parseInt(thinkLevelSlider.value);
                thinkLevelSpan.innerText = Constants.THINK_LEVELS[idx];
            };
        }
        if (maxTokensSlider) {
            maxTokensSlider.value = maxTokens;
            maxTokensSpan.innerText = maxTokens;
            maxTokensSlider.oninput = () => { maxTokensSpan.innerText = maxTokensSlider.value; };
        }

        roleNameInput.value = settings.roleName;
        rolePersona.value = settings.persona;
        roleGreeting.value = settings.greeting;
        if (settings.avatarUrl) { avatarImg.src = settings.avatarUrl; avatarImg.setAttribute('data-custom', 'true'); }
        else { avatarImg.src = Constants.DEFAULT_AI_AVATAR; avatarImg.removeAttribute('data-custom'); }

        // ---- 背景类型选择 ----
        const bgTypeSelect = document.getElementById('bg-type');
        const bgImageSection = document.getElementById('bg-image-section');
        const bgVideoSection = document.getElementById('bg-video-section');
        const currentBgType = settings.bgType || '';
        if (bgTypeSelect) bgTypeSelect.value = currentBgType;

        function showBgSection(type) {
            if (bgImageSection) bgImageSection.style.display = type === 'image' ? 'block' : 'none';
            if (bgVideoSection) bgVideoSection.style.display = type === 'video' ? 'block' : 'none';
        }
        showBgSection(currentBgType);
        if (bgTypeSelect) {
            bgTypeSelect.onchange = () => showBgSection(bgTypeSelect.value);
        }

        // 静态图片：恢复已保存的图片
        if (bgImg) {
            const savedImageUrl = settings.bgImageUrl || null;
            if (savedImageUrl) {
                bgImg.src = savedImageUrl;
                bgImg.setAttribute('data-custom', 'true');
            } else {
                bgImg.src = Constants.DEFAULT_BG_PREVIEW;
                bgImg.removeAttribute('data-custom');
            }
        }

        // 视频背景：恢复已保存的设置
        const chatBgVideoModeRadios = document.querySelectorAll('input[name="chat-bg-video-mode"]');
        const chatBgVideoUrlRow = document.getElementById('chat-bg-video-url-row');
        const chatBgVideoFileRow = document.getElementById('chat-bg-video-file-row');
        const chatBgVideoUrlInput = document.getElementById('chat-bg-video-url');
        const chatBgVideoFileName = document.getElementById('chat-bg-video-file-name');
        const chatBgVideoPreview = document.getElementById('chat-bg-video-preview');
        const chatBgVideoPreviewGroup = document.getElementById('chat-bg-video-preview-group');
        const savedBgVideoMode = settings.bgVideoMode || 'url';

        if (savedBgVideoMode === 'file') {
            if (chatBgVideoUrlRow) chatBgVideoUrlRow.style.display = 'none';
            if (chatBgVideoFileRow) chatBgVideoFileRow.style.display = 'block';
        }
        chatBgVideoModeRadios.forEach(r => {
            if (r.value === savedBgVideoMode) r.checked = true;
            r.addEventListener('change', () => {
                const mode = document.querySelector('input[name="chat-bg-video-mode"]:checked')?.value;
                if (chatBgVideoUrlRow) chatBgVideoUrlRow.style.display = mode === 'url' ? 'block' : 'none';
                if (chatBgVideoFileRow) chatBgVideoFileRow.style.display = mode === 'file' ? 'block' : 'none';
                if (chatBgVideoPreview) chatBgVideoPreview.src = '';
                if (chatBgVideoPreviewGroup) chatBgVideoPreviewGroup.style.display = 'none';
            });
        });
        if (chatBgVideoUrlInput) {
            chatBgVideoUrlInput.value = (savedBgVideoMode === 'url') ? (settings.bgVideoUrl || '') : '';
        }
        if (chatBgVideoFileName) chatBgVideoFileName.textContent = settings.bgVideoName || '';

        // 视频文件预览（挂实例上供 saveSettings 读取）
        this._pendingVideoFile = null;
        const chatBgVideoFileInput = document.getElementById('chat-bg-video-file');
        if (chatBgVideoFileInput) {
            chatBgVideoFileInput.value = '';
            chatBgVideoFileInput.addEventListener('change', () => {
                const file = chatBgVideoFileInput.files[0];
                if (!file) return;
                this._pendingVideoFile = file;
                if (chatBgVideoFileName) chatBgVideoFileName.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`;
                if (chatBgVideoPreview) {
                    const previewUrl = URL.createObjectURL(file);
                    chatBgVideoPreview.src = previewUrl;
                    chatBgVideoPreview.onloadedmetadata = () => URL.revokeObjectURL(previewUrl);
                }
                if (chatBgVideoPreviewGroup) chatBgVideoPreviewGroup.style.display = 'block';
            });
        }
        // URL 预览
        if (chatBgVideoUrlInput) {
            chatBgVideoUrlInput.addEventListener('blur', () => {
                const url = chatBgVideoUrlInput.value.trim();
                if (url && chatBgVideoPreview) {
                    chatBgVideoPreview.src = url;
                    if (chatBgVideoPreviewGroup) chatBgVideoPreviewGroup.style.display = 'block';
                } else if (chatBgVideoPreviewGroup) {
                    chatBgVideoPreviewGroup.style.display = 'none';
                }
            });
            // 如果已保存 URL，显示预览
            if (chatBgVideoUrlInput.value && chatBgVideoPreview) {
                chatBgVideoPreview.src = chatBgVideoUrlInput.value;
                if (chatBgVideoPreviewGroup) chatBgVideoPreviewGroup.style.display = 'block';
            }
        }

        if (ttsSwitch) {
            ttsSwitch.checked = settings.ttsEnabled || false;
            if (ttsVoiceGroup) ttsVoiceGroup.style.display = ttsSwitch.checked ? 'block' : 'none';
            if (ttsSwitch.checked && ttsVoiceSelect) {
                TTsService.populateVoiceSelect(ttsVoiceSelect, currentChat?.settings?.ttsVoice, false);
            }
            ttsSwitch.onchange = async () => {
                if (ttsVoiceGroup) ttsVoiceGroup.style.display = ttsSwitch.checked ? 'block' : 'none';
                if (ttsSwitch.checked && ttsVoiceSelect) {
                    await TTsService.populateVoiceSelect(ttsVoiceSelect, currentChat?.settings?.ttsVoice, false);
                }
            };
        }

        const content = modal.querySelector('.modal-content');
        if (content) content.classList.remove('closing');
        modal.style.display = 'flex';
        ctx.bindAutoResize(rolePersona);
        ctx.bindAutoResize(roleGreeting);
    }

    closeSettingsModal() {
        const modal = document.getElementById('settings-modal');
        this.closeModalWithAnimation(modal);
    }

    async saveSettings() {
        const ctx = this.ctx;
        const modelService = ctx.getModelService();
        if (modelService.isStreaming()) {
            if (confirm('当前对话正在生成回复，保存设置会中断该回复。是否继续？')) {
                modelService.abortCurrentStream();
                ctx.releaseRequestLock();
                ctx.ttsService.stop();
                await new Promise(resolve => setTimeout(resolve, 100));
            } else {
                this.closeSettingsModal();
                return;
            }
        }
        const currentChat = ctx.chats.find(c => c.id == ctx.currentChatId);
        if (!currentChat) return;
        const oldGreeting = currentChat.settings?.greeting || Constants.DEFAULT_SETTINGS.greeting;

        const newRoleName = document.getElementById('role-name').value.trim() || 'Nova';
        const newPersona = document.getElementById('role-persona').value.trim() || '暂无设定';
        const newGreeting = document.getElementById('role-greeting').value.trim() || '✨ 你好，我是你的虚拟AI伙伴。';

        const contextUnlimited = document.getElementById('context-unlimited').checked;
        let contextLimit = parseInt(document.getElementById('context-limit').value);
        if (contextUnlimited) contextLimit = -1;
        const temperature = parseFloat(document.getElementById('temperature').value);
        const topP = parseFloat(document.getElementById('top-p').value);
        const thinkLevel = parseInt(document.getElementById('think-level').value);
        const maxTokens = parseInt(document.getElementById('max-tokens').value);

        currentChat.settings = currentChat.settings || {};
        currentChat.settings.contextLimit = contextLimit;
        currentChat.settings.temperature = temperature;
        currentChat.settings.topP = topP;
        currentChat.settings.thinkLevel = thinkLevel;
        currentChat.settings.maxTokens = maxTokens;
        currentChat.settings.roleName = newRoleName;
        currentChat.settings.persona = newPersona;
        currentChat.settings.greeting = newGreeting;

        const avatarImg = document.getElementById('avatar-img');
        const newAvatarUrl = avatarImg && avatarImg.hasAttribute('data-custom') ? avatarImg.src : null;
        currentChat.settings.avatarUrl = newAvatarUrl;

        // ---- 背景类型 ----
        const bgType = document.getElementById('bg-type')?.value || '';
        currentChat.settings.bgType = bgType || null;  // null = 默认背景

        if (bgType === 'image') {
            const bgImg = document.getElementById('bg-img');
            currentChat.settings.bgImageUrl = (bgImg && bgImg.hasAttribute('data-custom')) ? bgImg.src : null;
        } else if (bgType === 'video') {
            const videoMode = document.querySelector('input[name="chat-bg-video-mode"]:checked')?.value || 'url';
            currentChat.settings.bgVideoMode = videoMode;
            if (videoMode === 'url') {
                currentChat.settings.bgVideoUrl = document.getElementById('chat-bg-video-url')?.value?.trim() || '';
                currentChat.settings.bgVideoName = '';
                // 切换到 URL 模式可清除旧的 IndexedDB 文件
                AssetStore.deleteVideo(currentChat.id).catch(() => {});
            } else {
                // 文件模式：有新文件则存入 IndexedDB
                if (this._pendingVideoFile) {
                    await AssetStore.saveVideo(currentChat.id, this._pendingVideoFile);
                    currentChat.settings.bgVideoName = this._pendingVideoFile.name;
                    currentChat.settings.bgVideoUrl = '';  // 加载时从 IndexedDB 恢复
                    this._pendingVideoFile = null;
                }
                // 无新文件 → 保持已有设置不变
            }
        } else {
            // 默认背景：保留 image/video 数据不清空，方便切回来恢复
            currentChat.settings.bgVideoMode = 'url';
            currentChat.settings.bgVideoName = '';
        }

        const ttsEnabled = document.getElementById('tts-switch').checked;
        const ttsVoice = document.getElementById('tts-voice-select').value;
        currentChat.settings.ttsEnabled = ttsEnabled;
        currentChat.settings.ttsVoice = ttsVoice;

        ctx.applyCurrentChatSettings();
        ctx.renderMessages(ctx.currentChatId, ctx.currentTopicIndex);
        ctx.renderHistoryList();
        await ctx.chatRepo.saveChat(currentChat);
        if (oldGreeting !== newGreeting) {
            ctx.startNewTopic();
        }
        this.closeSettingsModal();
    }

    // ==================== 全局设置弹窗 ====================
    async openGlobalSettings() {
        const ctx = this.ctx;
        const modelHostInput = document.getElementById('model-host');
        const apiKeyInput = document.getElementById('api-key');
        if (modelHostInput) modelHostInput.value = SettingsManager.getModelHost();
        if (apiKeyInput) apiKeyInput.value = SettingsManager.getApiKey();
        // 确保模型列表 UI 反映当前厂商的模型列表
        if (ctx.renderModelListUI) ctx.renderModelListUI();
        const providerSelect = document.getElementById('model-provider');
        if (providerSelect) {
            const providers = Constants.MODEL_PROVIDERS;
            providerSelect.innerHTML = '';
            for (const [key, val] of Object.entries(providers)) {
                const option = document.createElement('option');
                option.value = key;
                option.textContent = val.label;
                if (key === SettingsManager.getModelProvider()) option.selected = true;
                providerSelect.appendChild(option);
            }

            // 移除旧监听，避免重复绑定
            providerSelect.removeEventListener('change', providerSelect._changeHandler);
            providerSelect._changeHandler = function() {
                const newProvider = this.value;
                const oldProvider = SettingsManager.getModelProvider();
                const provider = Constants.MODEL_PROVIDERS[newProvider];
                if (!provider) return;

                // 1. 保存当前厂商的 apiKey / modelHost / 模型列表
                const currentModels = ModelService.getModels();
                const currentModelName = document.getElementById('global-model-name')?.value || SettingsManager.getModelName();
                SettingsManager.saveProviderState(oldProvider, {
                    apiKey: document.getElementById('api-key')?.value || '',
                    modelHost: document.getElementById('model-host')?.value || '',
                    models: currentModels,
                    currentModel: currentModelName,
                });

                // 2. 切换厂商（暂存，尚未点「保存设置」）
                SettingsManager.update({ modelProvider: newProvider });

                // 3. 恢复新厂商之前保存的设置（否则使用默认值）
                const savedState = SettingsManager.loadProviderState(newProvider);
                const hostInput = document.getElementById('model-host');
                const apiKeyInput = document.getElementById('api-key');
                const modelNameInput = document.getElementById('global-model-name');

                if (savedState) {
                    if (hostInput) hostInput.value = savedState.modelHost || provider.defaultHost;
                    if (apiKeyInput) apiKeyInput.value = savedState.apiKey || '';
                    if (savedState.models && savedState.models.length > 0) {
                        ModelService.setModels(savedState.models);
                        if (modelNameInput) modelNameInput.value = savedState.currentModel || savedState.models[0];
                    } else {
                        ModelService.setModels([provider.defaultModel]);
                        if (modelNameInput) modelNameInput.value = provider.defaultModel;
                    }
                } else {
                    // 首次使用该厂商 — 使用 Constants 中的默认值
                    if (hostInput) hostInput.value = provider.defaultHost;
                    // 不清空 apiKey，用户可能已经填了
                    ModelService.setModels([provider.defaultModel]);
                    if (modelNameInput) modelNameInput.value = provider.defaultModel;
                }

                // 4. 刷新 UI
                if (ctx.renderModelListUI) ctx.renderModelListUI();
                if (ctx.updateModelSelector) ctx.updateModelSelector();
                if (ctx.saveModelListToStorage) ctx.saveModelListToStorage();
            };
            providerSelect.addEventListener('change', providerSelect._changeHandler);
        }

        const usernameInput = document.getElementById('global-username');
        const bioInput = document.getElementById('global-bio');
        if (usernameInput) usernameInput.value = SettingsManager.getUsername();
        if (bioInput) bioInput.value = SettingsManager.getBio();
        const globalAvatarImg = document.getElementById('global-avatar-img');
        if (globalAvatarImg && SettingsManager.getAvatar()) globalAvatarImg.src = SettingsManager.getAvatar();

        const ctxSlider = document.getElementById('global-context-limit');
        const ctxUnlimitedCheck = document.getElementById('global-context-unlimited');
        const tempSlider = document.getElementById('global-temperature');
        const topPSlider = document.getElementById('global-top-p');
        const thinkLevelSlider = document.getElementById('global-think-level');
        const maxTokensSlider = document.getElementById('global-max-tokens');

        const imgApiUrlInput = document.getElementById('img-api-url');
        if (imgApiUrlInput) imgApiUrlInput.value = SettingsManager.getImgApiUrl();
        const imgApiKeyInput = document.getElementById('img-api-key');
        if (imgApiKeyInput) imgApiKeyInput.value = SettingsManager.getImgApiKey();

        // 音色克隆按钮
        let isCloning = false;
        const cloneBtn = document.getElementById('start-clone-btn');
        if (cloneBtn) {
            const newCloneBtn = cloneBtn.cloneNode(true);
            cloneBtn.parentNode.replaceChild(newCloneBtn, cloneBtn);
            newCloneBtn.addEventListener('click', async () => {
                if (isCloning) {
                    this.customAlert('正在克隆中，请稍候...');
                    return;
                }
                const voiceName = document.getElementById('clone-voice-name').value.trim();
                if (!voiceName) { this.customAlert('请输入音色名称'); return; }
                const audioFile = document.getElementById('clone-audio-file').files[0];
                if (!audioFile) { this.customAlert('请选择参考音频文件'); return; }
                const audioText = document.getElementById('clone-audio-text').value.trim();
                if (!audioText) { this.customAlert('请填写音频对应的文本内容'); return; }

                isCloning = true;
                const formData = new FormData();
                formData.append('voice_name', voiceName);
                formData.append('audio', audioFile);
                formData.append('ref_text', audioText);

                const ttsApiUrl = SettingsManager.getTtsApiUrl();
                const cloneStatus = document.getElementById('clone-status');
                cloneStatus.innerText = '正在克隆音色，请稍候...';
                newCloneBtn.disabled = true;

                try {
                    const response = await fetch(`${ttsApiUrl}/clone_voice`, { method: 'POST', body: formData });
                    const result = await response.json();
                    if (response.ok) {
                        cloneStatus.innerText = '✅ 音色克隆成功！已保存到音色库。';
                        TTsService.clearVoiceCache();
                        const voiceDisplaySpan = document.getElementById('voice-list-display');
                        if (voiceDisplaySpan) await TTsService.updateVoiceDisplay(voiceDisplaySpan, true);
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

        const ttsApiUrlInput = document.getElementById('tts-api-url');
        if (ttsApiUrlInput) ttsApiUrlInput.value = SettingsManager.getTtsApiUrl();
        const ttsApiKeyInput = document.getElementById('tts-api-key');
        if (ttsApiKeyInput) ttsApiKeyInput.value = SettingsManager.getTtsApiKey();

        const ctxLimit = SettingsManager.getContextLimit();
        const temp = SettingsManager.getTemperature();
        const topP = SettingsManager.getTopP();
        const thinkLevel = SettingsManager.getThinkLevel();
        const maxTokens = SettingsManager.getMaxTokens();

        if (ctxSlider) {
            if (SettingsManager.isContextUnlimited()) {
                ctxUnlimitedCheck.checked = true;
                ctxSlider.disabled = true;
                document.getElementById('global-context-limit-value').innerText = '无限制';
            } else {
                ctxUnlimitedCheck.checked = false;
                ctxSlider.disabled = false;
                ctxSlider.value = ctxLimit;
                document.getElementById('global-context-limit-value').innerText = ctxSlider.value;
            }
            ctxUnlimitedCheck.onchange = () => {
                if (ctxUnlimitedCheck.checked) {
                    ctxSlider.disabled = true;
                    document.getElementById('global-context-limit-value').innerText = '无限制';
                } else {
                    ctxSlider.disabled = false;
                    ctxSlider.value = ctxLimit;
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
        if (thinkLevelSlider) {
            thinkLevelSlider.value = thinkLevel;
            document.getElementById('global-think-level-value').innerText = Constants.THINK_LEVELS[thinkLevel];
            thinkLevelSlider.oninput = () => {
                const idx = parseInt(thinkLevelSlider.value);
                document.getElementById('global-think-level-value').innerText = Constants.THINK_LEVELS[idx];
            };
        }
        if (maxTokensSlider) {
            maxTokensSlider.value = maxTokens;
            document.getElementById('global-max-tokens-value').innerText = maxTokens;
            maxTokensSlider.oninput = () => document.getElementById('global-max-tokens-value').innerText = maxTokensSlider.value;
        }

        const themeSelect = document.getElementById('global-theme');
        const fontSizeSelect = document.getElementById('global-font-size');
        if (themeSelect) themeSelect.value = SettingsManager.getTheme();
        if (fontSizeSelect) fontSizeSelect.value = SettingsManager.getFontSize();

        const typingSpeedSlider = document.getElementById('global-typing-speed');
        const typingSpeedSpan = document.getElementById('global-typing-speed-value');
        if (typingSpeedSlider) {
            const speed = SettingsManager.getTypingSpeed();
            typingSpeedSlider.value = speed;
            const updateLabel = (val) => {
                if (val === 1.0) typingSpeedSpan.textContent = '原速';
                else typingSpeedSpan.textContent = val.toFixed(1) + 'x';
            };
            updateLabel(speed);
            typingSpeedSlider.oninput = () => updateLabel(parseFloat(typingSpeedSlider.value));
        }

        const modal = document.getElementById('global-settings-modal');
        if (modal) modal.style.display = 'flex';
        ctx.renderShortcutsPanel();

        const autoScrollCheck = document.getElementById('global-auto-scroll');
        if (autoScrollCheck) {
            autoScrollCheck.checked = SettingsManager.getAutoScrollAfterSend();
        }

        await this.kbManager.renderKnowledgeBase();

        // 渲染 Token 用量统计
        this.#renderTokenUsageTab();
        // 绑定重置按钮
        const resetTokenBtn = document.getElementById('reset-token-usage');
        if (resetTokenBtn) {
            const newBtn = resetTokenBtn.cloneNode(true);
            resetTokenBtn.parentNode.replaceChild(newBtn, resetTokenBtn);
            newBtn.addEventListener('click', async () => {
                const confirmed = await this.showCustomDialog({
                    title: '确认重置',
                    message: '确定要清空所有累计 Token 用量统计吗？此操作不可撤销。',
                    buttons: [
                        { text: '取消', value: false, className: 'cancel' },
                        { text: '确认重置', value: true, className: 'save' }
                    ]
                });
                if (confirmed) {
                    TokenTracker.reset();
                    this.#renderTokenUsageTab();
                    this.showBriefToast('Token 用量统计已重置');
                }
            });
        }
    }

    /** 渲染 Token 用量统计标签页 */
    #renderTokenUsageTab() {
        const stats = TokenTracker.getStats();
        const sessionTokens = TokenTracker.getSessionTokens();

        const setStat = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value.toLocaleString();
        };
        setStat('token-prompt', stats.promptTokens);
        setStat('token-completion', stats.completionTokens);
        setStat('token-total', stats.totalTokens);
        setStat('token-api-calls', stats.apiCalls);
        setStat('token-session', sessionTokens);
    }

    closeGlobalModal() {
        const modal = document.getElementById('global-settings-modal');
        this.closeModalWithAnimation(modal);
    }

    async saveGlobalSettings() {
        const ctx = this.ctx;
        const avatarImg = document.getElementById('global-avatar-img');
        let avatarSrc = avatarImg.src;
        const fontSize = document.getElementById('global-font-size').value;

        if (avatarSrc && avatarSrc.startsWith('data:image') && avatarSrc.length > 300000) {
            if (!confirm('头像图片过大，可能导致存储失败。是否继续保存？点击"确定"将尝试自动压缩。')) return;
            const tempImg = new Image();
            tempImg.onload = () => {
                const canvas = document.createElement('canvas');
                const maxWidth = 150;
                let width = tempImg.width, height = tempImg.height;
                if (width > maxWidth) { height = (height * maxWidth) / width; width = maxWidth; }
                canvas.width = width; canvas.height = height;
                const cctx = canvas.getContext('2d');
                cctx.drawImage(tempImg, 0, 0, width, height);
                avatarImg.src = canvas.toDataURL('image/jpeg', 0.6);
                setTimeout(() => this.saveGlobalSettings(), 10);
            };
            tempImg.src = avatarSrc;
            return;
        }

        const ctxUnlimited = document.getElementById('global-context-unlimited').checked;
        let contextLimit = parseInt(document.getElementById('global-context-limit').value);
        if (ctxUnlimited) contextLimit = -1;
        const quickSelect = document.getElementById('quick-model-select');
        let currentModel = quickSelect?.value || SettingsManager.getModelName() || Constants.DEFAULT_MODEL_NAME;
        if (!currentModel) {
            const models = ModelService.getModels();
            currentModel = models[0] || Constants.DEFAULT_MODEL_NAME;
        }

        const globalSettings = {
            modelHost: document.getElementById('model-host').value,
            apiKey: document.getElementById('api-key').value,
            username: document.getElementById('global-username').value,
            bio: document.getElementById('global-bio').value,
            avatar: avatarImg.src,
            contextLimit: contextLimit,
            contextUnlimited: ctxUnlimited,
            temperature: parseFloat(document.getElementById('global-temperature').value),
            topP: parseFloat(document.getElementById('global-top-p').value),
            thinkLevel: parseInt(document.getElementById('global-think-level').value),
            maxTokens: parseInt(document.getElementById('global-max-tokens').value),
            theme: document.getElementById('global-theme').value,
            fontSize: fontSize,
            modelName: currentModel,
            ttsApiUrl: document.getElementById('tts-api-url').value,
            shortcuts: ctx.getShortcuts(),
            imgApiUrl: document.getElementById('img-api-url').value,
            ttsApiKey: document.getElementById('tts-api-key').value,
            imgApiKey: document.getElementById('img-api-key').value,
            typingSpeed: parseFloat(document.getElementById('global-typing-speed').value),
            autoScrollAfterSend: document.getElementById('global-auto-scroll').checked,
            modelProvider: document.getElementById('model-provider').value,
        };

        if (ctx.modelServiceInstanceRef.value) {
            ctx.modelServiceInstanceRef.value.updateConfig({
                modelHost: globalSettings.modelHost,
                apiKey: globalSettings.apiKey,
                modelName: currentModel,
            });
        }

        const result = SettingsManager.writeWithResult(globalSettings);
        if (!result.success) {
            if (result.errorName === 'QuotaExceededError') {
                this.customAlert('存储空间不足！请尝试：\n1. 删除一些旧对话\n2. 使用更小的头像图片\n3. 清理浏览器缓存', 'error');
            } else {
                this.customAlert('保存失败：' + result.error, 'error');
            }
            return;
        }

        // 同步保存当前厂商状态（API Key、模型列表等），便于切换厂商后恢复
        SettingsManager.saveProviderState(globalSettings.modelProvider, {
            apiKey: globalSettings.apiKey,
            modelHost: globalSettings.modelHost,
            models: ModelService.getModels(),
            currentModel: currentModel,
        });

        ctx.applyTheme(globalSettings.theme);
        ctx.applyFontSize(fontSize);
        if (ctx.currentChatId) ctx.renderMessages(ctx.currentChatId, ctx.currentTopicIndex);
        this.closeGlobalModal();
    }

    // ==================== 话题管理弹窗 ====================

    async openTopicsModal() {
        const ctx = this.ctx;
        const currentChat = ctx.chats.find(c => c.id == ctx.currentChatId);
        if (!currentChat) return;
        const topics = currentChat.topics || [];
        const container = document.getElementById('topics-list-container');
        if (!container) return;

        const self = this; // for event handlers

        if (topics.length === 0) {
            container.innerHTML = '<div style="padding: 20px; text-align: center;">暂无话题</div>';
        } else {
            container.innerHTML = topics.map((topic, idx) => {
                const firstMsg = topic.messages[0];
                const preview = firstMsg ? (firstMsg.text.length > 50 ? firstMsg.text.substring(0, 50) + '...' : firstMsg.text) : '无消息';
                const time = firstMsg ? firstMsg.time : '未知';
                return `
                    <div class="topic-item${ctx.currentTopicIndex === idx ? ' active' : ''}" data-topic-index="${idx}">
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

            // 可编辑预览区双击
            container.querySelectorAll('.editable-preview').forEach(elem => {
                elem.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    const topicIdx = parseInt(elem.getAttribute('data-topic-index'));
                    const oldText = elem.innerText;
                    const input = document.createElement('input');
                    input.type = 'text'; input.value = oldText;
                    input.style.cssText = 'width:100%;background:rgba(30,34,55,0.9);border:1px solid #5f7eff;border-radius:8px;padding:4px 8px;color:#f0f3ff;';
                    elem.innerHTML = '';
                    elem.appendChild(input);
                    input.focus();
                    const saveEdit = () => {
                        const newText = input.value.trim();
                        if (newText && newText !== oldText) {
                            currentChat.topics[topicIdx].summary = newText;
                            ctx.chatRepo.saveAllChats(ctx.chats);
                            elem.innerText = newText;
                            elem.setAttribute('data-original', newText);
                        } else {
                            elem.innerText = oldText;
                        }
                    };
                    input.addEventListener('blur', saveEdit);
                    input.addEventListener('keypress', (ev) => { if (ev.key === 'Enter') input.blur(); });
                });
            });

            container.querySelectorAll('.topic-preview').forEach(preview => {
                preview.addEventListener('click', (e) => e.stopPropagation());
            });

            // 生成简介
            container.querySelectorAll('.topic-gen-intro-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const idx = parseInt(btn.getAttribute('data-topic-index'));
                    const topic = topics[idx];
                    if (!topic) return;
                    const topicItem = btn.closest('.topic-item');
                    const summaryElem = topicItem ? topicItem.querySelector('.topic-preview') : null;
                    if (summaryElem) summaryElem.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 生成中...';
                    const summary = await ctx.generateTopicSummary(idx, topic.messages);
                    if (summary && summaryElem) {
                        currentChat.topics[idx].summary = summary;
                        await ctx.chatRepo.saveAllChats(ctx.chats);
                        summaryElem.innerHTML = escapeHtml(summary);
                        summaryElem.setAttribute('data-original', summary);
                    } else if (summaryElem) {
                        summaryElem.innerHTML = '生成失败';
                    }
                });
            });

            // 切换话题
            container.querySelectorAll('.topic-item').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    if (e.target.closest('.topic-actions')) return;
                    const idx = parseInt(btn.getAttribute('data-topic-index'));
                    self.closeTopicsModal();
                    ctx.setCurrentTopic(idx);
                });
            });

            // 导出
            container.querySelectorAll('.topic-export-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const idx = parseInt(btn.getAttribute('data-topic-index'));
                    ctx.chatIO.exportTopic(idx, currentChat);
                });
            });

            // 删除话题
            container.querySelectorAll('.topic-delete-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const idx = parseInt(btn.getAttribute('data-topic-index'));
                    const topicItem = btn.closest('.topic-item');
                    if (!topicItem || topicItem.classList.contains('removing')) return;

                    const modelService = ctx.getModelService();
                    if (modelService.isStreaming()) {
                        if (!confirm('当前正在生成回复，删除话题会中断本次回复。是否继续？')) return;
                        modelService.abortCurrentStream();
                        ctx.releaseRequestLock();
                        ctx.ttsService.stop();
                    }
                    if (!confirm(`确定要删除话题 ${idx + 1} 吗？此操作不可撤销。`)) return;

                    topicItem.classList.add('removing');
                    await new Promise(resolve => {
                        const onEnd = (ev) => {
                            if (ev.propertyName === 'transform') { topicItem.removeEventListener('transitionend', onEnd); resolve(); }
                        };
                        topicItem.addEventListener('transitionend', onEnd);
                        setTimeout(resolve, 500);
                    });

                    const topic = topics[idx];
                    if (!topic) return;
                    // 直接从 topics 数组中删除
                    currentChat.topics.splice(idx, 1);
                    // 调整 currentTopicIndex
                    if (currentChat.currentTopicIndex === idx) {
                        currentChat.currentTopicIndex = null;
                    } else if (currentChat.currentTopicIndex > idx) {
                        currentChat.currentTopicIndex--;
                    }
                    currentChat.date = new Date();

                    ctx.renderMessages(ctx.currentChatId, ctx.currentTopicIndex);
                    ctx.renderHistoryList();
                    await ctx.chatRepo.saveAllChats(ctx.chats);

                    if (currentChat.topics.length === 0) {
                        ctx.startNewTopic();
                    }
                    self.openTopicsModal(); // 刷新列表
                });
            });
        }

        const modal = document.getElementById('topics-modal');
        if (modal) modal.style.display = 'flex';
    }

    closeTopicsModal() {
        const modal = document.getElementById('topics-modal');
        this.closeModalWithAnimation(modal);
    }

    // ==================== 知识库选择器 ====================

    /** 打开知识库选择弹窗*/
    async openKnowledgeBaseSelector() {
        const modal = document.getElementById('kb-select-modal');
        const body = document.getElementById('kb-select-body');
        if (!modal || !body) return;

        // 显示加载状态
        body.innerHTML = `<div style="text-align:center;padding:40px;color:#8e8eb3;">
            <i class="fas fa-spinner fa-spin"></i> 加载知识库列表...
        </div>`;
        modal.style.display = 'flex';

        try {
            // 获取知识库列表
            const apiBase = this.kbManager.apiBase;
            const response = await fetch(`${apiBase}/knowledge_bases`);
            if (!response.ok) throw new Error('获取知识库列表失败');
            const data = await response.json();
            const kbList = data.knowledge_bases || [];

            // 获取当前选中的知识库ID列表
            const selectedIdsStr = localStorage.getItem('selected_kb_ids') || '';
            const selectedIds = selectedIdsStr ? selectedIdsStr.split(',') : [];

            // 渲染列表
            this.#renderKbSelectorList(body, kbList, selectedIds);
        } catch (err) {
            body.innerHTML = `<div style="text-align:center;padding:40px;color:#ff7a5c;">
                <i class="fas fa-exclamation-circle" style="font-size:2rem;display:block;margin-bottom:12px;"></i>
                加载失败：${err.message}
                <div style="margin-top:12px;font-size:0.8rem;color:#8e8eb3;">请检查知识库服务是否正常运行</div>
            </div>`;
        }
    }

    /**
     * 渲染知识库选择列表
     * @param {HTMLElement} container - 容器元素
     * @param {Array} kbList - 知识库列表
     * @param {string|null} selectedId - 当前选中的知识库ID
     */
    #renderKbSelectorList(container, kbList, selectedIds = []) {
        if (!kbList || kbList.length === 0) {
            container.innerHTML = `
                <div class="kb-select-empty">
                    <i class="fas fa-database"></i>
                    <div>暂无知识库</div>
                    <div style="font-size:0.85rem;margin-top:4px;">请前往「个性化设置 → 知识库」创建</div>
                    <span class="action-link" id="kb-select-goto-settings">前往创建 →</span>
                </div>
            `;
            const goBtn = document.getElementById('kb-select-goto-settings');
            if (goBtn) {
                goBtn.addEventListener('click', () => {
                    this.closeKnowledgeBaseSelector();
                    this.openGlobalSettings();
                    setTimeout(() => {
                        document.querySelectorAll('.settings-menu-item').forEach(item => {
                            if (item.getAttribute('data-tab') === 'knowledge') item.click();
                        });
                    }, 300);
                });
            }
            return;
        }

        let html = `<div class="kb-select-grid">`;
        for (const kb of kbList) {
            const isSelected = selectedIds.includes(kb.id);
            const desc = kb.description || '暂无描述';
            html += `
                <div class="kb-select-card ${isSelected ? 'selected' : ''}" data-kb-id="${kb.id}">
                    <div class="kb-select-check"><i class="fas fa-check"></i></div>
                    <span class="kb-select-icon"><i class="fas fa-database"></i></span>
                    <div class="kb-select-name">${escapeHtml(kb.name)}</div>
                    <div class="kb-select-desc">${escapeHtml(desc)}</div>
                </div>
            `;
        }
        html += `</div>`;
        container.innerHTML = html;

        // 添加清空选择按钮
        const clearBtnHtml = `<div style="text-align:center; margin-top:16px;">
            <button class="action-btn" id="kb-clear-selection" style="background:rgba(255,80,80,0.15); border-color:rgba(255,80,80,0.3); color:#ff8a7a; padding:6px 20px;">
                <i class="fas fa-times-circle"></i> 清空所有选择
            </button>
        </div>`;
        container.innerHTML += clearBtnHtml;

        // 绑定清空按钮事件
        const clearBtn = document.getElementById('kb-clear-selection');
        if (clearBtn) {
            clearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // 取消所有卡片选中
                container.querySelectorAll('.kb-select-card').forEach(c => c.classList.remove('selected'));
                // 更新提示
                const hint = document.getElementById('kb-select-hint');
                if (hint) hint.innerHTML = `💡 已清空选择，请点击卡片选择（可多选）`;
            });
        }
        // 绑定卡片点击事件（多选切换）
        const cards = container.querySelectorAll('.kb-select-card');
        cards.forEach(card => {
            card.addEventListener('click', () => {
                card.classList.toggle('selected');
                // 更新提示
                const selected = container.querySelectorAll('.kb-select-card.selected');
                const hint = document.getElementById('kb-select-hint');
                if (hint) {
                    const count = selected.length;
                    if (count === 0) {
                        hint.innerHTML = `不使用知识库`;
                    } else {
                        const names = Array.from(selected).map(c => c.querySelector('.kb-select-name')?.textContent || '').join('、');
                        hint.innerHTML = `✅ 已选 <strong>${count}</strong> 个：${escapeHtml(names)}`;
                    }
                }
            });
        });

        // 更新初始提示
        const hint = document.getElementById('kb-select-hint');
        if (hint) {
            const selected = container.querySelectorAll('.kb-select-card.selected');
            if (selected.length > 0) {
                const names = Array.from(selected).map(c => c.querySelector('.kb-select-name')?.textContent || '').join('、');
                hint.innerHTML = `✅ 已选 <strong>${selected.length}</strong> 个：${escapeHtml(names)}`;
            } else {
                hint.innerHTML = `💡 点击卡片选择知识库（可多选），确认后生效`;
            }
        }
    }

    /** 关闭知识库选择弹窗 */
    closeKnowledgeBaseSelector() {
        const modal = document.getElementById('kb-select-modal');
        this.closeModalWithAnimation(modal);
    }

    /** 确认选择知识库（多选）*/
    confirmKnowledgeBaseSelection() {
        const selectedCards = document.querySelectorAll('#kb-select-body .kb-select-card.selected');
        const ids = [];
        const names = [];
        selectedCards.forEach(card => {
            ids.push(card.dataset.kbId);
            const nameEl = card.querySelector('.kb-select-name');
            if (nameEl) names.push(nameEl.textContent);
        });

        // 保存到 localStorage（用逗号分隔ID，为空则保存空字符串）
        localStorage.setItem('selected_kb_ids', ids.join(','));
        localStorage.setItem('selected_kb_names', names.join(','));

        // 更新按钮显示
        this.#updateKbButtonLabel(names);

        this.closeKnowledgeBaseSelector();
    }

    /** 更新知识库按钮标签 */
    #updateKbButtonLabel(names) {
        const label = document.getElementById('kb-btn-label');
        if (!label) return;
        if (names && names.length > 0) {
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

export default ModalManager;
