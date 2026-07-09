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
        this.kbListCache = null;          // 缓存知识库文档列表
        this.kbCustomName = localStorage.getItem('kb_name_default') || '默认知识库';
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

        const autoScrollCheck = document.getElementById('global-auto-scroll');
        if (autoScrollCheck) {
            autoScrollCheck.checked = SettingsManager.getAutoScrollAfterSend();
        }
        await this.renderKnowledgeBase();
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
            shortcuts: ctx.getShortcuts(),
            imgApiUrl: document.getElementById('img-api-url').value,
            ttsApiKey: document.getElementById('tts-api-key').value,
            imgApiKey: document.getElementById('img-api-key').value,
            typingSpeed: parseFloat(document.getElementById('global-typing-speed').value),
            autoScrollAfterSend: document.getElementById('global-auto-scroll').checked,
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

    async renderKnowledgeBase() {
        const container = document.getElementById('knowledge-base-container');
        if (!container) return;
        container.innerHTML = '<div style="text-align:center;padding:40px;"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';

        try {
            // 从后端获取知识库列表（使用缓存）
            let kbList = [];
            if (this.kbListCache !== null) {
                kbList = this.kbListCache;
            } else {
                const response = await fetch('http://localhost:5051/knowledge_bases');
                if (!response.ok) throw new Error('网络错误');
                const data = await response.json();
                kbList = data.knowledge_bases || [];
                this.kbListCache = kbList;
            }

            let html = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                    <h4 style="margin:0; color:#ccd6ff;"><i class="fas fa-database" style="margin-right:8px;"></i>知识库</h4>
                    <button class="action-btn" id="new-kb-btn"><i class="fas fa-plus"></i> 新建知识库</button>
                </div>
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap:16px;">
            `;
            if (kbList.length === 0) {
                html += `<div style="grid-column:1/-1; text-align:center; padding:40px; color:#8e8eb3;">暂无知识库，点击“新建知识库”创建</div>`;
            } else {
                for (const kb of kbList) {
                    html += `
                        <div class="knowledge-card" data-kb-id="${kb.id}" style="background:rgba(30,34,55,0.6); border-radius:16px; padding:20px; border:1px solid rgba(100,130,255,0.3); cursor:pointer; transition:0.2s; position:relative;">
                            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                                <i class="fas fa-database" style="font-size:1.5rem; color:#5f7eff;"></i>
                                <div>
                                    <button class="edit-kb-btn" data-kb-id="${kb.id}" style="background:transparent; border:none; color:#b7c4ff; cursor:pointer; margin-right:8px;"><i class="fas fa-pencil-alt"></i></button>
                                    <button class="delete-kb-btn" data-kb-id="${kb.id}" style="background:transparent; border:none; color:#ff8a7a; cursor:pointer;"><i class="fas fa-trash-alt"></i></button>
                                </div>
                            </div>
                            <div class="kb-card-name" style="font-size:1.1rem; font-weight:500; margin:12px 0 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(kb.name)}</div>
                            ${kb.description ? `<div class="kb-card-desc" style="font-size:0.8rem; color:#b7c4ff; margin-bottom:8px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; word-break:break-word;">${escapeHtml(kb.description)}</div>` : ''}
                            <div style="font-size:0.8rem; color:#8e8eb3;">文档数：${kb.document_count || 0}</div>
                            <div style="font-size:0.7rem; color:#6c7b9e; margin-top:4px;">创建：${kb.created_at ? kb.created_at.substring(0,10) : '未知'}</div>
                        </div>
                    `;
                }
            }
            html += `</div>`;
            container.innerHTML = html;

            // 绑定卡片点击进入详情
            container.querySelectorAll('.knowledge-card').forEach(card => {
                card.addEventListener('click', (e) => {
                    if (e.target.closest('button')) return;
                    const kbId = card.dataset.kbId;
                    this.showKnowledgeDetail(kbId);
                });
            });

            // 编辑按钮
            container.querySelectorAll('.edit-kb-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const kbId = btn.dataset.kbId;
                    const card = btn.closest('.knowledge-card');
                    const nameDiv = card.querySelector('.kb-card-name');
                    const descDiv = card.querySelector('.kb-card-desc');
                    const currentName = nameDiv ? nameDiv.textContent : '';
                    const currentDesc = (descDiv && !descDiv.textContent.includes('文档数')) ? descDiv.textContent : '';
                    this.editKnowledgeBase(kbId, currentName, currentDesc);
                });
            });

            // 删除按钮
            container.querySelectorAll('.delete-kb-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const kbId = btn.dataset.kbId;
                    if (!confirm('确定要删除该知识库及其所有文档吗？')) return;
                    try {
                        const res = await fetch(`http://localhost:5051/knowledge_bases/${kbId}`, { method: 'DELETE' });
                        if (res.ok) {
                            this.kbListCache = null;
                            this.customAlert('删除成功', 'success');
                            this.renderKnowledgeBase();
                        } else {
                            const err = await res.json();
                            this.customAlert('删除失败：' + err.error, 'error');
                        }
                    } catch (err) {
                        this.customAlert('删除失败：' + err.message, 'error');
                    }
                });
            });

            // 新建知识库
            document.getElementById('new-kb-btn').addEventListener('click', () => {
                this.createKnowledgeBase();
            });

        } catch (err) {
            container.innerHTML = `<div style="text-align:center;padding:40px;color:#ff7a5c;">加载失败：${err.message}</div>`;
        }
    }

    async showKnowledgeDetail(kbId) {
        const container = document.getElementById('knowledge-base-container');
        if (!container) return;

        // 获取知识库名称
        let kbName = '知识库';
        if (this.kbListCache) {
            const found = this.kbListCache.find(kb => kb.id === kbId);
            if (found) kbName = found.name;
        } else {
            // 如果缓存为空，则重新请求
            try {
                const response = await fetch('http://localhost:5051/knowledge_bases');
                if (response.ok) {
                    const data = await response.json();
                    this.kbListCache = data.knowledge_bases || [];
                    const found = this.kbListCache.find(kb => kb.id === kbId);
                    if (found) kbName = found.name;
                }
            } catch (e) {
                console.warn('获取知识库名称失败', e);
            }
        }
        try {
            const response = await fetch(`http://localhost:5051/knowledge_bases/${kbId}/documents`);
            if (!response.ok) throw new Error('网络错误');
            const data = await response.json();
            const docs = data.documents || [];
            let html = `
                <div id="upload-progress-container" style="display:none; margin-bottom:16px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span id="upload-progress-label">上传中...</span>
                        <span id="upload-progress-percent">0%</span>
                    </div>
                    <div style="width:100%; height:6px; background:rgba(30,34,55,0.6); border-radius:3px; overflow:hidden; margin-top:4px;">
                        <div id="upload-progress-bar" style="width:0%; height:100%; background:linear-gradient(90deg, #5f7eff, #7f9eff); transition:width 0.3s;"></div>
                    </div>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                    <div style="display:flex; align-items:center; gap:12px;">
                        <button class="action-btn" id="back-to-kb-list"><i class="fas fa-arrow-left"></i> 返回</button>
                        <h4 style="margin:0; color:#ccd6ff;">
                            <span class="kb-detail-name" data-kb-id="${kbId}" style="cursor:text;">${kbName}</span>
                        </h4>
                    </div>
                    <button class="action-btn" id="upload-doc-btn"><i class="fas fa-upload"></i> 上传文档</button>
                </div>
                <div style="background:rgba(20,24,45,0.5); border-radius:16px; padding:16px;">
            `;
            if (docs.length === 0) {
                html += `<div style="text-align:center;padding:40px; color:#8e8eb3;">暂无文档，点击“上传文档”添加</div>`;
            } else {
                html += `<div style="display:flex; flex-direction:column; gap:12px;">`;
                for (const doc of docs) {
                    html += `
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px; background:rgba(30,34,55,0.4); border-radius:12px; border-left:3px solid #5f7eff;">
                            <div>
                                <i class="fas fa-file-alt" style="color:#5f7eff; margin-right:12px;"></i>
                                <span>${doc.filename}</span>
                                <span style="font-size:0.7rem; color:#8e8eb3; margin-left:12px;">块数：${doc.chunks}</span>
                            </div>
                            <button class="delete-doc-btn" data-doc-id="${doc.doc_id}" style="background:transparent; border:none; color:#ff8a7a; cursor:pointer;">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                        </div>
                    `;
                }
                html += `</div>`;
            }
            html += `</div>`;
            container.innerHTML = html;

            // 返回列表
            document.getElementById('back-to-kb-list').addEventListener('click', () => {
                this.renderKnowledgeBase();
            });

            // 删除文档
            container.querySelectorAll('.delete-doc-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const docId = btn.dataset.docId;
                    if (!confirm(`确定要删除该文档吗？`)) return;
                    try {
                        const res = await fetch(`http://localhost:5051/knowledge_bases/${kbId}/documents/${docId}`, { method: 'DELETE' });
                        if (res.ok) {
                            this.kbListCache = null; // 清除缓存，使列表页重新获取最新数据
                            this.showKnowledgeDetail(kbId);
                            this.customAlert('删除成功', 'success');
                        } else {
                            const err = await res.json();
                            this.customAlert('删除失败：' + err.error, 'error');
                        }
                    } catch (err) {
                        this.customAlert('删除失败：' + err.message, 'error');
                    }
                });
            });

            // 上传文档
            document.getElementById('upload-doc-btn').addEventListener('click', () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.txt,.pdf,.docx';
                input.onchange = async (e) => {
                    const file = e.target.files[0];
                    if (!file) return;

                    // 获取按钮元素并保存原始内容
                    const uploadBtn = document.getElementById('upload-doc-btn');
                    const originalHTML = uploadBtn.innerHTML;
                    // 禁用按钮并显示加载状态
                    uploadBtn.disabled = true;
                    uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 上传中...';
                    uploadBtn.style.opacity = '0.7';

                    // 显示进度条
                    const progressContainer = document.getElementById('upload-progress-container');
                    const progressBar = document.getElementById('upload-progress-bar');
                    const progressPercent = document.getElementById('upload-progress-percent');
                    const progressLabel = document.getElementById('upload-progress-label');
                    progressContainer.style.display = 'block';
                    progressBar.style.width = '0%';
                    progressPercent.textContent = '0%';
                    progressLabel.textContent = `正在上传 ${file.name} ...`;

                    const formData = new FormData();
                    formData.append('file', file);

                    try {
                        // 1. 上传文件
                        const uploadRes = await fetch(`http://localhost:5051/knowledge_bases/${kbId}/documents`, {
                            method: 'POST',
                            body: formData
                        });

                        if (!uploadRes.ok) {
                            const err = await uploadRes.json();
                            throw new Error(err.error || '上传失败');
                        }

                        const uploadData = await uploadRes.json();
                        const taskId = uploadData.doc_id;

                        // 上传完成，开始轮询处理状态
                        progressLabel.textContent = '上传完成，正在处理...';
                        progressBar.style.width = '10%';
                        progressPercent.textContent = '10%';

                        // 轮询任务状态
                        const pollInterval = setInterval(async () => {
                            try {
                                const statusRes = await fetch(`http://localhost:5051/task_status/${taskId}`);
                                if (!statusRes.ok) {
                                    throw new Error('状态查询失败');
                                }
                                const statusData = await statusRes.json();

                                if (statusData.status === 'processing') {
                                    const prog = statusData.progress || 0;
                                    progressBar.style.width = prog + '%';
                                    progressPercent.textContent = prog + '%';
                                    progressLabel.textContent = `处理中 ${prog}%`;
                                } else if (statusData.status === 'completed') {
                                    clearInterval(pollInterval);
                                    progressLabel.textContent = '处理完成 ✅';
                                    progressBar.style.width = '100%';
                                    progressPercent.textContent = '100%';
                                    this.kbListCache = null;
                                    await this.showKnowledgeDetail(kbId);
                                    uploadBtn.disabled = false;
                                    uploadBtn.innerHTML = originalHTML;
                                    this.customAlert('上传成功', 'success');
                                    setTimeout(() => {
                                        progressContainer.style.display = 'none';
                                    }, 2000);
                                } else if (statusData.status === 'failed') {
                                    clearInterval(pollInterval);
                                    uploadBtn.disabled = false;
                                    uploadBtn.innerHTML = originalHTML;
                                    this.customAlert('处理失败：' + (statusData.error || '未知错误'), 'error');
                                    setTimeout(() => {
                                        progressContainer.style.display = 'none';
                                    }, 3000);
                                }
                            } catch (err) {
                                clearInterval(pollInterval);
                                this.customAlert('状态查询异常：' + err.message, 'error');
                            }
                        }, 3000); // 每3秒轮询一次

                        // 恢复按钮状态（但保持不可用直到处理完成？我们可以在完成后恢复）
                        // 但为了不干扰，我们不恢复，等待完成或失败后恢复。
                        // 在成功或失败的回调中恢复按钮
                    } catch (err) {
                        this.customAlert('上传失败：' + err.message, 'error');
                        uploadBtn.disabled = false;
                        uploadBtn.innerHTML = originalHTML;
                        progressContainer.style.display = 'none';
                    }
                };
                input.click();
            });

            // 恢复进行中的上传任务进度条（关闭页面重开后不丢失）
            this._restoreUploadProgress(kbId);
        } catch (err) {
            container.innerHTML = `<div style="text-align:center;padding:40px;color:#ff7a5c;">加载失败：${err.message}</div>`;
        }
    }

    async _restoreUploadProgress(kbId) {
        try {
            const res = await fetch(`http://localhost:5051/knowledge_bases/${kbId}/tasks`);
            if (!res.ok) return;
            const data = await res.json();
            const tasks = data.tasks || {};

            const progressContainer = document.getElementById('upload-progress-container');
            const progressBar = document.getElementById('upload-progress-bar');
            const progressPercent = document.getElementById('upload-progress-percent');
            const progressLabel = document.getElementById('upload-progress-label');
            if (!progressContainer || !progressBar || !progressPercent || !progressLabel) return;

            for (const [taskId, task] of Object.entries(tasks)) {
                if (task.status === 'processing') {
                    progressContainer.style.display = 'block';
                    progressBar.style.width = task.progress + '%';
                    progressPercent.textContent = task.progress + '%';
                    progressLabel.textContent = `处理中 ${task.progress}%`;

                    const pollInterval = setInterval(async () => {
                        try {
                            const statusRes = await fetch(`http://localhost:5051/task_status/${taskId}`);
                            if (!statusRes.ok) { clearInterval(pollInterval); return; }
                            const s = await statusRes.json();
                            if (s.status === 'processing') {
                                progressBar.style.width = s.progress + '%';
                                progressPercent.textContent = s.progress + '%';
                                progressLabel.textContent = `处理中 ${s.progress}%`;
                            } else if (s.status === 'completed') {
                                clearInterval(pollInterval);
                                progressLabel.textContent = '处理完成 ✅';
                                progressBar.style.width = '100%';
                                progressPercent.textContent = '100%';
                                this.kbListCache = null;
                                await this.showKnowledgeDetail(kbId);
                            } else if (s.status === 'failed') {
                                clearInterval(pollInterval);
                                progressContainer.style.display = 'none';
                                this.customAlert('处理失败：' + (s.error || '未知错误'), 'error');
                            }
                        } catch (e) {
                            clearInterval(pollInterval);
                        }
                    }, 3000);
                    return; // 只恢复第一个进行中的任务
                }
            }
        } catch (e) {
            // 静默失败，不影响页面正常使用
        }
    }

    async showCreateKbDialog() {
        const result = await this.showCustomDialog({
            title: '新建知识库',
            message: `
                <div class="form-group">
                    <label>知识库名称</label>
                    <input type="text" id="new-kb-name" placeholder="请输入名称" style="width:100%;">
                </div>
                <div class="form-group">
                    <label>描述（可选）</label>
                    <textarea id="new-kb-desc" rows="2" placeholder="请输入描述" style="width:100%;"></textarea>
                </div>
            `,
            buttons: [
                { text: '取消', value: null, className: 'cancel' },
                { text: '创建', value: true, className: 'save' }
            ],
            closable: false
        });

        if (result) {
            const nameInput = document.getElementById('new-kb-name');
            const descInput = document.getElementById('new-kb-desc');
            const name = nameInput ? nameInput.value.trim() : '';
            const description = descInput ? descInput.value.trim() : '';
            if (!name) {
                this.customAlert('请输入知识库名称', 'warning');
                return;
            }
            try {
                const res = await fetch('http://localhost:5051/knowledge_bases', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, description })
                });
                if (res.ok) {
                    this.kbListCache = null; // 清除缓存
                    await this.renderKnowledgeBase();
                    this.customAlert('知识库创建成功', 'success');
                } else {
                    const err = await res.json();
                    this.customAlert('创建失败：' + err.error, 'error');
                }
            } catch (err) {
                this.customAlert('创建失败：' + err.message, 'error');
            }
        }
    }

    async createKnowledgeBase() {
        const result = await this.showCustomDialog({
            title: '新建知识库',
            message: `
                <div style="margin-bottom:12px;">
                    <label style="display:block; margin-bottom:4px; color:#b7c4ff;">名称</label>
                    <input type="text" id="new-kb-name" style="width:100%; background:rgba(30,34,55,0.7); border:1px solid rgba(100,130,255,0.4); border-radius:20px; padding:10px 16px; color:#f0f3ff; font-size:0.9rem; outline:none;">
                </div>
                <div>
                    <label style="display:block; margin-bottom:4px; color:#b7c4ff;">描述</label>
                    <textarea id="new-kb-desc" rows="2" style="width:100%; background:rgba(30,34,55,0.7); border:1px solid rgba(100,130,255,0.4); border-radius:20px; padding:10px 16px; color:#f0f3ff; font-size:0.9rem; outline:none; resize:vertical;"></textarea>
                </div>
            `,
            buttons: [
                { text: '取消', value: null, className: 'cancel' },
                { text: '创建', value: 'create', className: 'save' }
            ],
            isHtml: true
        });
        if (result === 'create') {
            const nameInput = document.getElementById('new-kb-name');
            const descInput = document.getElementById('new-kb-desc');
            const name = nameInput ? nameInput.value.trim() : '';
            const description = descInput ? descInput.value.trim() : '';
            if (!name) {
                this.customAlert('请输入知识库名称', 'error');
                return;
            }
            try {
                const res = await fetch('http://localhost:5051/knowledge_bases', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, description })
                });
                if (res.ok) {
                    this.kbListCache = null;
                    this.customAlert('创建成功', 'success');
                    this.renderKnowledgeBase();
                } else {
                    const err = await res.json();
                    this.customAlert('创建失败：' + err.error, 'error');
                }
            } catch (err) {
                this.customAlert('创建失败：' + err.message, 'error');
            }
        }
    }

    async editKnowledgeBase(kbId, currentName, currentDesc) {
        const result = await this.showCustomDialog({
            title: '编辑知识库',
            message: `
                <div style="margin-bottom:12px;">
                    <label style="display:block; margin-bottom:4px; color:#b7c4ff;">名称</label>
                    <input type="text" id="edit-kb-name" value="${escapeHtml(currentName)}" style="width:100%; background:rgba(30,34,55,0.7); border:1px solid rgba(100,130,255,0.4); border-radius:20px; padding:10px 16px; color:#f0f3ff; font-size:0.9rem; outline:none;">
                </div>
                <div>
                    <label style="display:block; margin-bottom:4px; color:#b7c4ff;">描述</label>
                    <textarea id="edit-kb-desc" rows="2" style="width:100%; background:rgba(30,34,55,0.7); border:1px solid rgba(100,130,255,0.4); border-radius:20px; padding:10px 16px; color:#f0f3ff; font-size:0.9rem; outline:none; resize:vertical;">${escapeHtml(currentDesc || '')}</textarea>
                </div>
            `,
            buttons: [
                { text: '取消', value: null, className: 'cancel' },
                { text: '保存', value: 'save', className: 'save' }
            ],
            isHtml: true
        });
        if (result === 'save') {
            const nameInput = document.getElementById('edit-kb-name');
            const descInput = document.getElementById('edit-kb-desc');
            const name = nameInput ? nameInput.value.trim() : '';
            const description = descInput ? descInput.value.trim() : '';
            if (!name) {
                this.customAlert('请输入知识库名称', 'error');
                return;
            }
            try {
                const res = await fetch(`http://localhost:5051/knowledge_bases/${kbId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, description })
                });
                if (res.ok) {
                    this.kbListCache = null;
                    this.customAlert('更新成功', 'success');
                    this.renderKnowledgeBase();
                } else {
                    const err = await res.json();
                    this.customAlert('更新失败：' + err.error, 'error');
                }
            } catch (err) {
                this.customAlert('更新失败：' + err.message, 'error');
            }
        }
    }
}

export default ModalManager;
