// 账号管理器：注册 / 登录 / 登出 + token 持久化 + 左上角用户信息渲染 + 登录弹窗绑定。
import { SettingsManager } from './settings-manager.js';
import Constants from './constants.js';

const TOKEN_KEY = 'auth_token';
const USERNAME_KEY = 'auth_username';

export class AuthManager {
    /**
     * @param {Object} deps
     * @param {Object} deps.backendClient
     * @param {() => Object} deps.getModalManager 懒取 modalManager（toast / 关闭动画）
     * @param {() => Promise<void>} deps.onAuthChanged 登录/登出后刷新数据
     */
    constructor({ backendClient, getModalManager, onAuthChanged }) {
        this.backendClient = backendClient;
        this.getModalManager = getModalManager;
        this.onAuthChanged = onAuthChanged;
        this._registerMode = false;
        this._accountActionConfirm = null;
        this._accountSubmitting = false;
    }

    get token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
    get username() { try { return localStorage.getItem(USERNAME_KEY) || ''; } catch { return ''; } }
    isLoggedIn() { return !!this.token; }

    /** 本地缓存命名空间：访客返回 ''，登录后返回账户用户名。 */
    getNamespace() { return this.isLoggedIn() ? this.username : ''; }

    bind() {
        const profile = document.getElementById('user-profile');
        if (profile) profile.addEventListener('click', () => this.openAccountSettings());

        document.getElementById('auth-login-btn')?.addEventListener('click', () => this.handleLogin());
        document.getElementById('auth-register-btn')?.addEventListener('click', () => this.handleRegister());
        document.getElementById('auth-logout-btn')?.addEventListener('click', () => this.handleLogout());
        document.getElementById('auth-avatar-upload')?.addEventListener('click', () => this.handleAvatarUpload());
        document.getElementById('auth-avatar-reuse')?.addEventListener('click', () => this.handleAvatarReuse());
        document.getElementById('auth-rename-btn')?.addEventListener('click', () => this.openRenamePanel());
        document.getElementById('auth-change-password-btn')?.addEventListener('click', () => this.openChangePasswordPanel());
        document.getElementById('auth-delete-account-btn')?.addEventListener('click', () => this.openDeleteAccountPanel());
        document.getElementById('account-action-cancel')?.addEventListener('click', () => this.closeAccountActionPanel());
        document.getElementById('close-account-action')?.addEventListener('click', () => this.closeAccountActionPanel());
        document.getElementById('account-action-confirm')?.addEventListener('click', () => this.#runAccountActionConfirm());
        document.getElementById('auth-password')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.handleLogin();
        });

        const actionModal = document.getElementById('account-action-modal');
        if (actionModal) {
            try { this.getModalManager().bindModalOverlayClose(actionModal, () => this.closeAccountActionPanel()); } catch { /* ignore */ }
        }
    }

    /** 启动时同步恢复 token 到 BackendClient（不校验、不渲染），供早期命名空间判断。 */
    restoreTokenSync() {
        this.backendClient.setToken(this.isLoggedIn() ? this.token : '');
    }

    /** 启动时恢复登录态；token 有效则沿用，失效则清除，后端不可达则保留（离线）。 */
    async init() {
        this.bind();
        if (!this.isLoggedIn()) { this.render(); return; }
        this.backendClient.setToken(this.token);
        try {
            const { username } = await this.backendClient.me();
            try { localStorage.setItem(USERNAME_KEY, username || this.username); } catch { /* ignore */ }
        } catch (e) {
            if (/凭证|401/.test(e.message)) this.clearToken();
        }
        this.render();
    }

    clearToken() {
        try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USERNAME_KEY); } catch { /* ignore */ }
        this.backendClient.setToken('');
    }

    /** 401 时由 BackendClient 回调：清除登录态、切回本地模式（不主动重载数据，避免重入）。 */
    handleUnauthorized() {
        if (!this.isLoggedIn()) return;
        this.clearToken();
        this.render();
        try { this.getModalManager().showBriefToast('登录已过期，已切换到本地模式'); } catch { /* ignore */ }
    }

    render() {
        const nameEl = document.getElementById('profile-name');
        const statusEl = document.getElementById('profile-status');
        const loggedIn = this.isLoggedIn();
        if (nameEl) nameEl.textContent = loggedIn ? this.username : '星尘观测者';
        if (statusEl) {
            statusEl.innerHTML = loggedIn
                ? '<i class="fas fa-circle"></i> 已登录 · 云同步中'
                : '<i class="fas fa-circle"></i> 在线 · AI 共生体';
        }
        this.renderProfileAvatar();
        this.renderAccountTab();
    }

    /** 渲染左上角账号头像：自定义账号头像 > 复用聊天头像 > 默认图标。 */
    renderProfileAvatar() {
        const el = document.getElementById('profile-avatar');
        if (!el) return;
        const src = this.#resolveAvatarSrc();
        el.innerHTML = src
            ? `<img src="${src}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
            : '<i class="fas fa-user-astronaut"></i>';
    }

    #resolveAvatarSrc() {
        const custom = this.getAccountAvatar();
        if (custom) return custom;
        const chatAvatar = SettingsManager.getAvatar();
        return (chatAvatar && chatAvatar.startsWith('data:image')) ? chatAvatar : '';
    }

    /** 自定义账号头像（按账号命名空间存 localStorage，本地优先）。 */
    getAccountAvatar() {
        const ns = this.getNamespace();
        if (!ns) return '';
        try { return localStorage.getItem('auth_avatar_' + ns) || ''; } catch { return ''; }
    }
    setAccountAvatar(dataUrl) {
        const ns = this.getNamespace();
        if (!ns || !dataUrl) return;
        try { localStorage.setItem('auth_avatar_' + ns, dataUrl); } catch { /* ignore */ }
        this.render();
    }
    clearAccountAvatar() {
        const ns = this.getNamespace();
        if (!ns) return;
        try { localStorage.removeItem('auth_avatar_' + ns); } catch { /* ignore */ }
        this.render();
    }

    handleAvatarUpload() {
        if (!this.isLoggedIn()) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            this.getModalManager().showCropModal(file, 1, { maxWidth: 512, mimeType: 'image/jpeg', quality: 0.85 }, (dataUrl) => {
                this.setAccountAvatar(dataUrl);
                this.getModalManager().showBriefToast('✅ 账号头像已更新');
            });
        };
        input.click();
    }

    handleAvatarReuse() {
        if (!this.isLoggedIn()) return;
        this.clearAccountAvatar();  // 清除自定义头像 → 回退为复用聊天头像
        this.getModalManager().showBriefToast('✅ 已复用聊天头像');
    }

    renderAccountTab() {
        const out = document.getElementById('auth-logged-out');
        const inn = document.getElementById('auth-logged-in');
        const cur = document.getElementById('auth-current-user');
        const avatarPreview = document.getElementById('auth-avatar-preview');
        if (this.isLoggedIn()) {
            if (out) out.style.display = 'none';
            if (inn) inn.style.display = 'block';
            if (cur) cur.textContent = '当前账号：' + this.username;
            if (avatarPreview) {
                const src = this.#resolveAvatarSrc();
                avatarPreview.innerHTML = src
                    ? `<img src="${src}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
                    : '<i class="fas fa-user-astronaut"></i>';
            }
        } else {
            if (out) out.style.display = 'block';
            if (inn) inn.style.display = 'none';
        }
    }

    /** 打开「个性化设置 → 账号·云同步」标签页。 */
    async openAccountSettings() {
        this.setError('');
        this.setRegisterMode(false);
        await this.getModalManager().openGlobalSettings();
        document.querySelector('.settings-menu-item[data-tab="account"]')?.click();
        this.renderAccountTab();
    }

    setError(msg) {
        const el = document.getElementById('auth-error');
        if (el) el.textContent = msg || '';
    }

    // ===== 账户操作弹窗（修改用户名 / 修改密码 / 注销账户） =====

    /** 打开账户操作弹窗并填充内容。 */
    openAccountActionPanel({ title, bodyHtml, confirmLabel, onConfirm, confirmClassName = 'save' }) {
        const modal = document.getElementById('account-action-modal');
        const titleEl = document.getElementById('account-action-title');
        const bodyEl = document.getElementById('account-action-body');
        const confirmBtn = document.getElementById('account-action-confirm');
        if (!modal || !titleEl || !bodyEl || !confirmBtn) return;
        titleEl.textContent = title;
        bodyEl.innerHTML = bodyHtml;
        confirmBtn.textContent = confirmLabel;
        confirmBtn.className = 'modal-btn ' + confirmClassName;
        this._accountActionConfirm = onConfirm;
        this._accountSubmitting = false;
        confirmBtn.disabled = false;
        modal.style.display = 'flex';
        const firstInput = bodyEl.querySelector('input');
        if (firstInput) setTimeout(() => firstInput.focus(), 50);
    }

    closeAccountActionPanel() {
        const modal = document.getElementById('account-action-modal');
        if (modal) modal.style.display = 'none';
        this._accountActionConfirm = null;
    }

    setAccountActionError(msg) {
        const el = document.getElementById('account-action-error');
        if (el) el.textContent = msg || '';
    }

    async #runAccountActionConfirm() {
        if (!this._accountActionConfirm || this._accountSubmitting) return;
        this._accountSubmitting = true;
        const confirmBtn = document.getElementById('account-action-confirm');
        if (confirmBtn) confirmBtn.disabled = true;
        try {
            await this._accountActionConfirm();
        } finally {
            this._accountSubmitting = false;
            if (confirmBtn) confirmBtn.disabled = false;
        }
    }

    /** 清除某个账户命名空间下的本地缓存（设置/头像/脏标记）。 */
    #clearLocalNamespace(ns) {
        if (!ns) return;
        try {
            localStorage.removeItem(Constants.STORAGE_KEYS.GLOBAL_SETTINGS + '_' + ns);
            localStorage.removeItem(Constants.STORAGE_KEYS.PROVIDER_SETTINGS + '_' + ns);
            localStorage.removeItem('auth_avatar_' + ns);
            localStorage.removeItem('chat_sync_dirty_' + ns);
        } catch { /* ignore */ }
    }

    openRenamePanel() {
        if (!this.isLoggedIn()) return;
        this.openAccountActionPanel({
            title: '修改用户名',
            bodyHtml: `
                <div class="form-group">
                    <label>新用户名</label>
                    <input type="text" id="account-action-username" placeholder="新的登录用户名" autocomplete="off">
                </div>
                <div class="form-group">
                    <label>当前密码</label>
                    <input type="password" id="account-action-password" placeholder="输入当前密码以确认" autocomplete="current-password">
                </div>
                <div id="account-action-error" style="color:#ff8f8f; font-size:0.85rem; margin-top:8px;"></div>
            `,
            confirmLabel: '确认修改',
            onConfirm: () => this.submitRename(),
        });
    }

    async submitRename() {
        const newName = document.getElementById('account-action-username').value.trim();
        const pwd = document.getElementById('account-action-password').value;
        if (!newName || !pwd) { this.setAccountActionError('请输入新用户名和当前密码'); return; }
        this.setAccountActionError('修改中...');
        try {
            const oldNs = this.username;
            const r = await this.backendClient.changeUsername(newName, pwd);
            // 迁移自定义头像到新命名空间
            try {
                const avatar = localStorage.getItem('auth_avatar_' + oldNs);
                if (avatar) {
                    localStorage.setItem('auth_avatar_' + r.username, avatar);
                    localStorage.removeItem('auth_avatar_' + oldNs);
                }
            } catch { /* ignore */ }
            // 更新本地用户名（命名空间随之切换）
            try { localStorage.setItem(USERNAME_KEY, r.username); } catch { /* ignore */ }
            this.closeAccountActionPanel();
            this.getModalManager().showBriefToast('✅ 用户名已更新，正在同步数据...');
            await this.onAuthChanged();
            // 切换完成后清理旧命名空间本地缓存（云端为主，避免残留）
            this.#clearLocalNamespace(oldNs);
            try { indexedDB.deleteDatabase('ChatAppDB_' + oldNs); } catch { /* ignore */ }
        } catch (e) {
            this.setAccountActionError(e.message);
        }
    }

    openChangePasswordPanel() {
        if (!this.isLoggedIn()) return;
        this.openAccountActionPanel({
            title: '修改密码',
            bodyHtml: `
                <div class="form-group">
                    <label>原密码</label>
                    <input type="password" id="account-action-old-password" placeholder="当前密码" autocomplete="current-password">
                </div>
                <div class="form-group">
                    <label>新密码</label>
                    <input type="password" id="account-action-new-password" placeholder="至少 4 位" autocomplete="new-password">
                </div>
                <div class="form-group">
                    <label>确认新密码</label>
                    <input type="password" id="account-action-new-password2" placeholder="再输入一次新密码" autocomplete="new-password">
                </div>
                <div id="account-action-error" style="color:#ff8f8f; font-size:0.85rem; margin-top:8px;"></div>
            `,
            confirmLabel: '确认修改',
            onConfirm: () => this.submitChangePassword(),
        });
    }

    async submitChangePassword() {
        const oldP = document.getElementById('account-action-old-password').value;
        const newP = document.getElementById('account-action-new-password').value;
        const newP2 = document.getElementById('account-action-new-password2').value;
        if (!oldP || !newP) { this.setAccountActionError('请输入原密码和新密码'); return; }
        if (newP.length < 4) { this.setAccountActionError('新密码至少 4 位'); return; }
        if (newP !== newP2) { this.setAccountActionError('两次输入的新密码不一致'); return; }
        this.setAccountActionError('修改中...');
        try {
            await this.backendClient.changePassword(oldP, newP);
            this.closeAccountActionPanel();
            this.getModalManager().showBriefToast('✅ 密码已更新');
        } catch (e) {
            this.setAccountActionError(e.message);
        }
    }

    openDeleteAccountPanel() {
        if (!this.isLoggedIn()) return;
        this.openAccountActionPanel({
            title: '注销账户',
            bodyHtml: `
                <div style="margin-bottom:12px; padding:10px 12px; background:rgba(180,60,60,0.15); border:1px solid rgba(255,120,120,0.3); border-radius:12px; color:#ffb3b3; font-size:0.85rem;">
                    ⚠️ 注销将永久删除该账户及其云端聊天记录、设置，且不可恢复。
                </div>
                <div class="form-group">
                    <label>当前密码</label>
                    <input type="password" id="account-action-password" placeholder="输入当前密码以确认注销" autocomplete="current-password">
                </div>
                <div id="account-action-error" style="color:#ff8f8f; font-size:0.85rem; margin-top:8px;"></div>
            `,
            confirmLabel: '确认注销',
            confirmClassName: 'danger',
            onConfirm: () => this.submitDeleteAccount(),
        });
    }

    async submitDeleteAccount() {
        const pwd = document.getElementById('account-action-password').value;
        if (!pwd) { this.setAccountActionError('请输入当前密码以确认注销'); return; }
        this.setAccountActionError('注销中...');
        try {
            await this.backendClient.deleteAccount(pwd);
            const ns = this.username;
            this.clearToken();
            this.closeAccountActionPanel();
            this.#clearLocalNamespace(ns);
            this.getModalManager().showBriefToast('🗑️ 账户已注销');
            await this.onAuthChanged();
            // 连接关闭后，尽力删除该账户的本地 IndexedDB 缓存
            try { indexedDB.deleteDatabase('ChatAppDB_' + ns); } catch { /* ignore */ }
        } catch (e) {
            this.setAccountActionError(e.message);
        }
    }

    setRegisterMode(on) {
        this._registerMode = on;
        const cg = document.getElementById('auth-confirm-group');
        const rb = document.getElementById('auth-register-btn');
        if (cg) cg.style.display = on ? 'block' : 'none';
        if (rb) rb.textContent = on ? '确认注册' : '注册';
    }

    async handleLogin() {
        this.setRegisterMode(false);
        const u = document.getElementById('auth-username').value.trim();
        const p = document.getElementById('auth-password').value;
        if (!u || !p) { this.setError('请输入用户名和密码'); return; }
        this.setError('登录中...');
        try {
            const r = await this.backendClient.login(u, p);
            this.applyAuth(r.token, r.username);
            this.getModalManager().showBriefToast('✅ 登录成功，正在同步数据...');
            await this.onAuthChanged();
        } catch (e) {
            this.setError(e.message);
        }
    }

    async handleRegister() {
        if (!this._registerMode) { this.setRegisterMode(true); this.setError('请输入并确认密码'); return; }
        const u = document.getElementById('auth-username').value.trim();
        const p = document.getElementById('auth-password').value;
        const p2 = document.getElementById('auth-password2').value;
        if (!u || !p) { this.setError('请输入用户名和密码'); return; }
        if (p !== p2) { this.setError('两次输入的密码不一致'); return; }
        this.setError('注册中...');
        try {
            const r = await this.backendClient.register(u, p);
            this.applyAuth(r.token, r.username);
            this.getModalManager().showBriefToast('🎉 注册成功，正在同步数据...');
            await this.onAuthChanged();
        } catch (e) {
            this.setError(e.message);
        }
    }

    async handleLogout() {
        this.clearToken();
        this.getModalManager().showBriefToast('已退出登录');
        await this.onAuthChanged();
    }

    applyAuth(token, username) {
        this.backendClient.setToken(token);
        try {
            localStorage.setItem(TOKEN_KEY, token);
            localStorage.setItem(USERNAME_KEY, username || '');
        } catch { /* ignore */ }
        this.render();
    }
}

export default AuthManager;
