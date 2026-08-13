import Constants from './constants.js';

/**
 * 语音合成服务
 * 支持 SSE 流式播放（边生成边播）、后端完整 WAV API，降级使用浏览器内置 TTS
 */
export class TTsService {
    /** @type {AbortController|null} 当前 TTS 请求的控制器 */
    #currentController = null;
    /** @type {HTMLAudioElement|null} 当前播放的音频对象（非流式模式） */
    #currentAudio = null;
    /** @type {SpeechSynthesisUtterance|null} 当前朗读的 utterance */
    #currentUtterance = null;
    /** @type {boolean} 是否正在播放/合成中 */
    #isSpeaking = false;
    /** @type {HTMLElement|null} 最后被禁用的播放按钮 */
    #lastDisabledPlayBtn = null;
    /** @type {AudioContext|null} 流式播放的 AudioContext */
    #audioCtx = null;
    /** @type {AudioBufferSourceNode[]} 已调度的流式音频源节点 */
    #scheduledSources = [];
    /** @type {number} 流式播放最后一个 buffer 的结束时间 */
    #streamEndTime = 0;
    static #voiceCache = null;// 静态私有音色缓存
    onFallback = null; // 降级回调
    /**
     * 设置降级回调（由外部注入，用于显示提示）
     * @param {Function} callback - (message: string) => void
     */
    setOnFallback(callback) {
        this.onFallback = callback;
    }

    /**
     * 获取音色列表（自动缓存）
     * @param {boolean} forceRefresh - 是否强制刷新缓存，默认 false
     * @returns {Promise<string[]>}
     */
    static async getVoices(forceRefresh = false) {
        if (this.#voiceCache && !forceRefresh) return this.#voiceCache;
        const globalSettings = JSON.parse(localStorage.getItem(Constants.STORAGE_KEYS.GLOBAL_SETTINGS)) || {};
        const apiUrl = globalSettings.ttsApiUrl || Constants.DEFAULT_TTS_API_URL;
        try {
            const response = await fetch(`${apiUrl}/voices`);
            if (!response.ok) throw new Error();
            const data = await response.json();
            this.#voiceCache = data.voices || [];
            return this.#voiceCache;
        } catch (err) {
            console.warn('获取音色列表失败', err);
            return [];
        }
    }

    /**
     * 填充音色下拉框
     * @param {HTMLSelectElement} selectElement - 要填充的下拉框元素
     * @param {string|null} currentVoice - 当前应选中的音色（可选）
     * @param {boolean} forceRefresh - 是否强制刷新缓存
     * @returns {Promise<void>}
     */
    static async populateVoiceSelect(selectElement, currentVoice = null, forceRefresh = false) {
        const voices = await this.getVoices(forceRefresh);
        selectElement.innerHTML = '';
        if (voices.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '无可用音色，请先克隆';
            selectElement.appendChild(option);
        } else {
            voices.forEach(voice => {
                const option = document.createElement('option');
                option.value = voice;
                option.textContent = voice;
                selectElement.appendChild(option);
            });
        }
        if (currentVoice && voices.includes(currentVoice)) {
            selectElement.value = currentVoice;
        } else if (voices.length > 0) {
            selectElement.value = voices[0];
        }
    }

    /**
     * 更新"可用音色列表"显示区域（span元素）
     * @param {HTMLElement} displaySpan - 用于显示音色列表的 span 元素
     * @param {boolean} forceRefresh - 是否强制刷新缓存
     * @returns {Promise<void>}
     */
    static async updateVoiceDisplay(displaySpan, forceRefresh = false) {
        const voices = await this.getVoices(forceRefresh);
        if (voices.length === 0) {
            displaySpan.innerText = '无可用音色';
        } else {
            displaySpan.innerHTML = voices.join(', ');
        }
    }

    // 清空音色缓存（音色克隆成功后调用）
    static clearVoiceCache() { this.#voiceCache = null; }

    // 是否正在播放
    isSpeaking() { return this.#isSpeaking; }

    // 停止当前播放/合成
    stop() {
        // 取消网络请求
        if (this.#currentController) {
            this.#currentController.abort();
            this.#currentController = null;
        }
        // 停止流式 AudioContext
        this.#stopStreamingAudio();
        // 停止音频播放（非流式）
        if (this.#currentAudio) {
            this.#currentAudio.pause();
            this.#currentAudio.currentTime = 0;
            this.#currentAudio = null;
        }
        // 停止浏览器语音合成
        if (this.#currentUtterance) {
            window.speechSynthesis.cancel();
            this.#currentUtterance = null;
        }
        this.#isSpeaking = false;
        // 恢复被禁用的按钮（如果有）
        this.#restoreLastDisabledButton();
    }

    /** 停止流式 AudioContext 及已调度音源 */
    #stopStreamingAudio() {
        // 停止所有已调度的 AudioBufferSourceNode
        for (const src of this.#scheduledSources) {
            try { src.stop(); } catch (_) { /* 可能已结束 */ }
        }
        this.#scheduledSources = [];
        // 关闭 AudioContext
        if (this.#audioCtx && this.#audioCtx.state !== 'closed') {
            this.#audioCtx.close().catch(() => {});
        }
        this.#audioCtx = null;
        this.#streamEndTime = 0;
    }

    // 恢复之前禁用的播放按钮
    #restoreLastDisabledButton() {
        if (this.#lastDisabledPlayBtn) {
            this.#lastDisabledPlayBtn.disabled = false;
            this.#lastDisabledPlayBtn.style.opacity = '1';
            this.#lastDisabledPlayBtn.style.cursor = 'pointer';
            this.#lastDisabledPlayBtn = null;
        }
    }

    /**
     * 禁用播放按钮（防连点）
     * @param {HTMLElement|null} playButton
     */
    #disablePlayButton(playButton) {
        if (!playButton) return;
        // 先恢复之前可能遗留的按钮
        this.#restoreLastDisabledButton();
        playButton.disabled = true;
        playButton.style.opacity = '0.5';
        playButton.style.cursor = 'not-allowed';
        this.#lastDisabledPlayBtn = playButton;
    }

    /**
     * 播放语音（优先 SSE 流式 → 降级完整 WAV → 降级浏览器语音）
     * @param {string} text 要朗读的文本
     * @param {string} voiceId 音色名称（后端 API 使用）
     * @param {HTMLElement} [playButtonElement] 关联的播放按钮元素，播放期间禁用，结束后恢复
     * @returns {Promise<void>}
     */
    async speak(text, voiceId, playButtonElement = null) {
        if (!text || text.trim() === '') return;
        // 停止当前正在播放的
        this.stop();
        // 更新状态
        this.#isSpeaking = true;
        this.#disablePlayButton(playButtonElement);

        try {
            // 1. 优先尝试 SSE 流式播放（边生成边播，首帧延迟最低）
            await this.#speakStreaming(text, voiceId);
        } catch (err) {
            if (err.name === 'AbortError') {
                console.log('TTS 流式请求被取消');
            } else {
                console.warn('SSE 流式 TTS 失败，尝试完整 WAV 模式', err);
                try {
                    // 2. 降级：完整 WAV 模式
                    await this.#speakWithBackend(text, voiceId);
                } catch (err2) {
                    if (err2.name === 'AbortError') {
                        console.log('TTS 请求被取消');
                    } else {
                        console.error('后端 TTS 全部失败，降级到浏览器语音', err2);
                        if (this.onFallback) {
                            this.onFallback('语音合成服务连接失败，已切换至浏览器默认语音');
                        }
                        // 3. 最终降级：浏览器内置语音
                        this.#fallbackSpeak(text);
                    }
                }
            }
        } finally {
            this.#isSpeaking = false;
            this.#restoreLastDisabledButton();
        }
    }

    /**
     * SSE 流式播放——边接收 PCM 边用 Web Audio API 播放
     * 首块 PCM 到达即开始播放，无需等待完整音频生成。
     */
    async #speakStreaming(text, voiceId) {
        const controller = new AbortController();
        this.#currentController = controller;

        // 获取配置
        const globalSettings = JSON.parse(localStorage.getItem(Constants.STORAGE_KEYS.GLOBAL_SETTINGS)) || {};
        const ttsApiUrl = globalSettings.ttsApiUrl || Constants.DEFAULT_TTS_API_URL;
        const ttsApiKey = globalSettings.ttsApiKey || '';

        const headers = { 'Content-Type': 'application/json' };
        if (ttsApiKey) headers['X-API-Key'] = ttsApiKey;

        const response = await fetch(`${ttsApiUrl}/tts/stream`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ text, voiceId: voiceId }),
            signal: controller.signal,
        });

        // 缓存命中 → 后端返回完整 WAV（非流式），用 <audio> 播放
        const contentType = response.headers.get('Content-Type') || '';
        if (contentType.includes('audio/')) {
            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            this.#currentAudio = audio;
            audio.play();
            await new Promise((resolve, reject) => {
                audio.onended = () => { URL.revokeObjectURL(audioUrl); this.#currentAudio = null; resolve(); };
                audio.onerror = (e) => { URL.revokeObjectURL(audioUrl); reject(e); };
            });
            return;
        }

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        // ── SSE 流式处理 ──────────────────────────────────────────────
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';           // 行缓冲区（处理跨 chunk 的不完整行）
        let started = false;
        let sampleRate = 48000;
        let channels = 1;
        let nextStartTime = 0;
        const pendingFinish = [];  // 等待完成的 Promise 列表

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                // 最后一行可能不完整，保留到下次
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    let event;
                    try {
                        event = JSON.parse(line.slice(6));
                    } catch (_) {
                        continue; // 解析失败的行静默跳过
                    }

                    switch (event.type) {
                        case 'start': {
                            sampleRate = event.sampleRate || 48000;
                            channels = event.channels || 1;
                            // 创建 AudioContext
                            try {
                                this.#audioCtx = new AudioContext({ sampleRate });
                            } catch (_) {
                                this.#audioCtx = new AudioContext(); // 降级：默认采样率
                            }
                            nextStartTime = this.#audioCtx.currentTime;
                            this.#streamEndTime = nextStartTime;
                            started = true;
                            break;
                        }

                        case 'audio': {
                            if (!started || !this.#audioCtx) break;

                            const pcmChunk = this.#base64ToInt16(event.data);
                            if (!pcmChunk || pcmChunk.length === 0) break;

                            const float32 = this.#int16ToFloat32(pcmChunk);
                            const audioBuffer = this.#audioCtx.createBuffer(1, float32.length, sampleRate);
                            audioBuffer.getChannelData(0).set(float32);

                            const source = this.#audioCtx.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(this.#audioCtx.destination);

                            const startTime = Math.max(nextStartTime, this.#audioCtx.currentTime);
                            source.start(startTime);
                            this.#scheduledSources.push(source);

                            nextStartTime = startTime + audioBuffer.duration;
                            this.#streamEndTime = nextStartTime;

                            // 在 source 结束时清理引用
                            const srcRef = source;
                            const idx = this.#scheduledSources.indexOf(srcRef);
                            source.onended = () => {
                                const i = this.#scheduledSources.indexOf(srcRef);
                                if (i >= 0) this.#scheduledSources.splice(i, 1);
                            };
                            break;
                        }

                        case 'done': {
                            // 等待最后一个 buffer 播完
                            if (this.#audioCtx && this.#audioCtx.state !== 'closed') {
                                const waitMs = Math.max(0, (nextStartTime - this.#audioCtx.currentTime) * 1000) + 300;
                                await new Promise(r => setTimeout(r, waitMs));
                            }
                            break;
                        }

                        case 'error': {
                            throw new Error(event.message || '流式 TTS 服务端错误');
                        }
                    }
                }
            }
        } finally {
            // 流结束，等待最后的音频播完再清理
            if (this.#audioCtx && this.#audioCtx.state !== 'closed') {
                const waitMs = Math.max(0, (this.#streamEndTime - this.#audioCtx.currentTime) * 1000) + 200;
                await new Promise(r => setTimeout(r, waitMs));
            }
            this.#stopStreamingAudio();
        }
    }

    /**
     * Base64 字符串 → Int16Array（小端序 PCM 采样）
     */
    #base64ToInt16(base64Str) {
        try {
            const binaryStr = atob(base64Str);
            const len = binaryStr.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
            }
            return new Int16Array(bytes.buffer);
        } catch (_) {
            return null;
        }
    }

    /**
     * Int16Array → Float32Array（归一化到 [-1, 1]）
     */
    #int16ToFloat32(int16) {
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768;
        }
        return float32;
    }

    // ── 非流式后备：调用后端 TTS API 生成完整 WAV 并播放 ────────────────
    async #speakWithBackend(text, voiceId) {
        const controller = new AbortController();
        this.#currentController = controller;

        // 获取配置
        const globalSettings = JSON.parse(localStorage.getItem(Constants.STORAGE_KEYS.GLOBAL_SETTINGS)) || {};
        const ttsApiUrl = globalSettings.ttsApiUrl || Constants.DEFAULT_TTS_API_URL;
        const ttsApiKey = globalSettings.ttsApiKey || '';

        const headers = { 'Content-Type': 'application/json' };
        if (ttsApiKey) headers['X-API-Key'] = ttsApiKey;

        const response = await fetch(`${ttsApiUrl}/tts`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ text, voiceId: voiceId }),
            signal: controller.signal,
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        this.#currentAudio = audio;

        audio.play();
        await new Promise((resolve, reject) => {
            audio.onended = () => {
                URL.revokeObjectURL(audioUrl);
                this.#currentAudio = null;
                resolve();
            };
            audio.onerror = (e) => {
                URL.revokeObjectURL(audioUrl);
                reject(e);
            };
        });
    }

    /**
     * 设置降级回调（由外部注入，用于显示提示）
     * @param {Function} callback - (message: string) => void
     */
    setOnFallback(callback) {
        this.onFallback = callback;
    }

    // 降级：使用浏览器内置语音合成
    #fallbackSpeak(text) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = Constants.SPEECH_RECOGNITION_LANG;
        this.#currentUtterance = utterance;
        window.speechSynthesis.speak(utterance);
        utterance.onend = () => {
            this.#currentUtterance = null;
        };
        utterance.onerror = () => {
            this.#currentUtterance = null;
        };
    }
}