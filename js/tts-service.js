import Constants from './constants.js';

/**
 * 语音合成服务
 * 支持通过后端 API 生成语音，降级使用浏览器内置 TTS
 */
export class TTsService {
    /** @type {AbortController|null} 当前 TTS 请求的控制器 */
    #currentController = null;
    /** @type {HTMLAudioElement|null} 当前播放的音频对象 */
    #currentAudio = null;
    /** @type {SpeechSynthesisUtterance|null} 当前朗读的 utterance */
    #currentUtterance = null;
    /** @type {boolean} 是否正在播放/合成中 */
    #isSpeaking = false;
    /** @type {HTMLElement|null} 最后被禁用的播放按钮 */
    #lastDisabledPlayBtn = null;
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
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
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
     * 更新“可用音色列表”显示区域（span元素）
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
        // 停止音频播放
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
     * 播放语音（优先使用后端 API，失败时降级浏览器语音）
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
            // 尝试使用后端 API
            await this.#speakWithBackend(text, voiceId);
        } catch (err) {
            if (err.name === 'AbortError') {
                console.log('TTS 请求被取消');
            } else {
                console.error('后端 TTS 失败，降级到浏览器语音', err);
                if (this.onFallback) {
                    this.onFallback('语音合成服务连接失败，已切换至浏览器默认语音');
                }
                this.#fallbackSpeak(text);
            }
        } finally {
            this.#isSpeaking = false;
            this.#restoreLastDisabledButton();
        }
    }

    // 调用后端 TTS API 生成并播放音频
    async #speakWithBackend(text, voice) {
        const controller = new AbortController();
        this.#currentController = controller;

        // 获取配置
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        const ttsApiUrl = globalSettings.ttsApiUrl || Constants.DEFAULT_TTS_API_URL;
        const ttsApiKey = globalSettings.ttsApiKey || '';

        const headers = { 'Content-Type': 'application/json' };
        if (ttsApiKey) headers['X-API-Key'] = ttsApiKey;

        const response = await fetch(`${ttsApiUrl}/tts`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ text, voice }),
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