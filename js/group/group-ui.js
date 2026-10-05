// ============================================================
// 群聊 · UI（新建群聊弹窗 + 群聊设置弹窗）
// ------------------------------------------------------------
// 依赖通过构造注入（与项目其余模块风格一致），避免循环引用。
// 弹窗 DOM 由 script.js 在 init() 时从 templates/group.html 注入。
// ============================================================
import Constants from '../core/constants.js';
import { SettingsManager } from '../core/settings-manager.js';
import { resolveAssetUrl } from '../network/asset-sync.js';
import { escapeHtml } from '../core/utils.js';
import AssetStore from '../storage/asset-store.js';
import BackgroundManager from '../media/background-manager.js';
import {
    isGroupChat, ensureGroupDefaults, resolveMemberSettings,
    buildInitialSpaceSettings, GROUP_MIN_MEMBERS, GROUP_MAX_MEMBERS,
    MEMBER_HUES, defaultOrchestratorPolicy, SPACE_LEVEL_KEYS, pick,
} from './group-core.js';

export class GroupUI {
    /**
     * @param {Object} deps
     * @param {() => Array} deps.getChats
     * @param {() => number|string|null} deps.getCurrentChatId
     * @param {() => Object} deps.getChatManager        - 用于 createGroupChat / renameGroup
     * @param {() => Object} deps.getModalManager
     * @param {Object} deps.chatRepo
     * @param {() => void} deps.renderHistoryList
     * @param {() => void} deps.renderMessages
     * @param {() => void} deps.applyCurrentChatSettings
     * @param {() => void} deps.onSpectatorToggle        - 旁观的启停（由 script.js 实现）
     * @param {() => boolean} deps.isSpectating
     */
    constructor({
        getChats, getCurrentChatId, getChatManager, getModalManager,
        chatRepo, renderHistoryList, renderMessages, applyCurrentChatSettings,
        onSpectatorToggle = () => {}, isSpectating = () => false,
    }) {
        this.getChats = getChats;
        this.getCurrentChatId = getCurrentChatId;
        this.getChatManager = getChatManager;
        this.getModalManager = getModalManager;
        this.chatRepo = chatRepo;
        this.renderHistoryList = renderHistoryList;
        this.renderMessages = renderMessages;
        this.applyCurrentChatSettings = applyCurrentChatSettings;
        this.onSpectatorToggle = onSpectatorToggle;
        this.isSpectating = isSpectating;

        /** 新建群聊弹窗中被选中的角色 key 集合 */
        this._selectedKeys = new Set();
        /** 群聊设置弹窗当前编辑的会话 */
        this._editingChat = null;
        /** 待保存的群空间设置（弹窗草稿） */
        this._draftSpace = null;
    }

    get modalManager() { return this.getModalManager(); }

    // ============================================================
    // 通用小工具
    // ============================================================

    /** 角色头像 HTML（无头像时退化为首字圆形） */
    _avatarHtml(char, size = 34) {
        const raw = char.avatarUrl || char.avatar || null;
        const style = `width:${size}px;height:${size}px;`;
        if (raw) {
            return `<img src="${escapeHtml(resolveAssetUrl(raw))}" style="${style}" alt="">`;
        }
        const initial = escapeHtml(String(char.name || char.roleName || '?').slice(0, 1));
        return `<span class="grp-char-avatar" style="${style}">${initial}</span>`;
    }

    /** 可用于建群的「角色池」：来自私聊对话存档 */
    buildCharacterPool() {
        const out = [];
        const seen = new Set();
        for (const c of this.getChats() || []) {
            if (!c || isGroupChat(c)) continue;
            const name = String(c.settings?.roleName || '').trim();
            if (!name) continue;
            const sig = `${name}::${String(c.settings?.persona || '').slice(0, 60)}`;
            if (seen.has(sig)) continue;     // 同名同人设去重
            seen.add(sig);
            out.push({
                key: `chat-${c.id}`,
                sourceChatId: c.id,
                sourceTitle: c.title || `对话 ${c.id}`,
                name,
                persona: c.settings?.persona || '',
                avatarUrl: c.settings?.avatarUrl || c.settings?.avatar || null,
            });
        }
        return out;
    }

    // ============================================================
    // ① 新建群聊弹窗
    // ============================================================

    get createModal() { return document.getElementById('group-create-modal'); }

    bindCreateModal() {
        const modal = this.createModal;
        if (!modal || modal._grpBound) return;
        modal._grpBound = true;

        document.getElementById('grp-create-close').addEventListener('click', () => this.closeCreateModal());
        document.getElementById('grp-create-cancel').addEventListener('click', () => this.closeCreateModal());
        document.getElementById('grp-create-confirm').addEventListener('click', () => this.confirmCreate());

        // 成员多选：事件委托（自己管理勾选状态，避免 label 默认行为双触发）
        const list = document.getElementById('grp-char-list');
        list.addEventListener('click', (e) => {
            const item = e.target.closest('.grp-char');
            if (!item || item.classList.contains('disabled')) return;
            e.preventDefault();
            const key = item.dataset.key;
            if (this._selectedKeys.has(key)) {
                this._selectedKeys.delete(key);
            } else {
                if (this._selectedKeys.size >= GROUP_MAX_MEMBERS) {
                    this.modalManager.showBriefToast(`最多只能选 ${GROUP_MAX_MEMBERS} 个角色`);
                    return;
                }
                this._selectedKeys.add(key);
            }
            this._renderCreateList();
        });

        this.modalManager.bindModalOverlayClose(modal, () => this.closeCreateModal());
    }

    openCreateModal() {
        this.bindCreateModal();
        const modal = this.createModal;
        if (!modal) return;

        const pool = this.buildCharacterPool();
        if (!pool.length) {
            this.modalManager.customAlert(
                '还没有可用的角色。\n\n请先在主界面用「新对话」创建至少一个角色对话，再回来组建群聊。',
                'warning'
            );
            return;
        }

        this._selectedKeys.clear();
        const nameInput = document.getElementById('grp-group-name');
        if (nameInput) nameInput.value = '';
        this._renderCreateList();

        modal.style.display = 'flex';
    }

    closeCreateModal() {
        const modal = this.createModal;
        if (modal) modal.style.display = 'none';
    }

    _renderCreateList() {
        const pool = this.buildCharacterPool();
        const list = document.getElementById('grp-char-list');
        if (!list) return;

        const full = this._selectedKeys.size >= GROUP_MAX_MEMBERS;

        list.innerHTML = pool.map(c => {
            const selected = this._selectedKeys.has(c.key);
            const disabled = !selected && full;
            return `<div class="grp-char ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}" data-key="${escapeHtml(c.key)}">
                ${this._avatarHtml(c, 34)}
                <span class="grp-char-meta">
                    <span class="grp-char-name">${escapeHtml(c.name)}</span>
                    <span class="grp-char-src">${escapeHtml(c.sourceTitle)}</span>
                </span>
                <i class="fas fa-circle-check grp-char-check"></i>
            </div>`;
        }).join('');

        const n = this._selectedKeys.size;
        const counter = document.getElementById('grp-char-count');
        if (counter) {
            counter.textContent = `已选 ${n} / ${GROUP_MAX_MEMBERS}`;
            counter.classList.toggle('invalid', n > 0 && n < GROUP_MIN_MEMBERS);
        }

        const confirmBtn = document.getElementById('grp-create-confirm');
        if (confirmBtn) {
            confirmBtn.disabled = !(n >= GROUP_MIN_MEMBERS && n <= GROUP_MAX_MEMBERS);
        }

        const hint = document.getElementById('grp-create-hint');
        if (hint) {
            if (n === 0) hint.textContent = `请选择 ${GROUP_MIN_MEMBERS}~${GROUP_MAX_MEMBERS} 个角色来组建群聊。`;
            else if (n < GROUP_MIN_MEMBERS) hint.textContent = `还需要再选 ${GROUP_MIN_MEMBERS - n} 个角色才能建群。`;
            else hint.textContent = '';
        }
    }

    async confirmCreate() {
        const pool = this.buildCharacterPool();
        const picked = pool.filter(c => this._selectedKeys.has(c.key));
        if (picked.length < GROUP_MIN_MEMBERS || picked.length > GROUP_MAX_MEMBERS) {
            this.modalManager.customAlert(`请选择 ${GROUP_MIN_MEMBERS}~${GROUP_MAX_MEMBERS} 个角色。`, 'warning');
            return;
        }

        const nameInput = document.getElementById('grp-group-name');
        const customName = (nameInput?.value || '').trim();

        try {
            const chatManager = this.getChatManager();
            const chat = await chatManager.createGroupChat({ members: picked, name: customName });
            this.closeCreateModal();
            this.modalManager.showBriefToast(`👥 群聊已创建（${picked.length} 位成员）`);
            return chat;
        } catch (err) {
            console.error('[GroupUI] 创建群聊失败：', err);
            this.modalManager.customAlert('创建群聊失败：' + (err.message || err), 'error');
        }
    }

    // ============================================================
    // ② 群聊设置弹窗
    // ============================================================

    get settingsModal() { return document.getElementById('group-settings-modal'); }

    /** 当前正在编辑的群聊（设置弹窗打开时有效） */
    get editingChat() {
        if (this._editingChat) return this._editingChat;
        const id = this.getCurrentChatId();
        return (this.getChats() || []).find(c => c.id == id) || null;
    }

    bindSettingsModal() {
        const modal = this.settingsModal;
        if (!modal || modal._grpBound) return;
        modal._grpBound = true;

        document.getElementById('grp-settings-close').addEventListener('click', () => this.closeSettingsModal());
        document.getElementById('grp-settings-cancel').addEventListener('click', () => this.closeSettingsModal());
        document.getElementById('grp-settings-save').addEventListener('click', () => this.saveSettings());

        // ---- 群聊头像：点击预览 → 选图 → **裁剪**（与「角色头像」一致：1:1） ----
        const avatarPreview = document.getElementById('grp-avatar-preview');
        const avatarUpload = document.getElementById('grp-avatar-upload');
        avatarPreview?.addEventListener('click', () => avatarUpload?.click());
        avatarUpload?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            e.target.value = '';
            // 与私聊的角色头像完全相同的裁剪参数：正方形、最大 1024、JPEG 0.9
            this.modalManager.showCropModal(
                file, 1,
                { maxWidth: 1024, mimeType: 'image/jpeg', quality: 0.9 },
                (croppedDataUrl) => {
                    this._draftSpace.avatarUrl = croppedDataUrl;
                    this._renderAvatarPreview(croppedDataUrl);
                }
            );
        });

        // ---- 群空间：背景类型切换 ----
        const bgTypeSel = document.getElementById('grp-bg-type');
        bgTypeSel?.addEventListener('change', () => this._syncBgSections());

        // 背景图上传 → **裁剪**（与私聊的「聊天背景」一致：自由裁剪 + 压缩）→ 实时预览
        document.getElementById('grp-bg-upload')?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            e.target.value = '';
            this.modalManager.showCropModal(
                file, NaN,
                { maxWidth: Constants.BG_CROP_MAX_WIDTH, mimeType: 'image/jpeg' },
                (croppedDataUrl) => {
                    this._draftSpace.bgImageUrl = croppedDataUrl;
                    const img = document.getElementById('grp-bg-img');
                    if (img) img.src = croppedDataUrl;
                    // 实时预览到聊天区（与私聊「对话设置」里的体验一致）
                    try {
                        BackgroundManager.apply({ bgType: 'image', bgImageUrl: croppedDataUrl });
                    } catch (err) {
                        console.warn('[GroupUI] 背景实时预览失败：', err);
                    }
                }
            );
        });

        // 视频模式切换
        document.querySelectorAll('input[name="grp-bg-video-mode"]').forEach(radio => {
            radio.addEventListener('change', () => this._syncBgVideoRows());
        });
        document.getElementById('grp-bg-video-file')?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            this._pendingVideoFile = file;
            const nameEl = document.getElementById('grp-bg-video-file-name');
            if (nameEl) nameEl.textContent = file.name;
        });

        // 背景音乐
        const musicSwitch = document.getElementById('grp-bg-music-switch');
        musicSwitch?.addEventListener('change', () => this._syncMusicRows());
        document.querySelectorAll('input[name="grp-bg-music-mode"]').forEach(radio => {
            radio.addEventListener('change', () => this._syncMusicRows());
        });
        document.getElementById('grp-bg-music-file')?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            this._pendingMusicFile = file;
            const nameEl = document.getElementById('grp-bg-music-file-name');
            if (nameEl) nameEl.textContent = file.name;
        });
        const vol = document.getElementById('grp-bg-music-volume');
        vol?.addEventListener('input', () => {
            const label = document.getElementById('grp-bg-music-volume-value');
            if (label) label.textContent = vol.value + '%';
        });

        // ---- 编排策略：滑杆 ----
        const bindRange = (id, valId, key, fmt = (v) => String(v)) => {
            const input = document.getElementById(id);
            const label = document.getElementById(valId);
            if (!input) return;
            input.addEventListener('input', () => {
                const chat = this.editingChat;
                if (chat?.orchestrator) chat.orchestrator[key] = Number(input.value);
                if (label) label.textContent = fmt(input.value);
            });
        };
        bindRange('grp-max-responders', 'grp-max-responders-val', 'maxResponders');
        bindRange('grp-max-total', 'grp-max-total-val', 'maxTotalReplies');
        // 自动接力是默认行为，用「轮数」表达强度（0 = 不接力）
        bindRange('grp-relay-rounds', 'grp-relay-rounds-val', 'autoRelayMaxRounds',
            (v) => (Number(v) === 0 ? '关' : String(v)));
        bindRange('grp-spectator-rounds', 'grp-spectator-rounds-val', 'spectatorRounds');
        bindRange('grp-context-messages', 'grp-context-messages-val', 'contextMessages');

        // 发言顺序（下拉）
        const orderSel = document.getElementById('grp-speaker-order');
        orderSel?.addEventListener('change', () => {
            const chat = this.editingChat;
            if (chat?.orchestrator) chat.orchestrator.speakerOrder = orderSel.value;
            this._syncSpeakerOrderHint(orderSel.value);
        });

        // 允许同一成员连续发言
        const consecutiveSwitch = document.getElementById('grp-allow-consecutive');
        consecutiveSwitch?.addEventListener('change', () => {
            const chat = this.editingChat;
            if (chat?.orchestrator) chat.orchestrator.allowConsecutiveSpeakers = consecutiveSwitch.checked;
        });

        // 旁观：无限轮
        const specUnlimited = document.getElementById('grp-spectator-unlimited');
        specUnlimited?.addEventListener('change', () => this._syncSpectatorControls());

        // 旁观：启停按钮
        document.getElementById('grp-spectator-btn')?.addEventListener('click', () => {
            this.onSpectatorToggle();
            this._syncSpectatorButton();
        });

        // 添加成员
        document.getElementById('grp-add-member-btn')?.addEventListener('click', () => this._toggleAddMemberList());

        // 清空聊天记录（危险操作：二次确认后硬删除）
        document.getElementById('grp-clear-messages')?.addEventListener('click', () => this._clearMessages());

        this.modalManager.bindModalOverlayClose(modal, () => this.closeSettingsModal());
    }

    /**
     * 打开群聊设置弹窗（仅群聊会话可调用）
     */
    openSettingsModal(chat = null) {
        this.bindSettingsModal();
        const modal = this.settingsModal;
        if (!modal) return;

        const target = chat || (this.getChats() || []).find(c => c.id == this.getCurrentChatId());
        if (!isGroupChat(target)) return;

        ensureGroupDefaults(target);
        this._editingChat = target;
        this._draftSpace = { ...pick(target.settings, SPACE_LEVEL_KEYS) };
        this._pendingVideoFile = null;
        this._pendingMusicFile = null;

        // ① 群聊信息
        const nameInput = document.getElementById('grp-name');
        if (nameInput) nameInput.value = target.title || '';
        const meta = document.getElementById('grp-meta');
        if (meta) {
            const created = target.date ? new Date(target.date).toLocaleString('zh-CN') : '—';
            meta.textContent = `成员 ${target.members.length} 人 · 创建于 ${created}`;
        }

        // 群聊头像（最顶部）
        this._renderAvatarPreview(this._draftSpace.avatarUrl);

        // ② 群空间
        this._renderSpaceSection();

        // ③ 成员
        this._renderMembersSection();

        // ④ 编排策略
        const p = target.orchestrator;
        const setRange = (id, valId, value, fmt = (v) => String(v)) => {
            const input = document.getElementById(id);
            const label = document.getElementById(valId);
            if (input) input.value = value;
            if (label) label.textContent = fmt(value);
        };
        const maxResp = document.getElementById('grp-max-responders');
        if (maxResp) maxResp.max = String(Math.max(1, target.members.length));
        setRange('grp-max-responders', 'grp-max-responders-val', p.maxResponders);
        setRange('grp-max-total', 'grp-max-total-val', p.maxTotalReplies);
        setRange('grp-relay-rounds', 'grp-relay-rounds-val', p.autoRelayMaxRounds,
            (v) => (Number(v) === 0 ? '关' : String(v)));
        setRange('grp-spectator-rounds', 'grp-spectator-rounds-val',
            p.spectatorRounds < 0 ? 3 : p.spectatorRounds,
            (v) => (document.getElementById('grp-spectator-unlimited')?.checked ? '∞' : String(v)));
        setRange('grp-context-messages', 'grp-context-messages-val', p.contextMessages);

        const orderSel = document.getElementById('grp-speaker-order');
        if (orderSel) orderSel.value = p.speakerOrder;
        this._syncSpeakerOrderHint(p.speakerOrder);

        const setSwitch = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!value;
        };
        setSwitch('grp-spectator-unlimited', p.spectatorRounds < 0);
        setSwitch('grp-allow-consecutive', p.allowConsecutiveSpeakers);
        this._syncSpectatorControls();
        this._syncSpectatorButton();

        // ⑤ 用户画像
        const userNameInput = document.getElementById('grp-user-name');
        const userBioInput = document.getElementById('grp-user-bio');
        if (userNameInput) {
            userNameInput.value = target.settings.userProfileName || '';
            const g = SettingsManager.getUsername();
            userNameInput.placeholder = (g && g !== Constants.DEFAULT_USERNAME)
                ? `留空则使用全局昵称：${g}` : '留空则使用全局昵称';
        }
        if (userBioInput) {
            userBioInput.value = target.settings.userProfileBio || '';
            const gb = SettingsManager.getBio();
            userBioInput.placeholder = gb ? `留空则使用全局简介：${gb}` : '留空则使用全局简介';
        }

        modal.style.display = 'flex';
    }

    closeSettingsModal() {
        const modal = this.settingsModal;
        if (modal) modal.style.display = 'none';
        this._editingChat = null;
        this._draftSpace = null;
        this._pendingVideoFile = null;
        this._pendingMusicFile = null;
    }

    // ---------- 群聊头像 ----------

    /** 渲染群聊头像预览（无头像时退化为群组图标） */
    _renderAvatarPreview(url) {
        const box = document.getElementById('grp-avatar-preview');
        const img = document.getElementById('grp-avatar-img');
        if (!box || !img) return;

        const fallback = box.querySelector('.grp-avatar-fallback');
        if (url) {
            img.src = resolveAssetUrl(url);
            img.style.display = 'block';
            fallback?.remove();
        } else {
            img.removeAttribute('src');
            img.style.display = 'none';
            if (!fallback) {
                const icon = document.createElement('i');
                icon.className = 'fas fa-users grp-avatar-fallback';
                box.appendChild(icon);
            }
        }
    }

    // ---------- ② 群空间 ----------

    _renderSpaceSection() {
        const s = this._draftSpace || {};

        const bgTypeSel = document.getElementById('grp-bg-type');
        if (bgTypeSel) bgTypeSel.value = s.bgType || '';

        const img = document.getElementById('grp-bg-img');
        if (img) img.src = resolveAssetUrl(s.bgImageUrl || Constants.DEFAULT_BG_PREVIEW);

        const videoUrl = document.getElementById('grp-bg-video-url');
        if (videoUrl) videoUrl.value = s.bgVideoUrl || '';
        document.querySelectorAll('input[name="grp-bg-video-mode"]').forEach(r => {
            r.checked = (r.value === (s.bgVideoMode || 'url'));
        });
        const vName = document.getElementById('grp-bg-video-file-name');
        if (vName) vName.textContent = s.bgVideoMode === 'file' ? (s.bgVideoName || '') : '';

        const musicSwitch = document.getElementById('grp-bg-music-switch');
        if (musicSwitch) musicSwitch.checked = !!s.bgMusicEnabled;
        const musicUrl = document.getElementById('grp-bg-music-url');
        if (musicUrl) musicUrl.value = s.bgMusicUrl || '';
        document.querySelectorAll('input[name="grp-bg-music-mode"]').forEach(r => {
            r.checked = (r.value === (s.bgMusicMode || 'url'));
        });
        const mName = document.getElementById('grp-bg-music-file-name');
        if (mName) mName.textContent = s.bgMusicMode === 'file' ? (s.bgMusicName || '') : '';
        const vol = document.getElementById('grp-bg-music-volume');
        if (vol) {
            vol.value = String(Math.round((s.bgMusicVolume ?? 0.5) * 100));
            const label = document.getElementById('grp-bg-music-volume-value');
            if (label) label.textContent = vol.value + '%';
        }

        this._syncBgSections();
        this._syncMusicRows();
    }

    _syncBgSections() {
        const type = document.getElementById('grp-bg-type')?.value || '';
        const imgSec = document.getElementById('grp-bg-image-section');
        const vidSec = document.getElementById('grp-bg-video-section');
        if (imgSec) imgSec.style.display = type === 'image' ? 'block' : 'none';
        if (vidSec) vidSec.style.display = type === 'video' ? 'block' : 'none';
        this._syncBgVideoRows();
    }

    _syncBgVideoRows() {
        const mode = document.querySelector('input[name="grp-bg-video-mode"]:checked')?.value || 'url';
        const urlRow = document.getElementById('grp-bg-video-url-row');
        const fileRow = document.getElementById('grp-bg-video-file-row');
        if (urlRow) urlRow.style.display = mode === 'url' ? 'block' : 'none';
        if (fileRow) fileRow.style.display = mode === 'file' ? 'block' : 'none';
    }

    _syncMusicRows() {
        const enabled = document.getElementById('grp-bg-music-switch')?.checked;
        const controls = document.getElementById('grp-bg-music-controls');
        if (controls) controls.style.display = enabled ? 'block' : 'none';
        const mode = document.querySelector('input[name="grp-bg-music-mode"]:checked')?.value || 'url';
        const urlRow = document.getElementById('grp-bg-music-url-row');
        const fileRow = document.getElementById('grp-bg-music-file-row');
        if (urlRow) urlRow.style.display = mode === 'url' ? 'block' : 'none';
        if (fileRow) fileRow.style.display = mode === 'file' ? 'block' : 'none';
    }

    // ---------- ③ 群成员 ----------

    _renderMembersSection() {
        const chat = this.editingChat;
        const list = document.getElementById('grp-members-list');
        if (!chat || !list) return;

        const allChats = this.getChats() || [];

        list.innerHTML = (chat.members || []).map((m, i) => {
            const settings = resolveMemberSettings(m, allChats) || {};
            const char = {
                name: m.displayName || settings.roleName || `成员${i + 1}`,
                avatarUrl: settings.avatarUrl || settings.avatar || null,
            };
            const badge = m.detached
                ? '<span class="grp-badge detached">已脱钩</span>'
                : '<span class="grp-badge synced">同步中</span>';
            const srcText = m.detached
                ? '来源对话已删除，已转为本地副本'
                : `来源：${escapeHtml(m.sourceTitle || '未知对话')}`;
            const canRemove = (chat.members.length > GROUP_MIN_MEMBERS);

            return `<div class="grp-member-card" style="--m-hue:${MEMBER_HUES[i % MEMBER_HUES.length]}">
                ${this._avatarHtml(char, 34)}
                <span class="grp-member-info">
                    <span class="grp-member-name">${escapeHtml(char.name)} ${badge}</span>
                    <span class="grp-member-src">${srcText}</span>
                </span>
                <button type="button" class="grp-member-remove" data-member-id="${escapeHtml(m.memberId)}"
                        title="${canRemove ? '移出群聊' : `至少保留 ${GROUP_MIN_MEMBERS} 位成员`}"
                        ${canRemove ? '' : 'disabled'}>
                    <i class="fas fa-times"></i>
                </button>
            </div>`;
        }).join('');

        // 移除成员
        list.querySelectorAll('.grp-member-remove').forEach(btn => {
            btn.addEventListener('click', () => this._removeMember(btn.dataset.memberId));
        });

        // 添加成员按钮状态
        const addBtn = document.getElementById('grp-add-member-btn');
        if (addBtn) {
            const full = chat.members.length >= GROUP_MAX_MEMBERS;
            addBtn.disabled = full;
            addBtn.title = full ? `最多 ${GROUP_MAX_MEMBERS} 位成员` : '添加成员';
        }
    }

    async _removeMember(memberId) {
        const chat = this.editingChat;
        if (!chat) return;
        if (chat.members.length <= GROUP_MIN_MEMBERS) {
            this.modalManager.customAlert(`群聊至少需要 ${GROUP_MIN_MEMBERS} 位成员。`, 'warning');
            return;
        }

        const target = chat.members.find(m => m.memberId === memberId);
        const ok = await this.modalManager.showCustomDialog({
            title: '移出成员',
            message: `确定把「${target?.displayName || '该成员'}」移出群聊吗？\n\n（只会移出这个群，不会影响它的来源对话）`,
            buttons: [
                { text: '取消', value: false, className: 'cancel' },
                { text: '移出', value: true, className: 'save' },
            ],
        });
        if (!ok) return;

        chat.members = chat.members.filter(m => m.memberId !== memberId);
        this._dedupeDisplayNames(chat);
        await this.chatRepo.saveChat(chat);
        this._renderMembersSection();
        this._syncResponderCeiling();
        this.renderHistoryList();
        this.renderMessages();
    }

    _toggleAddMemberList() {
        const chat = this.editingChat;
        const list = document.getElementById('grp-add-member-list');
        if (!chat || !list) return;

        if (list.style.display !== 'none') {
            list.style.display = 'none';
            return;
        }

        const existingSourceIds = new Set(chat.members.map(m => m.sourceChatId).filter(Boolean));
        const pool = this.buildCharacterPool()
            .filter(c => !existingSourceIds.has(c.sourceChatId));

        if (!pool.length) {
            this.modalManager.showBriefToast('没有可以加入的角色了');
            return;
        }

        list.innerHTML = pool.map(c => `
            <div class="grp-char" data-key="${escapeHtml(c.key)}">
                ${this._avatarHtml(c, 34)}
                <span class="grp-char-meta">
                    <span class="grp-char-name">${escapeHtml(c.name)}</span>
                    <span class="grp-char-src">${escapeHtml(c.sourceTitle)}</span>
                </span>
                <i class="fas fa-plus grp-char-check"></i>
            </div>`).join('');
        list.style.display = 'grid';

        list.querySelectorAll('.grp-char').forEach(item => {
            item.addEventListener('click', async () => {
                const c = pool.find(x => x.key === item.dataset.key);
                if (!c) return;
                if (chat.members.length >= GROUP_MAX_MEMBERS) {
                    this.modalManager.showBriefToast(`最多 ${GROUP_MAX_MEMBERS} 位成员`);
                    return;
                }
                chat.members.push({
                    memberId: `m_${Date.now().toString(36)}`,
                    displayName: c.name,
                    sourceChatId: c.sourceChatId,
                    sourceTitle: c.sourceTitle,
                    detached: false,
                    snapshot: null,
                    lastResolved: null,
                });
                // 重名去重
                this._dedupeDisplayNames(chat);
                await this.chatRepo.saveChat(chat);
                list.style.display = 'none';
                this._renderMembersSection();
                this._syncResponderCeiling();
                this.renderHistoryList();
                this.modalManager.showBriefToast(`已加入「${c.name}」`);
            });
        });
    }

    /** 重名成员自动追加 (2)、(3)… */
    _dedupeDisplayNames(chat) {
        const used = new Map();
        for (const m of chat.members || []) {
            const base = String(m.displayName || '成员').replace(/\(\d+\)$/, '');
            if (used.has(base)) {
                const n = used.get(base) + 1;
                used.set(base, n);
                m.displayName = `${base}(${n})`;
            } else {
                used.set(base, 1);
                m.displayName = base;
            }
        }
    }

    /**
     * 清空本群聊的全部聊天记录（危险操作）。
     *
     * - **二次确认**：弹窗里明确说明「直接从本地数据库删除、无法撤销」
     * - **硬删除**：直接清空各话题的 messages（不做软删除、不留回收站）
     * - 群成员、人设、群头像与群设置**都会保留**
     */
    async _clearMessages() {
        const chat = this.editingChat;
        if (!chat) return;

        const total = (chat.topics || []).reduce((n, t) => n + ((t.messages || []).length), 0);
        if (total === 0) {
            this.modalManager.showBriefToast('这个群聊还没有聊天记录');
            return;
        }

        const groupTitle = escapeHtml(chat.title || '群聊');
        const confirmed = await this.modalManager.showCustomDialog({
            title: '清空聊天记录',
            isHtml: true,
            message: `确定要清空「<b>${groupTitle}</b>」的<b>全部聊天记录</b>吗？<br><br>`
                + `共 <b>${total}</b> 条消息，将<b>直接从本地数据库删除，无法撤销</b>。<br>`
                + `<span style="opacity:.75;">群成员、人设、群头像与群设置都会保留。</span>`,
            buttons: [
                { text: '取消', value: false, className: 'cancel' },
                { text: '清空并删除', value: true, className: 'save' },
            ],
        });
        if (!confirmed) return;

        try {
            for (const topic of chat.topics || []) {
                topic.messages = [];
                topic.summary = null;
            }
            chat.date = new Date();
            await this.chatRepo.saveChat(chat);

            this.renderHistoryList();
            this.closeSettingsModal();
            await this.renderMessages(chat.id, null);
            this.modalManager.showBriefToast(`🗑️ 已清空 ${total} 条聊天记录`);
        } catch (err) {
            console.error('[GroupUI] 清空聊天记录失败：', err);
            this.modalManager.customAlert('清空失败：' + (err.message || err), 'error');
        }
    }

    _syncResponderCeiling() {
        const chat = this.editingChat;
        if (!chat) return;
        const input = document.getElementById('grp-max-responders');
        const ceiling = Math.max(1, chat.members.length);
        if (input) {
            input.max = String(ceiling);
            if (Number(input.value) > ceiling) {
                input.value = String(ceiling);
                chat.orchestrator.maxResponders = ceiling;
                const label = document.getElementById('grp-max-responders-val');
                if (label) label.textContent = String(ceiling);
            }
        }
    }

    // ---------- ④ 编排策略 ----------

    /** 发言顺序说明文案（随选项变化） */
    _syncSpeakerOrderHint(order) {
        const hint = document.getElementById('grp-speaker-order-hint');
        if (!hint) return;
        if (order === 'rotate') {
            hint.textContent = '轮流发言：按「最久没说话」的顺序轮转，**不调用编排者**——省一次请求、出话更快。@点名 依然有效。';
        } else if (order === 'random') {
            hint.textContent = '随机发言：每轮随机挑人，同样不调用编排者。适合轻松闲聊，也适合预算紧张时使用。@点名 依然有效。';
        } else {
            hint.textContent = '编排者会阅读聊天记录后决定该谁开口；「轮流 / 随机」不调用模型，省一次请求、出话更快。';
        }
    }

    _syncSpectatorControls() {
        const inf = document.getElementById('grp-spectator-unlimited')?.checked;
        const range = document.getElementById('grp-spectator-rounds');
        const label = document.getElementById('grp-spectator-rounds-val');
        const chat = this.editingChat;
        if (range) range.disabled = !!inf;
        if (label) label.textContent = inf ? '∞' : String(range?.value ?? '3');
        if (chat?.orchestrator) {
            chat.orchestrator.spectatorRounds = inf ? -1 : Number(range?.value || 3);
        }
    }

    _syncSpectatorButton() {
        const btn = document.getElementById('grp-spectator-btn');
        if (!btn) return;
        const active = this.isSpectating();
        btn.classList.toggle('active', active);
        btn.innerHTML = active
            ? '<i class="fas fa-stop"></i> 停止旁观'
            : '<i class="fas fa-eye"></i> 开始旁观';
    }

    // ---------- 保存 ----------

    async saveSettings() {
        const chat = this.editingChat;
        if (!chat) { this.closeSettingsModal(); return; }

        try {
            // ① 群聊名称
            const nameInput = document.getElementById('grp-name');
            const newName = (nameInput?.value || '').trim();
            if (newName && newName !== chat.title) chat.title = newName;

            // ② 群空间（含可能需要落盘的文件）
            const s = this._draftSpace || {};
            s.bgType = document.getElementById('grp-bg-type')?.value || null;
            s.bgVideoMode = document.querySelector('input[name="grp-bg-video-mode"]:checked')?.value || 'url';
            s.bgVideoUrl = (document.getElementById('grp-bg-video-url')?.value || '').trim();
            s.bgMusicEnabled = !!document.getElementById('grp-bg-music-switch')?.checked;
            s.bgMusicMode = document.querySelector('input[name="grp-bg-music-mode"]:checked')?.value || 'url';
            s.bgMusicUrl = (document.getElementById('grp-bg-music-url')?.value || '').trim();
            s.bgMusicVolume = Number(document.getElementById('grp-bg-music-volume')?.value ?? 50) / 100;

            // 视频文件 → AssetStore（按 chatId 存取，与主程序一致）
            if (s.bgType === 'video' && s.bgVideoMode === 'file') {
                if (this._pendingVideoFile) {
                    await AssetStore.saveVideo(chat.id, this._pendingVideoFile);
                    s.bgVideoName = this._pendingVideoFile.name;
                } else if (!s.bgVideoName) {
                    s.bgVideoMode = 'url';
                }
            }
            // 音乐文件 → AssetStore
            if (s.bgMusicEnabled && s.bgMusicMode === 'file') {
                if (this._pendingMusicFile) {
                    await AssetStore.saveAudio(chat.id, this._pendingMusicFile);
                    s.bgMusicName = this._pendingMusicFile.name;
                } else if (!s.bgMusicName) {
                    s.bgMusicMode = 'url';
                }
            }

            chat.settings = { ...chat.settings, ...pick(s, SPACE_LEVEL_KEYS) };

            // ④ 编排策略（滑杆/开关的变更已实时写入 chat.orchestrator，这里做一次兜底校验）
            const p = chat.orchestrator;
            p.maxResponders = Math.min(Math.max(1, Number(p.maxResponders) || 1), Math.max(1, chat.members.length));
            p.maxTotalReplies = Math.max(1, Number(p.maxTotalReplies) || 6);
            p.autoRelayMaxRounds = Math.min(3, Math.max(0, Number(p.autoRelayMaxRounds) || 0));

            // ⑤ 用户画像
            chat.settings.userProfileName = (document.getElementById('grp-user-name')?.value || '').trim();
            chat.settings.userProfileBio = (document.getElementById('grp-user-bio')?.value || '').trim();

            await this.chatRepo.saveChat(chat);

            this.renderHistoryList();
            this.applyCurrentChatSettings();   // 背景 / 音乐立即生效
            this.modalManager.showBriefToast('✅ 群聊设置已保存');
            this.closeSettingsModal();

        } catch (err) {
            console.error('[GroupUI] 保存群聊设置失败：', err);
            this.modalManager.customAlert('保存失败：' + (err.message || err), 'error');
        }
    }
}

export default GroupUI;
