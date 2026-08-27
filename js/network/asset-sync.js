// 图片资源助手：asset:// 引用 ↔ 可访问 URL 解析 + 上传 data URL 到后端文件系统。
import Constants from '../core/constants.js';

let _backendClient = null;

/** 由 script.js 在启动时注入 BackendClient（模块级单例，避免到处传依赖）。 */
export function setAssetBackendClient(client) { _backendClient = client; }

/**
 * 把聊天数据里的图片引用解析成可访问 URL。
 *  - data:/http(s):/blob: 原样返回（旧数据 / 已是完整 URL）
 *  - asset://<id> → http://<host>:8001/api/assets/<id>
 */
export function resolveAssetUrl(value) {
    if (!value || typeof value !== 'string') return value;
    if (value.startsWith('data:') || value.startsWith('http://') || value.startsWith('https://') || value.startsWith('blob:')) {
        return value;
    }
    if (value.startsWith('asset://')) {
        const id = value.slice('asset://'.length);
        let base = '';
        try { base = localStorage.getItem(Constants.STORAGE_KEYS.SYNC_API_URL) || ''; } catch { /* ignore */ }
        if (!base) base = `http://${location.hostname}:8001`;
        return `${base}/api/assets/${id}`;
    }
    return value;
}

/**
 * 上传一张 data URL 到后端，返回 asset://<id>；未登录或失败时回退为原 dataUrl。
 * @param {string} dataUrl
 * @returns {Promise<string>}
 */
export async function uploadDataUrl(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return dataUrl;
    if (!_backendClient || !_backendClient.getToken()) return dataUrl;  // 访客/未登录：保留本地 base64
    try {
        const r = await _backendClient.uploadAsset(dataUrl);
        if (r && r.assetId) return 'asset://' + r.assetId;
    } catch { /* 后端不可达：保留 base64 本地兜底 */ }
    return dataUrl;
}

/**
 * 上传原始文件（视频/音频等大文件，二进制直传）到后端。
 * @param {File|Blob} file
 * @returns {Promise<string|null>} asset://<id>；未登录或失败返回 null（调用方回退本地存储）
 */
export async function uploadFile(file) {
    if (!file || !_backendClient || !_backendClient.getToken()) return null;
    try {
        const r = await _backendClient.uploadAssetRaw(file);
        if (r && r.assetId) return 'asset://' + r.assetId;
    } catch { /* 忽略 */ }
    return null;
}

/**
 * 把各种形态的图片引用统一成 asset://（无法识别的原样返回）。
 *  - data: → 上传并返回 asset://
 *  - http(s)://.../api/assets/<id> → 提取为 asset://<id>
 *  - asset:// → 原样
 */
export async function normalizeImageRef(value) {
    if (!value || typeof value !== 'string') return value;
    if (value.startsWith('asset://')) return value;
    if (value.startsWith('data:')) return uploadDataUrl(value);
    const idx = value.lastIndexOf('/api/assets/');
    if (idx !== -1) return 'asset://' + value.slice(idx + '/api/assets/'.length);
    return value;
}

/**
 * 把 asset:// 引用解析成真正的 data URL（供需要字节的模型 API 使用）。
 * data:/http(s) 直接返回；asset:// 通过 fetch + FileReader 转回 data URL。
 */
export async function resolveToDataUrl(value) {
    if (!value || typeof value !== 'string') return value;
    if (value.startsWith('data:')) return value;
    if (value.startsWith('asset://')) {
        const url = resolveAssetUrl(value);
        try {
            const resp = await fetch(url);
            if (!resp.ok) return value;
            const blob = await resp.blob();
            return await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result);
                fr.onerror = () => reject(fr.error);
                fr.readAsDataURL(blob);
            });
        } catch { return value; }
    }
    return value;
}
