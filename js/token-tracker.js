// Token 用量追踪器，负责累积统计和 localStorage 持久化。
// 与 SettingsManager 分离，使用独立的 storage key 避免被设置保存覆盖。
const STORAGE_KEY = 'token_usage_stats';

const DEFAULTS = Object.freeze({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    apiCalls: 0,
});

export class TokenTracker {
    // 本次会话 Token 数（仅内存，不持久化）
    static #sessionTokens = 0;

    /** 从 localStorage 读取累积数据 */
    static _read() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch (err) {
            console.warn('[TokenTracker] 读取失败：', err);
            return {};
        }
    }

    /** 写入累积数据到 localStorage */
    static _write(stats) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
            return true;
        } catch (err) {
            console.error('[TokenTracker] 写入失败：', err);
            return false;
        }
    }

    /** 获取累计统计（合并默认值） */
    static getStats() {
        return { ...DEFAULTS, ...this._read() };
    }

    /** 获取本次会话 Token 用量 */
    static getSessionTokens() {
        return this.#sessionTokens;
    }

    /**
     * 记录一次 API 调用的 Token 用量
     * @param {number} promptTokens - Prompt token 数量
     * @param {number} completionTokens - Completion token 数量
     */
    static record(promptTokens, completionTokens) {
        const stats = this._read();
        stats.promptTokens = (stats.promptTokens || 0) + promptTokens;
        stats.completionTokens = (stats.completionTokens || 0) + completionTokens;
        stats.totalTokens = (stats.totalTokens || 0) + promptTokens + completionTokens;
        stats.apiCalls = (stats.apiCalls || 0) + 1;
        this.#sessionTokens += promptTokens + completionTokens;
        this._write(stats);
    }

    /** 重置所有累计统计 */
    static reset() {
        try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
        this.#sessionTokens = 0;
    }
}

export default TokenTracker;
