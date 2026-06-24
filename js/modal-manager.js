// 弹窗管理模块，负责所有模态框的打开/关闭/保存逻辑。
// 依赖通过构造函数注入，避免循环引用。
import Constants from './constants.js';
import { SettingsManager } from './settings-manager.js';
import { TTsService } from './tts-service.js';
import { ModelService } from './model-service.js';
import { escapeHtml } from './utils.js';

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
     * @param {Object} ctx.currentShortcutsRef — { value: Object } 快捷键映射的包装引用
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
        setTimeout(() => toast.remove(), 2000);
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
            closable = true
        } = options;

        const modal = document.getElementById('custom-dialog');
        const titleEl = document.getElementById('custom-dialog-title');
        const messageEl = document.getElementById('custom-dialog-message');
        const footerEl = document.getElementById('custom-dialog-footer');
        const closeBtn = document.getElementById('custom-dialog-close');

        return new Promise((resolve) => {
            footerEl.innerHTML = '';
            titleEl.innerHTML = title;
            messageEl.innerHTML = message.replace(/\n/g, '<br>');

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
                modal.removeEventListener('click', onOverlayClick);
                document.removeEventListener('keydown', onEsc);
            };

            const onClose = () => {
                if (closable) {
                    resolve(buttons.length > 0 ? buttons[0].value : null);
                    closeModal();
                }
            };

            const onOverlayClick = (e) => {
                if (e.target === modal && closable) onClose();
            };

            const onEsc = (e) => {
                if (e.key === 'Escape' && closable) onClose();
            };

            closeBtn.addEventListener('click', onClose);
            modal.addEventListener('click', onOverlayClick);
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
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
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

        let objectUrl = null;

        const closeCropModal = () => {
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
        modal.onclick = (e) => {
            if (e.target === modal) closeCropModal();
        };
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

        roleNameInput.value = settings.roleName;
        rolePersona.value = settings.persona;
        roleGreeting.value = settings.greeting;
        if (settings.avatarUrl) avatarImg.src = settings.avatarUrl;
        else avatarImg.src = Constants.DEFAULT_AI_AVATAR;
        if (settings.bgUrl) bgImg.src = settings.bgUrl;
        else bgImg.src = Constants.DEFAULT_BG_PREVIEW;

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

        currentChat.settings = currentChat.settings || {};
        currentChat.settings.contextLimit = contextLimit;
        currentChat.settings.temperature = temperature;
        currentChat.settings.topP = topP;
        currentChat.settings.roleName = newRoleName;
        currentChat.settings.persona = newPersona;
        currentChat.settings.greeting = newGreeting;

        const avatarImg = document.getElementById('avatar-img');
        const bgImg = document.getElementById('bg-img');
        const newAvatarUrl = Constants.isDefaultImage(avatarImg.src) ? null : avatarImg.src;
        const newBgUrl = Constants.isDefaultImage(bgImg.src) ? null : bgImg.src;
        currentChat.settings.avatarUrl = newAvatarUrl;
        currentChat.settings.bgUrl = newBgUrl;

        const ttsEnabled = document.getElementById('tts-switch').checked;
        const ttsVoice = document.getElementById('tts-voice-select').value;
        currentChat.settings.ttsEnabled = ttsEnabled;
        currentChat.settings.ttsVoice = ttsVoice;

        ctx.applyCurrentChatSettings();
        ctx.renderMessages(ctx.currentChatId);
        ctx.renderHistoryList();
        await ctx.chatRepo.saveChat(currentChat);
        if (oldGreeting !== newGreeting) {
            ctx.startNewTopic();
        }
        this.closeSettingsModal();
    }

    // ==================== 全局设置弹窗 ====================

    openGlobalSettings() {
        const ctx = this.ctx;
        const modelHostInput = document.getElementById('model-host');
        const apiKeyInput = document.getElementById('api-key');
        if (modelHostInput) modelHostInput.value = SettingsManager.getModelHost();
        if (apiKeyInput) apiKeyInput.value = SettingsManager.getApiKey();

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
            theme: document.getElementById('global-theme').value,
            fontSize: fontSize,
            modelName: currentModel,
            ttsApiUrl: document.getElementById('tts-api-url').value,
            shortcuts: ctx.currentShortcutsRef.value,
            imgApiUrl: document.getElementById('img-api-url').value,
            ttsApiKey: document.getElementById('tts-api-key').value,
            imgApiKey: document.getElementById('img-api-key').value,
            typingSpeed: parseFloat(document.getElementById('global-typing-speed').value),
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

        ctx.applyTheme(globalSettings.theme);
        ctx.applyFontSize(fontSize);
        if (ctx.currentChatId) ctx.renderMessages(ctx.currentChatId);
        this.closeGlobalModal();
    }

    // ==================== 话题管理弹窗 ====================

    async openTopicsModal() {
        const ctx = this.ctx;
        const currentChat = ctx.chats.find(c => c.id == ctx.currentChatId);
        if (!currentChat) return;
        const topics = ctx.getTopicsFromMessages(currentChat.messages, currentChat.settings?.topicSummaries);
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
                            if (!currentChat.settings.topicSummaries) currentChat.settings.topicSummaries = {};
                            currentChat.settings.topicSummaries[topicIdx] = newText;
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
                        if (!currentChat.settings.topicSummaries) currentChat.settings.topicSummaries = {};
                        currentChat.settings.topicSummaries[idx] = summary;
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
                    ctx.chatIO.exportTopic(idx, topics, currentChat);
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
                    let start = topic.startIndex, end = topic.endIndex;
                    if (start > 0 && currentChat.messages[start - 1].type === 'divider') start = start - 1;
                    currentChat.messages.splice(start, end - start + 1);
                    currentChat.date = new Date();

                    ctx.renderMessages(ctx.currentChatId);
                    ctx.renderHistoryList();
                    await ctx.chatRepo.saveAllChats(ctx.chats);

                    if (!currentChat.messages.some(msg => msg.type !== 'divider')) {
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
}

export default ModalManager;
