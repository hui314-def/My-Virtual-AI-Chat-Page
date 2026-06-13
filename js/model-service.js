import Constants from './constants.js';

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
    
    constructor(config) {
        this.config = { ...config };
        ModelService.#loadModelsFromStorage();
    }

    // ========== 模型列表管理 ==========
    static getModels() { return [...this.#models]; }

    static addModel(modelName) {
        if (!modelName || this.#models.includes(modelName)) return false;
        this.#models.push(modelName);
        this.#saveModelsToStorage();
        return true;
    }
    
    static removeModel(modelName) {
        if (this.#models.length === 1) return false;
        this.#models = this.#models.filter(m => m !== modelName);
        this.#saveModelsToStorage();
        return true;
    }
    
    static #loadModelsFromStorage() {
        const stored = localStorage.getItem('model_list');
        if (stored) {
            this.#models = JSON.parse(stored);
        } else {
            const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
            this.#models = [globalSettings.modelName || Constants.DEFAULT_MODEL_NAME];
            this.#saveModelsToStorage();
        }
    }
    
    static #saveModelsToStorage() {
        localStorage.setItem('model_list', JSON.stringify(this.#models));
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
                    const chunk = this.parseChunk(line);
                    if (chunk) yield chunk;
                }
            }
            if (buffer.trim()) {
                const chunk = this.parseChunk(buffer);
                if (chunk) yield chunk;
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
                const resp = await fetch(modelHost.replace(/\/$/, '') + '/v1/models', { headers });
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
     * @param {Object} options - 额外参数 { temperature, topP, maxTokens, stream }
     */
    buildRequestBody(messages, options = {}) {
        const {
            temperature = 0.7,
            topP = 0.9,
            maxTokens = 500,
            stream = true
        } = options;

        const baseBody = {
            model: this.config.modelName,
            messages: messages,
            stream: stream,
        };

        if (this.isOllama()) {
            return {
                ...baseBody,
                options: {
                    temperature,
                    top_p: topP,
                    num_predict: maxTokens
                }
            };
        } else {
            return {
                ...baseBody,
                temperature,
                top_p: topP,
                max_tokens: maxTokens
            };
        }
    }

    /**
     * 解析流式响应的一行数据，返回文本块
     * @param {string} line - 原始行字符串
     * @returns {string|null} 解析出的文本块，如果没有则返回 null
     */
    parseChunk(line) {
        if (!line.trim()) return null;
        
        if (this.isOllama()) {
            // Ollama 格式：{"message":{"content":"..."}}
            try {
                const data = JSON.parse(line);
                return data.message?.content || null;
            } catch { return null; }
        } else {
            // OpenAI 兼容格式：data: {"choices":[{"delta":{"content":"..."}}]}
            if (!line.startsWith('data: ')) return null;
            const jsonStr = line.slice(6);
            if (jsonStr === '[DONE]') return null;
            try {
                const data = JSON.parse(jsonStr);
                return data.choices?.[0]?.delta?.content || null;
            } catch { return null; }
        }
    }

    /**
     * 非流式生成摘要（用于话题简介等）
     * @param {string} prompt - 提示词
     * @param {Object} options - 选项 { temperature, maxTokens }
     * @returns {Promise<string>}
     */
    async generateText(prompt, options = {}) {
        const messages = [{ role: 'user', content: prompt }];
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
        if (this.isOllama()) {
            return data.message?.content || '';
        } else {
            return data.choices?.[0]?.message?.content || '';
        }
    }
}