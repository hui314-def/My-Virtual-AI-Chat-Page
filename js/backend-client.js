// 后端 HTTP 客户端：封装聊天存储服务（FastAPI :8001）的所有接口。
export class BackendClient {
    /**
     * @param {Object} deps
     * @param {() => string} deps.getBaseUrl 动态获取后端地址（如 http://<host>:8001）
     * @param {() => void} [deps.onUnauthorized] 401 时回调（如清除登录态）
     */
    constructor({ getBaseUrl, onUnauthorized } = {}) {
        this.getBaseUrl = getBaseUrl || (() => '');
        this.onUnauthorized = onUnauthorized || (() => {});
        this.token = '';
    }

    setToken(token) { this.token = token || ''; }
    getToken() { return this.token; }

    /** 统一请求：自动带 Bearer token，解析 JSON，统一抛错。 */
    async #request(method, path, body) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

        let resp;
        try {
            resp = await fetch(this.getBaseUrl() + path, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (e) {
            throw new Error('无法连接后端服务，请确认聊天存储服务已启动');
        }

        let data = null;
        try { data = await resp.json(); } catch { /* 非 JSON 响应 */ }

        if (!resp.ok) {
            if (resp.status === 401) {
                try { this.onUnauthorized(); } catch { /* ignore */ }
            }
            const msg = (data && (data.detail || data.message)) || `请求失败(${resp.status})`;
            throw new Error(msg);
        }
        return data;
    }

    // ===== 鉴权 =====
    register(username, password) {
        return this.#request('POST', '/api/auth/register', { username, password });
    }
    login(username, password) {
        return this.#request('POST', '/api/auth/login', { username, password });
    }
    me() {
        return this.#request('GET', '/api/auth/me');
    }
    changeUsername(username, password) {
        return this.#request('PUT', '/api/auth/username', { username, password });
    }
    changePassword(oldPassword, newPassword) {
        return this.#request('PUT', '/api/auth/password', { old_password: oldPassword, new_password: newPassword });
    }
    deleteAccount(password) {
        return this.#request('DELETE', '/api/auth/account', { password });
    }

    // ===== 聊天记录 =====
    getChats() {
        return this.#request('GET', '/api/chats');
    }
    putChat(chatId, chat) {
        return this.#request('PUT', `/api/chats/${encodeURIComponent(chatId)}`, chat);
    }
    patchChat(chatId, patch) {
        return this.#request('PATCH', `/api/chats/${encodeURIComponent(chatId)}`, patch);
    }
    putChats(chats) {
        return this.#request('PUT', '/api/chats', { chats });
    }
    deleteChat(chatId) {
        return this.#request('DELETE', `/api/chats/${encodeURIComponent(chatId)}`);
    }

    // ===== 设置 =====
    getSettings() {
        return this.#request('GET', '/api/settings');
    }
    putSettings(settings) {
        return this.#request('PUT', '/api/settings', { settings });
    }
}

export default BackendClient;
