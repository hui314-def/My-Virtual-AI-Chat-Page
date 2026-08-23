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
import BgMusicManager from './bg-music-manager.js';
import { resolveAssetUrl, uploadFile } from './asset-sync.js';

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
        }, Constants.MODAL_CLOSE_TIMEOUT_MS);
    }

    /** 显示轻量 toast 提示 */
    showBriefToast(message) {
        const toast = document.createElement('div');
        toast.textContent = message;
        toast.style.cssText = 'position:fixed; bottom:80px; right:20px; background:#2a2f55; color:white; padding:8px 16px; border-radius:20px; z-index:10000;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), Constants.TOAST_DURATION_MS);
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
            else canvasOptions.maxWidth = Constants.CROP_DEFAULT_MAX_WIDTH;
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

    /**
     * 打开对话设置弹窗。
     * @param {Object} [options]
     * @param {boolean} [options.newChat] - true 表示「新建对话」模式：编辑的是一份临时设置，
     *   点击保存设置后才真正创建对话；直接关闭则取消新建。
     */
    openSettingsModal(options = {}) {
        const ctx = this.ctx;
        const newChatMode = !!(options && options.newChat);
        this._newChatMode = newChatMode;
        const currentChat = ctx.chats.find(c => c.id == ctx.currentChatId);
        // 新建模式：使用临时默认设置（基于默认 + 全局模型参数），尚未创建对话
        const settings = newChatMode
            ? this._buildNewChatSettings()
            : (currentChat ? (currentChat.settings || Constants.DEFAULT_SETTINGS) : null);
        if (!settings) return;

        const contextLimit = settings.contextLimit !== undefined ? settings.contextLimit : Constants.DEFAULT_SETTINGS.contextLimit;
        const contextUnlimited = (settings.contextLimit === -1);
        const temperature = settings.temperature !== undefined ? settings.temperature : Constants.DEFAULT_SETTINGS.temperature;
        const topP = settings.topP !== undefined ? settings.topP : Constants.DEFAULT_SETTINGS.topP;
        const thinkLevel = settings.thinkLevel !== undefined ? settings.thinkLevel : Constants.DEFAULT_SETTINGS.thinkLevel;
        const maxTokens = settings.maxTokens !== undefined ? settings.maxTokens : Constants.DEFAULT_SETTINGS.maxTokens;

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
        if (settings.avatarUrl) { avatarImg.src = resolveAssetUrl(settings.avatarUrl); avatarImg.setAttribute('data-custom', 'true'); }
        else { avatarImg.src = Constants.DEFAULT_AI_AVATAR; avatarImg.removeAttribute('data-custom'); }

        // ---- 用户画像（对话级，留空则跟随全局「对话设定」）----
        const userProfileNameInput = document.getElementById('user-profile-name');
        const userProfileBioInput = document.getElementById('user-profile-bio');
        const globalUserName = SettingsManager.getUsername();
        const globalUserBio = SettingsManager.getBio();
        if (userProfileNameInput) {
            userProfileNameInput.value = settings.userProfileName || '';
            userProfileNameInput.placeholder = (globalUserName && globalUserName !== Constants.DEFAULT_USERNAME)
                ? `留空则使用全局昵称：${globalUserName}` : '留空则使用全局昵称';
        }
        if (userProfileBioInput) {
            userProfileBioInput.value = settings.userProfileBio || '';
            userProfileBioInput.placeholder = globalUserBio
                ? `留空则使用全局简介：${globalUserBio}` : '留空则使用全局简介';
        }

        // ---- 生成开场白按钮 ----
        const generateGreetingBtn = document.getElementById('generate-greeting-btn');
        if (generateGreetingBtn) {
            generateGreetingBtn.onclick = async () => {
                const roleName = roleNameInput.value.trim();
                const persona = rolePersona.value.trim();

                // 角色名称和设定都必须填写
                if (!roleName || !persona) {
                    this.customAlert('请先填写"角色名称"和"角色设定"后再生成开场白。', 'warning');
                    return;
                }
                // 用户画像：优先使用弹窗中填写的对话级画像，留空则回退全局「对话设定」
                const chatProfileName = (document.getElementById('user-profile-name')?.value || '').trim();
                const chatProfileBio = (document.getElementById('user-profile-bio')?.value || '').trim();
                const userName = chatProfileName || (SettingsManager.getUsername() === Constants.DEFAULT_USERNAME ? '' : SettingsManager.getUsername());
                const userBio = chatProfileBio || SettingsManager.getBio().trim();

                let userInfo = '';
                if (userName) userInfo += `用户名称：${userName}\n`;
                if (userBio) userInfo += `用户简介：${userBio}\n`;

                const prompt = `你是一位角色设定专家。请根据以下信息，为AI角色生成一句简短的开场白（20-60字），用于AI对话的开始。

角色名称：${roleName}
角色设定：${persona}
${userInfo ? '\n' + userInfo : ''}
开场白应该：
1. 体现角色个性和风格
2. 引导用户开始对话，比如创建一个对话场景，可以包含人物动作、环境描写、情绪描述等非语言表达内容。${userName ? `\n3. 自然地称呼用户"${userName}"，但不要生硬` : ''}
${!userName ? '3. 不要使用"你好，我是..."这类模板化开场\n' : '4. 不要使用"你好，我是..."这类模板化开场\n'}
回复格式规则：当你的回复中包含非语言表达的内容时，请使用括号（）将这些内容包裹起来。例如：“（轻轻叹气）我相信你能做到”。或“（窗外的雨声淅沥）今天的任务完成得不错。”请只返回开场白本身，不要加任何解释或引号。`;

                generateGreetingBtn.disabled = true;
                generateGreetingBtn.textContent = '⏳ 生成中...';
                try {
                    const modelService = ctx.getModelService();
                    // 同步最新配置（模型名可能已切换）
                    modelService.updateConfig({
                        modelHost: SettingsManager.getModelHost(),
                        apiKey: SettingsManager.getApiKey(),
                        modelName: SettingsManager.getModelName(),
                    });
                    const greeting = await modelService.generateText(prompt, {
                        temperature: 0.8,
                        maxTokens: 200
                    });
                    if (greeting && greeting.trim()) {
                        roleGreeting.value = greeting.trim();
                    } else {
                        this.customAlert('生成失败，请重试', 'error');
                    }
                } catch (err) {
                    console.error('生成开场白失败:', err);
                    this.customAlert('生成失败：' + (err.message || '未知错误'), 'error');
                } finally {
                    generateGreetingBtn.disabled = false;
                    generateGreetingBtn.textContent = '✨ 生成';
                }
            };
        }

        // ---- 角色设定折叠/展开（默认折叠只显示约 5 行、底部渐隐、不可编辑；点击下方三角形展开后可编辑）----
        const personaToggleBtn = document.getElementById('persona-toggle-btn');
        const personaFieldWrap = rolePersona.closest('.persona-field-wrap');
        // 每次打开弹窗默认折叠
        const setPersonaCollapsed = (collapsed) => {
            rolePersona.classList.toggle('persona-collapsed', collapsed);
            if (personaFieldWrap) personaFieldWrap.classList.toggle('persona-masked', collapsed);   // 控制底部渐隐遮罩（容器自身不限高）
            rolePersona.readOnly = collapsed;
            if (personaToggleBtn) personaToggleBtn.textContent = collapsed ? '▼' : '▲';
            if (!collapsed) rolePersona.dispatchEvent(new Event('input'));   // 展开时触发自动高度调整
        };
        setPersonaCollapsed(true);
        if (personaToggleBtn) {
            personaToggleBtn.onclick = () => {
                setPersonaCollapsed(!rolePersona.classList.contains('persona-collapsed'));
            };
        }

        // ---- 生成角色设定按钮（点击后在下方展开输入区，再点一次按钮收起；确认后生成并填入）----
        const generatePersonaBtn = document.getElementById('generate-persona-btn');
        const personaGenControls = document.getElementById('persona-gen-controls');
        const personaGenInput = document.getElementById('persona-gen-input');
        const personaGenConfirm = document.getElementById('persona-gen-confirm');

        // 每次打开弹窗时重置输入区状态
        if (personaGenControls) personaGenControls.style.display = 'none';
        if (personaGenInput) personaGenInput.value = '';
        if (generatePersonaBtn) generatePersonaBtn.textContent = '✨ 生成';

        if (generatePersonaBtn && personaGenControls) {
            // 点击生成按钮：展开时按钮变为「✖ 取消」，再点一次收起并清空
            generatePersonaBtn.onclick = () => {
                const isHidden = personaGenControls.style.display === 'none' || !personaGenControls.style.display;
                personaGenControls.style.display = isHidden ? 'block' : 'none';
                if (isHidden) {
                    generatePersonaBtn.textContent = '✖ 取消';
                    if (personaGenInput) personaGenInput.focus();
                } else {
                    if (personaGenInput) personaGenInput.value = '';
                    generatePersonaBtn.textContent = '✨ 生成';
                }
            };
        }

        if (personaGenConfirm && personaGenControls) {
            personaGenConfirm.onclick = async () => {
                const requirement = personaGenInput ? personaGenInput.value.trim() : '';
                if (!requirement) {
                    this.customAlert('请先输入角色设定要求。', 'warning');
                    return;
                }
                const roleName = roleNameInput.value.trim();
                const prompt = `你是一位角色设定专家。请根据以下要求，为AI角色生成一段详细的角色设定。

要求：${requirement}
${roleName ? `角色名称：${roleName}\n` : ''}
角色设定应包含：性格特点、身份背景、说话风格、口头禅/常用语气等，内容详实生动，适合用于角色扮演对话。

请直接输出角色设定文本本身，不要加任何解释、标题或引号。`;

                personaGenConfirm.disabled = true;
                personaGenConfirm.textContent = '⏳ 生成中...';
                try {
                    const modelService = ctx.getModelService();
                    // 同步最新配置（模型名可能已切换）
                    modelService.updateConfig({
                        modelHost: SettingsManager.getModelHost(),
                        apiKey: SettingsManager.getApiKey(),
                        modelName: SettingsManager.getModelName(),
                    });
                    const persona = await modelService.generateText(prompt, {
                        temperature: 0.8,
                        maxTokens: 600
                    });
                    if (persona && persona.trim()) {
                        rolePersona.value = persona.trim();
                        rolePersona.dispatchEvent(new Event('input')); // 触发自动高度调整
                        if (personaGenInput) personaGenInput.value = '';
                        personaGenControls.style.display = 'none';
                        if (generatePersonaBtn) generatePersonaBtn.textContent = '✨ 生成';
                    } else {
                        this.customAlert('生成失败，请重试', 'error');
                    }
                } catch (err) {
                    console.error('生成角色设定失败:', err);
                    this.customAlert('生成失败：' + (err.message || '未知错误'), 'error');
                } finally {
                    personaGenConfirm.disabled = false;
                    personaGenConfirm.textContent = '确定生成';
                }
            };
        }

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
            const savedImageUrl = resolveAssetUrl(settings.bgImageUrl || null);
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

        // ---- 背景音乐 ----
        const bgMusicSwitch = document.getElementById('bg-music-switch');
        const bgMusicControls = document.getElementById('bg-music-controls');
        const bgMusicModeRadios = document.querySelectorAll('input[name="chat-bg-music-mode"]');
        const bgMusicUrlRow = document.getElementById('chat-bg-music-url-row');
        const bgMusicFileRow = document.getElementById('chat-bg-music-file-row');
        const bgMusicAiRow = document.getElementById('chat-bg-music-ai-row');
        const bgMusicUrlInput = document.getElementById('chat-bg-music-url');
        const bgMusicFileName = document.getElementById('chat-bg-music-file-name');
        const bgMusicVolumeSlider = document.getElementById('bg-music-volume');
        const bgMusicVolumeValue = document.getElementById('bg-music-volume-value');

        const bgMusicEnabled = settings.bgMusicEnabled || false;
        if (bgMusicSwitch) {
            bgMusicSwitch.checked = bgMusicEnabled;
            if (bgMusicControls) bgMusicControls.style.display = bgMusicEnabled ? 'block' : 'none';
            bgMusicSwitch.onchange = () => {
                if (bgMusicControls) bgMusicControls.style.display = bgMusicSwitch.checked ? 'block' : 'none';
            };
        }

        const savedMusicMode = settings.bgMusicMode || 'url';
        bgMusicModeRadios.forEach(r => {
            if (r.value === savedMusicMode) r.checked = true;
            r.addEventListener('change', () => {
                const mode = document.querySelector('input[name="chat-bg-music-mode"]:checked')?.value;
                if (bgMusicUrlRow) bgMusicUrlRow.style.display = mode === 'url' ? 'block' : 'none';
                if (bgMusicFileRow) bgMusicFileRow.style.display = mode === 'file' ? 'block' : 'none';
                if (bgMusicAiRow) bgMusicAiRow.style.display = mode === 'ai' ? 'block' : 'none';
            });
        });
        if (savedMusicMode === 'file') {
            if (bgMusicUrlRow) bgMusicUrlRow.style.display = 'none';
            if (bgMusicFileRow) bgMusicFileRow.style.display = 'block';
        } else if (savedMusicMode === 'ai') {
            if (bgMusicUrlRow) bgMusicUrlRow.style.display = 'none';
            if (bgMusicAiRow) bgMusicAiRow.style.display = 'block';
        }
        if (bgMusicUrlInput) {
            bgMusicUrlInput.value = (savedMusicMode === 'url') ? (settings.bgMusicUrl || '') : '';
        }
        if (bgMusicFileName) bgMusicFileName.textContent = settings.bgMusicName || '';

        const savedVolume = settings.bgMusicVolume ?? 0.5;
        if (bgMusicVolumeSlider) {
            bgMusicVolumeSlider.value = Math.round(savedVolume * 100);
            if (bgMusicVolumeValue) bgMusicVolumeValue.textContent = Math.round(savedVolume * 100) + '%';
            bgMusicVolumeSlider.oninput = () => {
                if (bgMusicVolumeValue) bgMusicVolumeValue.textContent = bgMusicVolumeSlider.value + '%';
            };
        }

        this._pendingMusicFile = null;
        const bgMusicFileInput = document.getElementById('chat-bg-music-file');
        if (bgMusicFileInput) {
            bgMusicFileInput.value = '';
            bgMusicFileInput.addEventListener('change', () => {
                const file = bgMusicFileInput.files[0];
                if (!file) return;
                if (file.size > Constants.MAX_AUDIO_SIZE) {
                    this.customAlert('音乐文件过大，请选择小于 50MB 的文件', 'warning');
                    bgMusicFileInput.value = '';
                    return;
                }
                const ext = '.' + file.name.split('.').pop().toLowerCase();
                if (!Constants.ALLOWED_AUDIO_EXTENSIONS.includes(ext)) {
                    this.customAlert('不支持的音频格式，支持: mp3, wav, ogg, flac, m4a', 'warning');
                    bgMusicFileInput.value = '';
                    return;
                }
                this._pendingMusicFile = file;
                if (bgMusicFileName) bgMusicFileName.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`;
            });
        }

        // ---- 背景音乐 AI 生成（输入风格 → 模型生成英文提示词 → 调后端 ComfyUI 生成音乐）----
        this._pendingAiMusicBlob = null;   // 生成的音乐暂存，保存设置时才落库（用最终 chatId）
        const bgMusicAiStyleInput = document.getElementById('chat-bg-music-ai-style');
        const bgMusicAiGenerateBtn = document.getElementById('chat-bg-music-ai-generate');
        const bgMusicAiPlayBtn = document.getElementById('chat-bg-music-ai-play');
        const bgMusicAiStatus = document.getElementById('chat-bg-music-ai-status');

        // 停止试听并清理资源
        const stopAiPreview = () => {
            if (this._aiPreviewAudio) {
                this._aiPreviewAudio.pause();
                this._aiPreviewAudio.src = '';
                this._aiPreviewAudio = null;
            }
            if (this._aiPreviewUrl) {
                URL.revokeObjectURL(this._aiPreviewUrl);
                this._aiPreviewUrl = null;
            }
            if (bgMusicAiPlayBtn) bgMusicAiPlayBtn.textContent = '▶ 试听';
        };

        // 每次打开弹窗时清理上次的试听状态
        stopAiPreview();

        // 试听：播放当前已生成的音乐，再点停止
        if (bgMusicAiPlayBtn) {
            bgMusicAiPlayBtn.onclick = () => {
                if (!this._pendingAiMusicBlob) return;
                if (this._aiPreviewAudio && !this._aiPreviewAudio.paused) {
                    stopAiPreview();
                    return;
                }
                stopAiPreview();
                const url = URL.createObjectURL(this._pendingAiMusicBlob);
                this._aiPreviewUrl = url;
                const audio = new Audio(url);
                audio.onended = () => stopAiPreview();
                audio.onerror = () => { stopAiPreview(); this.customAlert('试听失败，无法播放音频', 'error'); };
                audio.play().catch(() => { stopAiPreview(); this.customAlert('试听失败，无法播放音频', 'error'); });
                this._aiPreviewAudio = audio;
                if (bgMusicAiPlayBtn) bgMusicAiPlayBtn.textContent = '⏹ 停止试听';
            };
        }

        if (bgMusicAiGenerateBtn) {
            bgMusicAiGenerateBtn.onclick = async () => {
                const style = bgMusicAiStyleInput ? bgMusicAiStyleInput.value.trim() : '';
                if (!style) {
                    this.customAlert('请先输入想要的音乐风格。', 'warning');
                    return;
                }
                stopAiPreview();   // 重新生成前停止旧试听
                if (bgMusicAiPlayBtn) bgMusicAiPlayBtn.style.display = 'none';
                bgMusicAiGenerateBtn.disabled = true;
                if (bgMusicAiStatus) bgMusicAiStatus.textContent = '⏳ 正在生成英文提示词...';
                try {
                    // 1. 模型生成细致具体的英文提示词
                    const modelService = ctx.getModelService();
                    modelService.updateConfig({
                        modelHost: SettingsManager.getModelHost(),
                        apiKey: SettingsManager.getApiKey(),
                        modelName: SettingsManager.getModelName(),
                    });
                    const promptText = `你是音乐提示词专家。根据用户的音乐风格描述，创作一段用于 AI 音乐生成（Stable Audio）的英文提示词。

要求：
- 全英文
- 细致具体：包含音乐流派/风格、情绪氛围、主要乐器、节奏速度、音色质感、适用场景等
- 2-3 句，总词数 30-80
- 只输出提示词本身，不要任何解释、引号或多余文字

用户的风格描述：${style}`;
                    const englishPrompt = await modelService.generateText(promptText, { temperature: 0.7, maxTokens: 300 });
                    if (!englishPrompt || !englishPrompt.trim()) throw new Error('提示词生成失败');
                    if (bgMusicAiStatus) bgMusicAiStatus.textContent = '🎵 正在生成音乐（约 40 秒）...';

                    // 2. 请求后端 ComfyUI 生成音乐（返回 MP3 二进制）
                    const imgApiUrl = SettingsManager.getImgApiUrl();
                    const imgApiKey = SettingsManager.getImgApiKey();
                    const headers = { 'Content-Type': 'application/json' };
                    if (imgApiKey) headers['X-API-Key'] = imgApiKey;
                    const resp = await fetch(`${imgApiUrl}/generate_audio`, {
                        method: 'POST', headers,
                        body: JSON.stringify({ positive_prompt: englishPrompt.trim(), negative_prompt: '', duration: 40 })
                    });
                    if (!resp.ok) {
                        let msg = '生成失败';
                        try { const e = await resp.json(); msg = e.error || msg; } catch { /* ignore */ }
                        throw new Error(msg);
                    }
                    const blob = await resp.blob();
                    if (!blob || blob.size === 0) throw new Error('生成的音频为空');

                    // 3. 暂存 blob，保存设置时落库；保持 AI 生成模式可见（可试听 / 再次生成）
                    this._pendingAiMusicBlob = blob;
                    bgMusicModeRadios.forEach(r => { r.checked = (r.value === 'ai'); });
                    if (bgMusicUrlRow) bgMusicUrlRow.style.display = 'none';
                    if (bgMusicFileRow) bgMusicFileRow.style.display = 'none';
                    if (bgMusicAiRow) bgMusicAiRow.style.display = 'block';
                    if (bgMusicSwitch) {
                        bgMusicSwitch.checked = true;
                        if (bgMusicControls) bgMusicControls.style.display = 'block';
                    }
                    // 生成完成：显示试听按钮，可试听或修改风格再次生成
                    if (bgMusicAiPlayBtn) bgMusicAiPlayBtn.style.display = 'inline-block';
                    if (bgMusicAiStatus) bgMusicAiStatus.textContent = '✅ 生成完成，可试听；不满意可修改风格重新生成';
                } catch (err) {
                    console.error('AI 生成背景音乐失败:', err);
                    if (bgMusicAiStatus) bgMusicAiStatus.textContent = '';
                    this.customAlert('生成音乐失败：' + (err.message || '未知错误'), 'error');
                } finally {
                    bgMusicAiGenerateBtn.disabled = false;
                }
            };
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
        // 新建模式：标题提示「新建对话」
        const headerTitle = modal.querySelector('.modal-header h3');
        if (headerTitle) {
            headerTitle.innerHTML = newChatMode
                ? '<i class="fas fa-plus-circle"></i> 新建对话'
                : '<i class="fas fa-sliders-h"></i> 对话设置';
        }
        modal.style.display = 'flex';
        ctx.bindAutoResize(rolePersona);
        ctx.bindAutoResize(roleGreeting);
    }

    // 新对话的临时默认设置：继承全局模型参数（与原 createNewChat 保持一致）
    _buildNewChatSettings() {
        const s = JSON.parse(JSON.stringify(Constants.DEFAULT_SETTINGS));
        s.contextLimit = SettingsManager.getContextLimit();
        s.temperature = SettingsManager.getTemperature();
        s.topP = SettingsManager.getTopP();
        s.thinkLevel = SettingsManager.getThinkLevel();
        s.maxTokens = SettingsManager.getMaxTokens();
        return s;
    }

    // 新建模式：从弹窗表单收集「创建对话时即需确定」的字段
    _collectNewChatSettings() {
        const s = this._buildNewChatSettings();
        const contextUnlimited = document.getElementById('context-unlimited').checked;
        let contextLimit = parseInt(document.getElementById('context-limit').value);
        if (contextUnlimited) contextLimit = -1;
        s.contextLimit = contextLimit;
        s.temperature = parseFloat(document.getElementById('temperature').value);
        s.topP = parseFloat(document.getElementById('top-p').value);
        s.thinkLevel = parseInt(document.getElementById('think-level').value);
        s.maxTokens = parseInt(document.getElementById('max-tokens').value);
        s.roleName = document.getElementById('role-name').value.trim() || Constants.DEFAULT_ROLE_NAME;
        s.persona = document.getElementById('role-persona').value.trim() || '暂无设定';
        s.greeting = document.getElementById('role-greeting').value.trim() || '✨ 你好，我是你的虚拟AI伙伴。';
        s.userProfileName = document.getElementById('user-profile-name')?.value?.trim() || '';
        s.userProfileBio = document.getElementById('user-profile-bio')?.value?.trim() || '';
        const avatarImg = document.getElementById('avatar-img');
        s.avatarUrl = avatarImg && avatarImg.hasAttribute('data-custom') ? avatarImg.src : null;
        const bgType = document.getElementById('bg-type')?.value || '';
        s.bgType = bgType || null;
        if (bgType === 'image') {
            const bgImg = document.getElementById('bg-img');
            s.bgImageUrl = (bgImg && bgImg.hasAttribute('data-custom')) ? bgImg.src : null;
        }
        s.ttsEnabled = document.getElementById('tts-switch').checked;
        s.ttsVoice = document.getElementById('tts-voice-select').value;
        return s;
    }

    closeSettingsModal() {
        const modal = document.getElementById('settings-modal');
        this.closeModalWithAnimation(modal, () => {
            // 关闭 = 取消新建模式（若未保存则不创建对话）
            this._newChatMode = false;
        });
    }

    async saveSettings() {
        const ctx = this.ctx;
        const isNewChat = !!this._newChatMode;
        if (isNewChat) {
            // 新建模式：点击「保存设置」= 真正创建对话（其余字段由下方逻辑继续写入）
            await ctx.createNewChatWithSettings(this._collectNewChatSettings());
        } else {
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
        }
        const currentChat = ctx.chats.find(c => c.id == ctx.currentChatId);
        if (!currentChat) return;
        const oldGreeting = currentChat.settings?.greeting || Constants.DEFAULT_SETTINGS.greeting;
        // 记录写入前的旧值（浅拷贝，用于判断是否需要重建聊天框）
        const oldSettings = { ...(currentChat.settings || {}) };

        const newRoleName = document.getElementById('role-name').value.trim() || Constants.DEFAULT_ROLE_NAME;
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
        // 对话级用户画像（留空 = 跟随全局「对话设定」）
        currentChat.settings.userProfileName = document.getElementById('user-profile-name')?.value?.trim() || '';
        currentChat.settings.userProfileBio = document.getElementById('user-profile-bio')?.value?.trim() || '';

        const avatarImg = document.getElementById('avatar-img');
        const newAvatarUrl = avatarImg && avatarImg.hasAttribute('data-custom') ? avatarImg.src : null;
        currentChat.settings.avatarUrl = newAvatarUrl;

        // ---- 背景类型 ----
        const bgType = document.getElementById('bg-type')?.value || '';
        currentChat.settings.bgType = bgType || null;  // null = 默认背景

        if (bgType === 'image') {
            const bgImg = document.getElementById('bg-img');
            currentChat.settings.bgImageUrl = (bgImg && bgImg.hasAttribute('data-custom')) ? bgImg.src : null;
        } else {
            // 切换到默认/视频背景时清除图片设置
            currentChat.settings.bgImageUrl = null;
        }
        if (bgType === 'video') {
            const videoMode = document.querySelector('input[name="chat-bg-video-mode"]:checked')?.value || 'url';
            currentChat.settings.bgVideoMode = videoMode;
            if (videoMode === 'url') {
                currentChat.settings.bgVideoUrl = document.getElementById('chat-bg-video-url')?.value?.trim() || '';
                currentChat.settings.bgVideoName = '';
                // 切换到 URL 模式可清除旧的 IndexedDB 文件
                AssetStore.deleteVideo(currentChat.id).catch(() => {});
            } else {
                // 文件模式：本地 IndexedDB 留存（离线可用）+ 后端上传（跨设备共享，失败则仅本地）
                if (this._pendingVideoFile) {
                    await AssetStore.saveVideo(currentChat.id, this._pendingVideoFile);
                    currentChat.settings.bgVideoName = this._pendingVideoFile.name;
                    currentChat.settings.bgVideoMode = 'file';
                    const ref = await uploadFile(this._pendingVideoFile);
                    currentChat.settings.bgVideoUrl = ref || '';
                    this._pendingVideoFile = null;
                }
                // 无新文件 → 保持已有设置不变
            }
        } else {
            // 默认背景：保留 image/video 数据不清空，方便切回来恢复
            currentChat.settings.bgVideoMode = 'url';
            currentChat.settings.bgVideoName = '';
        }

        // ---- 背景音乐 ----
        const musicEnabled = document.getElementById('bg-music-switch')?.checked || false;
        currentChat.settings.bgMusicEnabled = musicEnabled;

        if (musicEnabled) {
            const rawMusicMode = document.querySelector('input[name="chat-bg-music-mode"]:checked')?.value || 'url';
            // AI 模式但未生成音乐时按 URL 处理（无音乐）
            const musicMode = rawMusicMode === 'ai' ? 'url' : rawMusicMode;
            const musicVolumeSlider = document.getElementById('bg-music-volume');
            currentChat.settings.bgMusicVolume = musicVolumeSlider ? parseInt(musicVolumeSlider.value) / 100 : 0.5;

            if (this._pendingAiMusicBlob) {
                // AI 生成音乐：本地 IndexedDB 留存（离线可用）+ 后端上传（跨设备）
                await AssetStore.saveAudio(currentChat.id, this._pendingAiMusicBlob);
                const ref = await uploadFile(this._pendingAiMusicBlob);
                currentChat.settings.bgMusicUrl = ref || '';
                currentChat.settings.bgMusicName = 'AI 生成音乐';
                currentChat.settings.bgMusicMode = 'file';
                this._pendingAiMusicBlob = null;
            } else if (musicMode === 'url') {
                currentChat.settings.bgMusicMode = 'url';
                currentChat.settings.bgMusicUrl = document.getElementById('chat-bg-music-url')?.value?.trim() || '';
                currentChat.settings.bgMusicName = '';
                AssetStore.deleteAudio(currentChat.id).catch(() => {});
            } else {
                currentChat.settings.bgMusicMode = 'file';
                if (this._pendingMusicFile) {
                    // 本地 IndexedDB 留存（离线可用）+ 后端上传（跨设备）
                    await AssetStore.saveAudio(currentChat.id, this._pendingMusicFile);
                    currentChat.settings.bgMusicName = this._pendingMusicFile.name;
                    const ref = await uploadFile(this._pendingMusicFile);
                    currentChat.settings.bgMusicUrl = ref || '';
                    this._pendingMusicFile = null;
                }
                // 无新文件 → 保持已有设置不变
            }
        } else {
            // 音乐关闭：停止播放（applyCurrentChatSettings 随后会移除播放器浮栏）
            BgMusicManager.stop();
            this._pendingAiMusicBlob = null;   // 放弃未保存的 AI 生成音乐
        }

        const ttsEnabled = document.getElementById('tts-switch').checked;
        const ttsVoice = document.getElementById('tts-voice-select').value;
        currentChat.settings.ttsEnabled = ttsEnabled;
        currentChat.settings.ttsVoice = ttsVoice;

        ctx.applyCurrentChatSettings();
        ctx.renderHistoryList();
        await ctx.chatRepo.saveChat(currentChat);
        // 保存完成：停止 AI 音乐试听（避免与背景音乐重叠）
        if (this._aiPreviewAudio) {
            this._aiPreviewAudio.pause();
            this._aiPreviewAudio.src = '';
            this._aiPreviewAudio = null;
        }
        if (this._aiPreviewUrl) {
            URL.revokeObjectURL(this._aiPreviewUrl);
            this._aiPreviewUrl = null;
        }
        if (oldGreeting !== newGreeting) {
            ctx.startNewTopic();   // 内部会重新渲染新话题的消息
        } else if (this.#chatUiSettingsChanged(oldSettings)) {
            // 仅当 UI 显示相关设置（角色头像 / 角色名称 / 背景）变化时才重建聊天框
            ctx.renderMessages(ctx.currentChatId, ctx.currentTopicIndex);
        }
        this.closeSettingsModal();
    }

    /** 判断对话设置中「UI 显示相关」字段是否发生变化（角色头像 / 角色名称 / 背景） */
    #chatUiSettingsChanged(oldSettings) {
        const s = this.ctx.chats.find(c => c.id == this.ctx.currentChatId)?.settings || {};
        return (s.avatarUrl ?? null) !== (oldSettings.avatarUrl ?? null)
            || s.roleName !== (oldSettings.roleName ?? Constants.DEFAULT_ROLE_NAME)
            || (s.bgType ?? null) !== (oldSettings.bgType ?? null)
            || (s.bgImageUrl ?? null) !== (oldSettings.bgImageUrl ?? null)
            || (s.bgVideoUrl ?? '') !== (oldSettings.bgVideoUrl ?? '')
            || (s.bgVideoName ?? '') !== (oldSettings.bgVideoName ?? '')
            || (s.bgVideoMode ?? 'url') !== (oldSettings.bgVideoMode ?? 'url');
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

        // 知识库改为懒加载：打开设置不请求，点击「知识库」标签时才加载
        this.kbManager.resetTabLoaded();

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

        // 初始化「设置发生变动」追踪：捕获快照并绑定变更监听
        this.initGlobalSettingsDirtyTracking();
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

    // ==================== 「设置发生变动」提示（个性化设置弹窗） ====================
    // saveGlobalSettings 实际读取并写入存储的表单控件（用于判定设置是否发生变动）
    #GLOBAL_SETTINGS_FIELD_IDS = [
        'model-host', 'api-key', 'global-username', 'global-bio', 'global-avatar-upload',
        'global-context-limit', 'global-context-unlimited', 'quick-model-select',
        'global-temperature', 'global-top-p', 'global-think-level', 'global-max-tokens',
        'global-theme', 'global-font-size', 'tts-api-url', 'tts-api-key',
        'img-api-url', 'img-api-key', 'global-typing-speed', 'global-auto-scroll',
        'model-provider',
    ];

    /** 捕获当前设置快照（表单控件值 + 头像 + 快捷键） */
    captureGlobalSettingsSnapshot() {
        const controls = new Map();
        for (const id of this.#GLOBAL_SETTINGS_FIELD_IDS) {
            const el = document.getElementById(id);
            if (!el) continue;
            controls.set(id, el.type === 'checkbox' ? el.checked : el.value);
        }
        const avatarImg = document.getElementById('global-avatar-img');
        this._globalSettingsSnapshot = {
            controls,
            avatarSrc: avatarImg ? avatarImg.src : '',
            shortcuts: JSON.stringify(this.ctx.getShortcuts()),
        };
    }

    /** 判断设置是否发生了变动（与打开弹窗时的快照对比） */
    isGlobalSettingsDirty() {
        const snap = this._globalSettingsSnapshot;
        if (!snap) return false;
        for (const [id, initial] of snap.controls) {
            const el = document.getElementById(id);
            if (!el) continue;
            const now = el.type === 'checkbox' ? el.checked : el.value;
            if (now !== initial) return true;
        }
        const avatarImg = document.getElementById('global-avatar-img');
        if (avatarImg && avatarImg.src !== snap.avatarSrc) return true;
        if (JSON.stringify(this.ctx.getShortcuts()) !== snap.shortcuts) return true;
        return false;
    }

    /** 根据变动状态显示/隐藏「设置发生变动」提示 */
    refreshGlobalSettingsDirtyHint() {
        const hint = document.getElementById('global-settings-dirty');
        if (!hint) return;
        hint.style.display = this.isGlobalSettingsDirty() ? 'flex' : 'none';
    }

    /** 初始化变动追踪：捕获快照 + 绑定变更监听（打开弹窗时调用，幂等） */
    initGlobalSettingsDirtyTracking() {
        this.captureGlobalSettingsSnapshot();
        this.refreshGlobalSettingsDirtyHint();

        const modal = document.getElementById('global-settings-modal');
        if (!modal || modal._dirtyTrackingBound) return;
        modal._dirtyTrackingBound = true;

        const fieldIds = new Set(this.#GLOBAL_SETTINGS_FIELD_IDS);
        const check = () => this.refreshGlobalSettingsDirtyHint();
        // 事件委托：只对设置字段的 input/change 触发检查
        modal.addEventListener('input', (e) => { if (fieldIds.has(e.target?.id)) check(); });
        modal.addEventListener('change', (e) => { if (fieldIds.has(e.target?.id)) check(); });

        // 头像裁剪完成后 src 更新（img 重新加载时触发）
        const avatarImg = document.getElementById('global-avatar-img');
        if (avatarImg) avatarImg.addEventListener('load', check);

        // 快捷键：录制完成 / 恢复默认时面板结构或文本变化（MutationObserver 触发）
        const shortcutsList = document.getElementById('shortcuts-list');
        if (shortcutsList && !shortcutsList._dirtyObserver) {
            shortcutsList._dirtyObserver = new MutationObserver(check);
            shortcutsList._dirtyObserver.observe(shortcutsList, { childList: true, subtree: true, characterData: true });
        }
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
        // 保存成功：刷新快照（隐藏「设置发生变动」提示），不自动关闭弹窗
        this.captureGlobalSettingsSnapshot();
        this.refreshGlobalSettingsDirtyHint();
        this.showBriefToast('设置已保存');
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
            const selectedIdsStr = localStorage.getItem(Constants.STORAGE_KEYS.SELECTED_KB_IDS) || '';
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
        localStorage.setItem(Constants.STORAGE_KEYS.SELECTED_KB_IDS, ids.join(','));
        localStorage.setItem(Constants.STORAGE_KEYS.SELECTED_KB_NAMES, names.join(','));

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
