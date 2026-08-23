// 角色卡兼容模块:解析 SillyTavern 社区标准角色卡并构建为本项目聊天结构
// 支持:
//   - PNG 角色卡(chara_card_v1/v2/v3,JSON 内嵌在 PNG 的 tEXt/iTXt chunk)
//   - JSON 角色卡(v2/v3 规范、TavernAI 旧格式 char_name...、Pygmalion 格式)
// 纯前端实现,零外部依赖。
import Constants from './constants.js';
import { getCurrentTime, compressImage } from './utils.js';

export class CharacterCard {
    /**
     * 解析角色卡文件(PNG 或 JSON)
     * @param {File} file - 用户选择的文件
     * @returns {Promise<{card: Object, avatarDataUrl: string|null}|null>}
     *          非角色卡文件返回 null
     */
    static async parseCharacterCardFile(file) {
        const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
        if (isPng) {
            return this.#parsePngCard(file);
        }
        const text = await file.text();
        let data;
        try { data = JSON.parse(text); } catch { return null; }
        if (!this.isCharacterCardJSON(data)) return null;
        const card = this.normalizeCard(data);
        // 部分 JSON 卡自带 base64 头像(顶层 avatar 或 data.avatar)
        const rawAvatar = (data && typeof data === 'object') ? (data.avatar || data.data?.avatar || null) : null;
        return { card, avatarDataUrl: (rawAvatar && typeof rawAvatar === 'string' && rawAvatar.startsWith('data:image')) ? rawAvatar : null };
    }

    /** 判断 JSON 数据是否为角色卡(而非本项目导出的对话 JSON) */
    static isCharacterCardJSON(data) {
        if (!data || typeof data !== 'object') return false;
        if (typeof data.spec === 'string' && data.spec.startsWith('chara_card')) return true;
        if (data.data && typeof data.data === 'object' && (data.data.name || data.data.description || data.data.first_mes)) return true;
        // TavernAI 旧格式 / Pygmalion 格式
        if (data.char_name || data.char_persona || data.char_greeting) return true;
        if (data.name && (data.description || data.first_mes || data.personality)) return true;
        return false;
    }

    /** 将各版本角色卡字段统一为项目内标准结构 */
    static normalizeCard(raw) {
        const d = (raw && typeof raw.data === 'object' && raw.data) ? raw.data : raw;
        const parts = [];
        if (d.description) parts.push(d.description);
        if (d.personality) parts.push(`性格：${d.personality}`);
        if (d.scenario || raw.world_scenario) parts.push(`场景：${d.scenario || raw.world_scenario}`);
        return {
            name: d.name || raw.char_name || '导入角色',
            persona: parts.join('\n'),
            greeting: d.first_mes || raw.char_greeting || '',
            exampleMessages: d.mes_example || raw.example_dialogue || '',
            systemPrompt: d.system_prompt || '',
            postHistory: d.post_history_instructions || '',
            alternateGreetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [],
            tags: Array.isArray(d.tags) ? d.tags : [],
            creator: d.creator || raw.creator || '',
            version: d.character_version || raw.character_version || '',
            spec: (raw && typeof raw.spec === 'string') ? raw.spec : (raw?.data ? 'chara_card_v2' : 'legacy')
        };
    }

    /**
     * 用角色卡构建一个项目聊天对象(结构与 chatManager.createNewChat 一致)
     * @param {Object} card - normalizeCard 的输出
     * @param {string|null} avatarDataUrl - 头像 data URL(角色卡图片)
     * @param {Array} currentChats - 当前 chats 数组(用于标题编号)
     * @returns {Object} 新 chat 对象
     */
    static buildChatFromCard(card, avatarDataUrl, currentChats) {
        const settings = JSON.parse(JSON.stringify(Constants.DEFAULT_SETTINGS));
        settings.roleName = card.name;
        settings.persona = card.persona || Constants.DEFAULT_SETTINGS.persona;
        settings.greeting = card.greeting || `✨ 你好，我是${card.name}。`;
        if (avatarDataUrl) settings.avatarUrl = avatarDataUrl;
        // 角色卡专属扩展字段(不参与现有渲染逻辑,供后续 system prompt 注入使用)
        settings.cardExampleMessages = card.exampleMessages || null;
        settings.cardSystemPrompt = card.systemPrompt || null;
        settings.cardMeta = {
            spec: card.spec,
            tags: card.tags,
            creator: card.creator,
            characterVersion: card.version,
            alternateGreetings: card.alternateGreetings,
            postHistory: card.postHistory || null
        };
        const newId = Date.now();
        return {
            id: newId,
            title: `角色·${card.name}`,
            date: new Date(),
            topics: [{
                id: Date.now(),
                name: '话题 1',
                createdAt: new Date().toISOString(),
                summary: null,
                messages: [
                    { type: 'ai', text: settings.greeting, time: getCurrentTime() }
                ]
            }],
            currentTopicIndex: 0,
            settings,
            pinned: false
        };
    }

    // ==================== PNG 角色卡解析 ====================

    static async #parsePngCard(file) {
        const buffer = await file.arrayBuffer();
        const chunks = this.#parsePngTextChunks(buffer);
        let cardJson = null;
        for (const chunk of chunks) {
            const keyword = (chunk.keyword || '').toLowerCase();
            if (keyword !== 'chara' && keyword !== 'ccv3' && keyword !== 'charactercard') continue;
            let text = chunk.text;
            if (text == null && chunk.compressed) text = await this.#inflate(chunk.compressed);
            if (!text) continue;
            cardJson = this.#tryParseCardJson(text);
            if (cardJson) break; // 解析成功
        }
        if (!cardJson) return null;
        const card = this.normalizeCard(cardJson);
        // 角色卡 PNG 本身就是角色头像:过大则压缩(JPEG),否则原样保留(保透明通道)
        const avatarDataUrl = await this.#fileToAvatar(file);
        return { card, avatarDataUrl };
    }

    /**
     * 解析角色卡 JSON 文本。
     * 部分角色卡站点会把 JSON 再做一层 Base64 编码后塞进 PNG chunk,
     * 因此 JSON.parse 失败时尝试 Base64 解码(UTF-8)再解析。
     */
    static #tryParseCardJson(text) {
        try { return JSON.parse(text); } catch { /* 可能为 Base64 编码 */ }
        try {
            const bin = atob(text.replace(/\s+/g, ''));
            const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
            return JSON.parse(new TextDecoder('utf-8').decode(bytes));
        } catch { return null; }
    }

    /** 解析 PNG 的所有 tEXt/iTXt 文本 chunk */
    static #parsePngTextChunks(buffer) {
        const view = new DataView(buffer);
        if (buffer.byteLength < 8) return [];
        const results = [];
        let offset = 8;
        while (offset + 8 <= buffer.byteLength) {
            const length = view.getUint32(offset, false);
            const type = String.fromCharCode(
                view.getUint8(offset + 4), view.getUint8(offset + 5),
                view.getUint8(offset + 6), view.getUint8(offset + 7)
            );
            const dataStart = offset + 8;
            const dataEnd = dataStart + length;
            if (dataEnd + 4 > buffer.byteLength) break; // 数据不完整,停止(防越界)
            if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
                const parsed = this.#parseTextChunk(view, dataStart, dataEnd, type);
                if (parsed) results.push(parsed);
            }
            offset = dataEnd + 4; // 跳过 CRC
        }
        return results;
    }

    /** 解析单个文本 chunk:tEXt 为 keyword\0text;zTXt 为 keyword\0method\0zlib压缩文本; iTXt 为 keyword\0flag\0method\0lang\0translated\0text */
    static #parseTextChunk(view, start, end, type) {
        const sep = this.#findZero(view, start, end);
        if (sep < 0) return null;
        const keyword = this.#bytesToText(view, start, sep);
        if (type === 'tEXt') {
            return { keyword, text: this.#bytesToText(view, sep + 1, end) };
        }
        if (type === 'zTXt') {
            // keyword\0 + compressionMethod(1字节, 0=zlib) + zlib 压缩文本
            if (sep + 1 >= end) return null;
            const bytes = new Uint8Array(view.buffer, view.byteOffset + sep + 2, end - sep - 2);
            return { keyword, text: null, compressed: bytes };
        }
        // iTXt
        if (sep + 3 > end) return null;
        const compressionFlag = view.getUint8(sep + 1);
        const langEnd = this.#findZero(view, sep + 3, end);
        if (langEnd < 0) return null;
        const translatedEnd = this.#findZero(view, langEnd + 1, end);
        if (translatedEnd < 0) return null;
        const bytes = new Uint8Array(view.buffer, view.byteOffset + translatedEnd + 1, end - translatedEnd - 1);
        if (compressionFlag === 0) {
            return { keyword, text: new TextDecoder('utf-8').decode(bytes) };
        }
        return { keyword, text: null, compressed: bytes }; // zlib 压缩,需异步解压
    }

    static #findZero(view, start, end) {
        for (let i = start; i < end; i++) {
            if (view.getUint8(i) === 0) return i;
        }
        return -1;
    }

    static #bytesToText(view, start, end) {
        const bytes = new Uint8Array(view.buffer, view.byteOffset + start, end - start);
        return new TextDecoder('latin1').decode(bytes);
    }

    /** zlib 解压(DecompressionStream,现代浏览器均支持) */
    static async #inflate(bytes) {
        try {
            const ds = new DecompressionStream('deflate');
            const stream = new Blob([bytes]).stream().pipeThrough(ds);
            const buf = await new Response(stream).arrayBuffer();
            return new TextDecoder('utf-8').decode(buf);
        } catch { return null; }
    }

    /** 角色卡 PNG → 头像 data URL:>400KB 时压缩为 JPEG */
    static async #fileToAvatar(file) {
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        if (dataUrl.length > 400 * 1024) {
            try { return await compressImage(file, 512, 0.8); } catch { /* 压缩失败则用原图 */ }
        }
        return dataUrl;
    }
}
