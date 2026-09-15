// 语音输入模块。
// 支持两种识别来源：
//   1) 浏览器内置识别（Web Speech API）：Edge/Chrome 可用；
//      360 安全浏览器等在国内网络下无法连接云端识别服务（只显示聆听但无文字）。
//   2) 本地 SenseVoice 识别：浏览器录音 → 16kHz 单声道 WAV → 上传本地 ASR 服务
//      （backend_code/asr/asr_server.py，本地模型，不受网络/浏览器限制）。
// 三种模式（SettingsManager.voiceInputMode）：
//   'auto'    本地 SenseVoice 优先，连不上自动回退浏览器
//   'local'   仅本地 SenseVoice
//   'browser' 仅浏览器内置识别
import Constants from '../core/constants.js';
import { SettingsManager } from '../core/settings-manager.js';

/** 带超时的 fetch（AbortSignal.timeout 兼容性一般，手动实现） */
async function fetchWithTimeout(url, { method = 'GET', body, headers, timeout = 8000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
        return await fetch(url, { method, body, headers, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 依据设置与地址决定本次用本地 SenseVoice 还是浏览器识别（纯函数，便于测试）。
 * @param {string} mode  'auto' | 'local' | 'browser'
 * @param {string} apiUrl
 * @returns {{kind:'browser'}|{kind:'local', apiUrl:string}|{kind:'local-missing-url'}}
 */
export function pickRecognitionPlan(mode, apiUrl) {
    const url = (apiUrl || '').trim().replace(/\/+$/, '');
    if (mode === 'browser') return { kind: 'browser' };
    if (mode === 'local') return url ? { kind: 'local', apiUrl: url } : { kind: 'local-missing-url' };
    return url ? { kind: 'local', apiUrl: url } : { kind: 'browser' }; // auto
}

/**
 * 把 Float32Array 采样编码为 16bit 单声道 WAV（44 字节头 + PCM），供 SenseVoice 上传。
 * @param {Float32Array} samples  -1.0 ~ 1.0
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWavPcm16(samples, sampleRate) {
    const n = samples.length;
    const buffer = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buffer);
    const writeStr = (off, s) => {
        for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);           // fmt chunk size
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, 1, true);            // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);            // block align
    view.setUint16(34, 16, true);           // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, n * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(off, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
        off += 2;
    }
    return buffer;
}

export class VoiceInput {
    /**
     * @param {Object} deps
     * @param {Function} deps.customAlert — 提示函数 (message, type)
     */
    constructor({ customAlert }) {
        this.customAlert = customAlert;
        /** @type {SpeechRecognition|null} 浏览器内置识别实例 */
        this.recognition = null;
        /** @type {boolean} 正在聆听/录音/识别中 */
        this.isListening = false;
    }

    // ---- 静态参数 ----
    /** 浏览器识别：启动后超过该时长仍无任何结果/错误/结束事件，判定服务不可用并自动停止 */
    static get STALL_TIMEOUT_MS() { return 12000; }
    /** 本地录音：静音持续该时长自动结束录音 */
    static get SILENCE_STOP_MS() { return 1300; }
    /** 本地录音：少于该时长的音频不参与静音判定（避免刚开麦就被静音掐断） */
    static get MIN_AUDIO_MS() { return 400; }
    /** 本地录音：单次最长录音时长，超时自动结束 */
    static get MAX_RECORD_MS() { return 30000; }
    /** 音量阈值（RMS），低于视为静音 */
    static get VAD_THRESHOLD() { return 0.012; }
    /** SenseVoice 服务连接/健康检查超时 */
    static get ASR_CONNECT_TIMEOUT_MS() { return 2500; }
    /** SenseVoice 上传识别超时 */
    static get ASR_UPLOAD_TIMEOUT_MS() { return 60000; }

    // ---- 内部状态 ----
    #stallTimer = null;
    #mediaStream = null;
    #mediaRecorder = null;
    #recordMime = '';
    #recordChunks = [];
    #recordStartTs = 0;
    #isRecording = false;
    #isProcessing = false;
    #vadTimer = null;
    #vadCtx = null;
    #vadAnalyser = null;
    #silenceStart = 0;
    #recognitionApiUrl = '';
    #fallbackNotified = false;

    /** 是否正在监听 */
    isActive() { return this.isListening; }

    /** 停止/结束当前操作：录音中则结束并发送识别；浏览器识别中则停止 */
    stop() {
        this.#clearStallWatchdog();
        if (this.#isProcessing) return;           // 上传识别中，忽略
        if (this.#isRecording) { this.#stopRecording(); return; }  // 点击结束录音 → 立即识别
        if (this.recognition) {
            this.recognition.stop();
            this.recognition = null;
        }
        this.isListening = false;
        this.#resetButton();
    }

    /** 开始语音输入：依据设置选择浏览器识别或本地 SenseVoice */
    start() {
        if (this.#isProcessing) return;           // 上传识别中，忽略点击
        if (this.isListening) { this.stop(); return; }  // 再点一次 = 停止/结束

        if (!this.#isSecureContext()) return;

        const plan = pickRecognitionPlan(SettingsManager.getVoiceInputMode(), SettingsManager.getAsrApiUrl());
        if (plan.kind === 'local-missing-url') {
            this.customAlert('语音输入方式为「仅本地 SenseVoice」，请先在 全局设置 → 语音识别 中填写 SenseVoice 服务地址。', 'warn');
            return;
        }
        if (plan.kind === 'browser') {
            this.#startBrowserRecognition();
            return;
        }
        this.#startLocalRecognition(plan.apiUrl, SettingsManager.getVoiceInputMode());
    }

    // ==================== 浏览器内置识别（Web Speech API） ====================
    #startBrowserRecognition() {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            this.customAlert('您的浏览器不支持语音识别，请使用 Chrome、Edge 或 Safari 等现代浏览器，或在设置中改用本地 SenseVoice。', 'warn');
            return;
        }
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new SpeechRecognition();
        this.recognition.lang = Constants.SPEECH_RECOGNITION_LANG;
        this.recognition.interimResults = true;
        this.recognition.maxAlternatives = 1;
        // continuous = false：说完一句话（停顿）后浏览器自动结束本次识别并输出最终文本
        this.recognition.continuous = false;

        this.recognition.start();
        this.isListening = true;
        this.#setButtonLabel('聆听中…', true);
        this.#armStallWatchdog();

        this.recognition.onresult = (event) => {
            // 有识别结果 = 语音服务正常工作，取消看门狗
            this.#clearStallWatchdog();
            let interimTranscript = '';
            let finalTranscript = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcript;
                } else {
                    interimTranscript += transcript;
                }
            }
            const textarea = document.querySelector('.auto-expand-textarea');
            if (textarea) {
                if (interimTranscript) {
                    textarea.value = interimTranscript;
                    textarea.dispatchEvent(new Event('input'));
                }
                if (finalTranscript) {
                    textarea.value = finalTranscript;
                    textarea.dispatchEvent(new Event('input'));
                }
            }
        };

        this.recognition.onend = () => {
            // 自动停止（说完停顿后）或手动停止都会走到这里
            this.#clearStallWatchdog();
            this.isListening = false;
            this.#resetButton();
        };

        this.recognition.onerror = (event) => {
            console.error('语音识别错误', event.error);
            this.#clearStallWatchdog();
            let errorMsg = '';
            switch (event.error) {
                case 'not-allowed':
                    errorMsg = '请允许麦克风权限以使用语音输入。';
                    break;
                case 'no-speech':
                    errorMsg = '没有检测到语音，请重试。';
                    break;
                case 'audio-capture':
                    errorMsg = '无法获取麦克风，请检查设备连接。';
                    break;
                case 'network':
                    errorMsg = '网络错误，请检查网络连接。建议在设置中改用本地 SenseVoice（不受网络限制）。';
                    break;
                default:
                    errorMsg = `语音识别失败：${event.error}`;
            }
            this.customAlert(errorMsg, 'error');
            this.recognition.stop();
            this.isListening = false;
            this.#resetButton();
        };
    }

    // ==================== 本地 SenseVoice 识别 ====================
    /** 先探测本地服务，再决定录音 or 回退/提示 */
    async #startLocalRecognition(apiUrl, mode) {
        let health;
        try {
            const resp = await fetchWithTimeout(`${apiUrl}/health`, { timeout: VoiceInput.ASR_CONNECT_TIMEOUT_MS });
            health = resp.ok ? await resp.json() : null;
        } catch (err) {
            health = null;
        }
        const ready = !!(health && health.ready);
        if (ready) {
            await this.#beginRecording(apiUrl);
            return;
        }
        // 服务可达但模型未就绪
        if (health) {
            if (mode === 'auto') {
                this.#notifyFallback('本地 SenseVoice 模型仍在加载，已改用浏览器识别');
                this.#startBrowserRecognition();
            } else {
                this.customAlert('SenseVoice 模型仍在加载中，请稍候几秒再试。', 'warn');
            }
            return;
        }
        // 服务不可达
        if (mode === 'auto') {
            this.#notifyFallback(`未连接本地 SenseVoice 服务（${apiUrl}），已改用浏览器识别`);
            this.#startBrowserRecognition();
        } else {
            this.customAlert(`无法连接语音识别服务：${apiUrl}\n请先运行 backend_code/asr/asr_server.py 并检查服务地址。`, 'error');
        }
    }

    /** 请求麦克风并开始录音（静音自动结束 / 再点结束 / 最长 30s） */
    async #beginRecording(apiUrl) {
        this.#recognitionApiUrl = apiUrl;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
        } catch (err) {
            this.customAlert('无法访问麦克风：' + (err && err.message ? err.message : err) + '\n请在浏览器地址栏允许麦克风权限后重试。', 'error');
            return;
        }
        this.#mediaStream = stream;

        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
            .find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) || '';
        this.#recordMime = mime;
        try {
            this.#mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        } catch (err) {
            this.customAlert('当前浏览器不支持音频录制，请使用 Chrome / Edge（或 360 极速模式），或在设置中改用浏览器识别。', 'error');
            this.#clearMedia();
            return;
        }

        this.#recordChunks = [];
        this.#mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) this.#recordChunks.push(e.data);
        };
        this.#mediaRecorder.onstop = () => this.#handleRecordStop();
        this.#mediaRecorder.start(250);   // 定时切片，短录音也能拿到数据
        this.#recordStartTs = performance.now();
        this.#silenceStart = 0;
        this.#isRecording = true;
        this.isListening = true;
        this.#setButtonLabel('录音中，静音自动结束', true);
        this.#setupVad();
    }

    /** 建立音量分析，检测静音自动结束录音 */
    #setupVad() {
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC || !this.#mediaStream) return;
            this.#vadCtx = new AC();
            if (this.#vadCtx.state === 'suspended') this.#vadCtx.resume().catch(() => {});
            const source = this.#vadCtx.createMediaStreamSource(this.#mediaStream);
            this.#vadAnalyser = this.#vadCtx.createAnalyser();
            this.#vadAnalyser.fftSize = 1024;
            source.connect(this.#vadAnalyser);
        } catch (err) {
            // VAD 失败不影响录音，仅失去自动静音结束能力（仍可手动点击结束）
            console.warn('[VoiceInput] VAD 初始化失败', err);
            return;
        }
        this.#vadTimer = setInterval(() => {
            if (!this.#isRecording) return;
            const now = performance.now();
            const elapsed = now - this.#recordStartTs;
            const rms = this.#readRms();
            if (rms >= VoiceInput.VAD_THRESHOLD) {
                this.#silenceStart = 0;               // 正在说话
            } else if (elapsed >= VoiceInput.MIN_AUDIO_MS) {
                if (!this.#silenceStart) this.#silenceStart = now;
                else if (now - this.#silenceStart >= VoiceInput.SILENCE_STOP_MS) {
                    this.#stopRecording();            // 说完话，静音结束
                    return;
                }
            }
            if (elapsed >= VoiceInput.MAX_RECORD_MS) this.#stopRecording();
        }, 120);
    }

    #readRms() {
        if (!this.#vadAnalyser) return 1;  // 无 VAD 时不判静音
        const data = new Float32Array(this.#vadAnalyser.fftSize);
        this.#vadAnalyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        return Math.sqrt(sum / data.length);
    }

    /** 结束录音（触发 onstop → #handleRecordStop） */
    #stopRecording() {
        if (!this.#isRecording || !this.#mediaRecorder) return;
        this.#isRecording = false;
        try { this.#mediaRecorder.stop(); } catch (err) { /* 已停止 */ }
    }

    /** 录音结束：组装音频 → 转 16k WAV → 上传 SenseVoice → 回填输入框 */
    async #handleRecordStop() {
        this.#isRecording = false;
        this.#mediaRecorder = null;
        this.#clearMedia();

        if (this.#recordChunks.length === 0) {
            this.isListening = false;
            this.#resetButton();
            return;
        }
        const blob = new Blob(this.#recordChunks, { type: this.#recordMime || 'audio/webm' });
        this.#recordChunks = [];

        this.#isProcessing = true;
        this.isListening = true;
        this.#setButtonLabel('识别中…', true);
        try {
            const text = await this.#recognizeBlobLocal(blob);
            if (text) {
                this.#fillTextarea(text);
            } else {
                this.customAlert('未识别到有效语音，请重试。', 'warn');
            }
        } catch (err) {
            console.error('[VoiceInput] 本地识别失败', err);
            this.customAlert('语音识别失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
            this.#isProcessing = false;
            this.isListening = false;
            this.#resetButton();
        }
    }

    /** 把录音 blob 转为 16kHz 单声道 WAV 并上传识别 */
    async #recognizeBlobLocal(blob) {
        const wav = await this.#blobTo16kWav(blob);
        const formData = new FormData();
        formData.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
        const resp = await fetchWithTimeout(`${this.#recognitionApiUrl}/asr`, {
            method: 'POST',
            body: formData,
            timeout: VoiceInput.ASR_UPLOAD_TIMEOUT_MS,
        });
        if (!resp.ok) {
            let detail = '';
            try { detail = (await resp.json()).detail || ''; } catch (err) { /* ignore */ }
            throw new Error(`服务返回 HTTP ${resp.status}${detail ? '：' + detail : ''}`);
        }
        const data = await resp.json();
        return (data && typeof data.text === 'string') ? data.text.trim() : '';
    }

    /** 解码任意浏览器录音格式并重采样为 16kHz 单声道 WAV */
    async #blobTo16kWav(blob) {
        const AC = window.AudioContext || window.webkitAudioContext;
        const arrayBuf = await blob.arrayBuffer();
        const decCtx = new AC();
        try {
            const audioBuf = await decCtx.decodeAudioData(arrayBuf);
            const targetRate = 16000;
            const length = Math.max(1, Math.ceil(audioBuf.duration * targetRate));
            const off = new OfflineAudioContext(1, length, targetRate);
            const src = off.createBufferSource();
            src.buffer = audioBuf;
            src.connect(off.destination);
            src.start(0);
            const rendered = await off.startRendering();
            return encodeWavPcm16(rendered.getChannelData(0), targetRate);
        } finally {
            try { decCtx.close(); } catch (err) { /* ignore */ }
        }
    }

    // ==================== 通用 ====================
    /** 浏览器识别回退提示（每次会话只提示一次，避免刷屏） */
    #notifyFallback(msg) {
        if (this.#fallbackNotified) return;
        this.#fallbackNotified = true;
        this.customAlert(msg, 'warn');
    }

    #isSecureContext() {
        if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
            this.customAlert('语音输入需要 HTTPS 环境，请在本地或部署到 HTTPS 站点后使用。\n当前页面协议：' + location.protocol, 'warn');
            return false;
        }
        return true;
    }

    #fillTextarea(text) {
        const textarea = document.querySelector('.auto-expand-textarea');
        if (!textarea) return;
        textarea.value = text;
        textarea.dispatchEvent(new Event('input'));
    }

    #clearMedia() {
        if (this.#vadTimer) { clearInterval(this.#vadTimer); this.#vadTimer = null; }
        this.#vadAnalyser = null;
        if (this.#vadCtx) { try { this.#vadCtx.close(); } catch (err) { /* ignore */ } this.#vadCtx = null; }
        if (this.#mediaStream) {
            this.#mediaStream.getTracks().forEach(t => t.stop());
            this.#mediaStream = null;
        }
    }

    // ---- 浏览器内置识别防呆看门狗 ----
    #armStallWatchdog() {
        this.#clearStallWatchdog();
        this.#stallTimer = setTimeout(() => {
            this.#stallTimer = null;
            if (!this.isListening) return;
            this.stop();
            this.customAlert(
                '长时间未收到语音识别结果：请确认已允许麦克风权限、网络可访问语音识别服务。' +
                '（360 安全浏览器等部分浏览器在国内网络下无法连接该服务）建议在设置中改用本地 SenseVoice，或换 Edge/Chrome。',
                'warn'
            );
        }, VoiceInput.STALL_TIMEOUT_MS);
    }

    #clearStallWatchdog() {
        if (this.#stallTimer) {
            clearTimeout(this.#stallTimer);
            this.#stallTimer = null;
        }
    }

    // ---- 按钮状态 ----
    #setButtonLabel(label, active) {
        const voiceBtn = document.getElementById('voice-input-btn');
        if (!voiceBtn) return;
        voiceBtn.style.background = active ? '#4e6eff' : '';
        voiceBtn.innerHTML = `<i class="fas fa-microphone-slash"></i> 语音输入 (${label})`;
    }

    #resetButton() {
        const voiceBtn = document.getElementById('voice-input-btn');
        if (!voiceBtn) return;
        voiceBtn.style.background = '';
        voiceBtn.innerHTML = '<i class="fas fa-microphone"></i> 语音输入';
    }
}

export default VoiceInput;
