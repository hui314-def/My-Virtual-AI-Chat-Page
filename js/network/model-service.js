import Constants from '../core/constants.js';

// 模型服务类，负责与 Ollama / OpenAI 兼容 API 的流式通信
export class ModelService {
    /**
     * @param {Object} config - 模型配置
     * @param {string} config.modelHost - API 地址
     * @param {string} config.apiKey - API Key（OpenAI 兼容需要）
     * @param {string} config.modelName - 模型名称
     */

    // 静态模型列表（所有实例共享）
    static #models = [];
    // 实例属性
    #currentStreamController = null;  // 用于取消当前流式请求
    #isStreaming = false;
    #currentThinkLevel = 0;             // 当前请求的思考深度
    
    constructor(config, initialModels = []) {
        this.config = { ...config };
        if (initialModels.length > 0) {
            ModelService.#models = [...initialModels];
        }
    }
    
    // 外部调用此方法初始化模型列表（例如从 localStorage 加载后设置）
    static setModels(models) {
        ModelService.#models = [...models];
    }

    // ========== Token 用量回调 ==========
    /** @type {Function|null} (promptTokens: number, completionTokens: number) => void */
    static #onUsage = null;

    /** 注册 Token 用量回调 */
    static setUsageCallback(cb) {
        ModelService.#onUsage = cb;
    }

    /** @param {number} promptTokens @param {number} completionTokens */
    static #reportUsage(promptTokens, completionTokens) {
        if (typeof ModelService.#onUsage === 'function') {
            try { ModelService.#onUsage(promptTokens, completionTokens); } catch { /* ignore */ }
        }
    }

    // ========== 模型列表管理 ==========
    static getModels() { return [...this.#models]; }

    static addModel(modelName) {
        if (!modelName || this.#models.includes(modelName)) return false;
        this.#models.push(modelName);
        return true;
    }

    static removeModel(modelName) {
        if (this.#models.length === 1) return false;
        this.#models = this.#models.filter(m => m !== modelName);
        return true;
    }

    // ========== 流式请求管理 ==========
    isStreaming() { return this.#isStreaming; }
    
    abortCurrentStream() {
        if (this.#currentStreamController) {
            this.#currentStreamController.abort();
            this.#currentStreamController = null;
        }
        this.#isStreaming = false;
    }

    async *streamChat(messages, options = {}) {
        // 中断之前的流式请求
        this.abortCurrentStream();

        const controller = new AbortController();
        this.#currentStreamController = controller;
        this.#isStreaming = true;
        this.#currentThinkLevel = options.thinkLevel ?? 0;
        
        try {
            yield* this.#streamChatInternal(messages, options, controller.signal);
        } finally {
            this.#isStreaming = false;
            if (this.#currentStreamController === controller) {
                this.#currentStreamController = null;
            }
        }
    }

    async *#streamChatInternal(messages, options, signal) {
        const url = this.getRequestUrl();
        const headers = this.getHeaders();
        const body = this.buildRequestBody(messages, options);
        
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    // 先检查该行是否包含 Token 用量数据
                    const usage = this.extractUsage(line);
                    if (usage) {
                        ModelService.#reportUsage(usage.promptTokens, usage.completionTokens);
                    }
                    const chunks = this.parseChunk(line);
                    if (chunks) {
                        for (const c of chunks) yield c;
                    }
                }
            }
            if (buffer.trim()) {
                // 最终缓冲行也可能包含用量数据
                const usage = this.extractUsage(buffer);
                if (usage) {
                    ModelService.#reportUsage(usage.promptTokens, usage.completionTokens);
                }
                const chunks = this.parseChunk(buffer);
                if (chunks) {
                    for (const c of chunks) yield c;
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    // 测试连接
    async testConnection() {
        const modelHost = this.config.modelHost;
        if (!modelHost) return { success: false, message: '请先填写主机地址' };
        const isOllama = this.isOllama();
        try {
            if (isOllama) {
                const resp = await fetch(modelHost.replace(/\/$/, '') + '/api/tags');
                if (resp.ok) return { success: true, message: '连接成功 (Ollama)' };
                throw new Error(`状态码 ${resp.status}`);
            } else {
                const headers = this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {};
                const resp = await fetch(modelHost.replace(/\/$/, '') + '/models', { headers });
                if (resp.ok) return { success: true, message: '连接成功 (OpenAI 兼容)' };
                throw new Error(`状态码 ${resp.status}，请检查 API Key`);
            }
        } catch (err) {
            if (isOllama) {
                try {
                    const chatUrl = modelHost.replace(/\/$/, '') + '/api/chat';
                    const resp = await fetch(chatUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: 'test', messages: [], stream: false })
                    });
                    if (resp.ok || resp.status === 400) {
                        return { success: true, message: '连接正常（模型列表不可用）' };
                    }
                } catch(e) {}
            }
            return { success: false, message: `连接失败：${err.message}` };
        }
    }

    // 更新配置（例如全局设置变化时）
    updateConfig(newconfig) {
        Object.assign(this.config, newconfig);
    }

    // 判断当前配置是否为 Ollama 服务
    isOllama() {
        const host = this.config.modelHost || '';
        return host.includes(':11434') || host.includes('/api/chat');
    }

    // 获取请求的 URL
    getRequestUrl() {
        const base = this.config.modelHost.replace(/\/$/, '');
        if (this.isOllama()) return `${base}/api/chat`;
        // 避免重复拼接 /v1（如用户已填入 https://api.deepseek.com/v1）
        if (base.endsWith('/v1')) return `${base}/chat/completions`;
        return `${base}/v1/chat/completions`;
    }

    // 获取请求头
    getHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        if (!this.isOllama() && this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }
        return headers;
    }

    /**
     * 构建请求体
     * @param {Array} messages - 消息列表 [{role, content}]
     * @param {Object} options - 额外参数 { temperature, topP, maxTokens, stream, thinkLevel, images, jsonFormat }
     */
    buildRequestBody(messages, options = {}) {
        const {
            temperature = Constants.DEFAULT_SETTINGS.temperature,
            topP = Constants.DEFAULT_SETTINGS.topP,
            maxTokens = Constants.DEFAULT_SETTINGS.maxTokens,
            stream = true,
            thinkLevel = Constants.DEFAULT_SETTINGS.thinkLevel,
            images = [],
            jsonFormat = false   // true 时要求模型输出结构化 JSON（Ollama → format:'json' / OpenAI 兼容 → response_format）
        } = options;

        // 思考强度映射：0→false, 1→"low", 2→"medium", 3→"high", 4→"max"
        const thinkValue = thinkLevel === 0 ? false
            : ['low', 'medium', 'high', 'max'][thinkLevel - 1];

        // 多模态转换：将图片注入到最后一条用户消息
        const finalMessages = images.length > 0
            ? this.#buildMultimodalMessages(messages, images)
            : messages;

        const baseBody = {
            model: this.config.modelName,
            messages: finalMessages,
            stream: stream,
        };

        if (this.isOllama()) {
            return {
                ...baseBody,
                ...(jsonFormat ? { format: 'json' } : {}),
                // Ollama 的 think 是【顶层字段】，不是 options 采样参数；
                // 放在 options 里会被 Ollama 忽略，导致 think:false 不生效、模型照常输出 thinking
                think: thinkValue,
                options: {
                    temperature,
                    top_p: topP,
                    num_predict: maxTokens,
                }
            };
        } else {
            const body = {
                ...baseBody,
                temperature,
                top_p: topP,
                max_tokens: maxTokens,
                think: thinkValue,
                ...(jsonFormat ? { response_format: { type: 'json_object' } } : {})
            };
            if (stream) {
                body.stream_options = { include_usage: true };
            }
            return body;
        }
    }

    /**
     * 将图片注入消息列表，仅影响最后一条用户消息
     * @param {Array} messages
     * @param {string[]} images - base64 dataURL 数组
     * @returns {Array}
     */
    #buildMultimodalMessages(messages, images) {
        const isOllama = this.isOllama();
        return messages.map((msg, i) => {
            const isLast = i === messages.length - 1;
            if (!isLast || msg.role !== 'user') return msg;

            if (isOllama) {
                // Ollama REST API 期望纯 base64（不含 data:image/...;base64, 前缀）
                const rawImages = images.map(img => {
                    const commaIdx = img.indexOf(',');
                    return commaIdx >= 0 ? img.slice(commaIdx + 1) : img;
                });
                return { ...msg, images: rawImages };
            } else {
                // OpenAI 兼容: content 改为数组 [text, image_url, ...]，保留完整 data URL
                const parts = [{ type: 'text', text: msg.content }];
                for (const img of images) {
                    parts.push({ type: 'image_url', image_url: { url: img } });
                }
                return { ...msg, content: parts };
            }
        });
    }
    
    /**
     * 从 SSE 行中提取 Token 用量数据（不修改 parseChunk 的返回类型）
     * @param {string} line - SSE 原始行
     * @returns {{promptTokens: number, completionTokens: number}|null}
     */
    extractUsage(line) {
        if (!line.trim()) return null;
        try {
            if (this.isOllama()) {
                const data = JSON.parse(line.trim());
                // Ollama 最终 chunk: {"done":true, "eval_count":N, "prompt_eval_count":M}
                if (data.done && (data.eval_count !== undefined || data.prompt_eval_count !== undefined)) {
                    return {
                        promptTokens: data.prompt_eval_count || 0,
                        completionTokens: data.eval_count || 0,
                    };
                }
            } else {
                // OpenAI 兼容格式: data: {"choices":[...], "usage":{...}}
                const text = line.trim();
                if (!text.startsWith('data: ')) return null;
                const jsonStr = text.slice(6);
                if (jsonStr === '[DONE]') return null;
                const data = JSON.parse(jsonStr);
                if (data.usage) {
                    return {
                        promptTokens: data.usage.prompt_tokens || 0,
                        completionTokens: data.usage.completion_tokens || 0,
                    };
                }
            }
        } catch { /* ignore parse errors */ }
        return null;
    }

    /**
     * 解析流式响应的一行数据，返回结构化的文本块列表
     * @param {string} line - 原始行字符串
     * @returns {Array<{type: 'thinking'|'content', text: string}>|null} 解析出的文本块数组，没有则返回 null
     */
    parseChunk(line) {
        if (!line.trim()) return null;

        if (this.isOllama()) {
            // Ollama 格式：{"message":{"content":"...", "thinking":"..."}}
            try {
                const data = JSON.parse(line);
                const content = data.message?.content || '';
                const thinking = data.message?.thinking || '';

                // 思考深度关闭时，完全丢弃 thinking 内容，仅返回回复
                if (this.#currentThinkLevel === 0) {
                    if (thinking) return null;  // 跳过思考阶段的 chunk
                    return content ? [{ type: 'content', text: content }] : null;
                }

                const blocks = [];
                if (thinking) blocks.push({ type: 'thinking', text: thinking });
                if (content) blocks.push({ type: 'content', text: content });
                return blocks.length > 0 ? blocks : null;
            } catch { return null; }
        } else {
            // OpenAI 兼容格式：data: {"choices":[{"delta":{"content":"..."}}]}
            if (!line.startsWith('data: ')) return null;
            const jsonStr = line.slice(6);
            if (jsonStr === '[DONE]') return null;
            try {
                const data = JSON.parse(jsonStr);
                const text = data.choices?.[0]?.delta?.content;
                return text ? [{ type: 'content', text }] : null;
            } catch { return null; }
        }
    }

    /**
     * 非流式生成摘要
     * @param {string} prompt - 提示词
     * @param {Object} options - 选项 { temperature, maxTokens, jsonFormat }
     * @returns {Promise<string>}
     */
    async generateText(prompt, options = {}) {
        const messages = [{ role: 'system', content: prompt }];
        const isStream = false;
        const url = this.getRequestUrl();
        const headers = this.getHeaders();
        const body = this.buildRequestBody(messages, { ...options, stream: isStream });

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        // 提取并上报 Token 用量
        if (this.isOllama()) {
            if (data.eval_count !== undefined || data.prompt_eval_count !== undefined) {
                ModelService.#reportUsage(data.prompt_eval_count || 0, data.eval_count || 0);
            }
            const thinkLevel = options.thinkLevel ?? 0;
            const content = data.message?.content || '';
            const thinking = data.message?.thinking || '';
            // 思考深度关闭时丢弃 thinking，否则包裹 <think> 标签
            if (thinking && thinkLevel > 0) {
                return `<think>${thinking}</think>${content}`;
            }
            // 防御：thinkLevel=0 时本不该有 thinking，若 content 被 thinking 占满截断为空，
            // 直接抛出可读错误，而不是让调用方拿到空串导致 JSON 解析失败
            if (thinkLevel === 0 && !content && thinking) {
                throw new Error('模型仍输出了 thinking 且占满了 token 预算（content 为空）。请改用非推理模型（如 gemma4/gemma2/gpt-oss），或增大 maxTokens');
            }
            return content;
        } else {
            if (data.usage) {
                ModelService.#reportUsage(data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0);
            }
            return data.choices?.[0]?.message?.content || '';
        }
    }
}