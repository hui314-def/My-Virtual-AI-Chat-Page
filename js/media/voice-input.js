// 语音输入模块，封装 Web Speech API 语音识别逻辑。
import Constants from '../core/constants.js';

export class VoiceInput {
    /**
     * @param {Object} deps
     * @param {Function} deps.customAlert — 提示函数 (message, type)
     */
    constructor({ customAlert }) {
        this.customAlert = customAlert;
        /** @type {SpeechRecognition|null} */
        this.recognition = null;
        /** @type {boolean} */
        this.isListening = false;
    }

    /** 防呆看门狗定时器 */
    #stallTimer = null;

    /** 识别启动后超过该时长仍无任何结果/错误/结束事件，判定语音服务不可用并自动停止 */
    static get STALL_TIMEOUT_MS() { return 12000; }

    /** 是否正在监听 */
    isActive() { return this.isListening; }

    /** 停止语音识别 */
    stop() {
        this.#clearStallWatchdog();
        if (this.recognition) {
            this.recognition.stop();
            this.recognition = null;
        }
        this.isListening = false;
        this.#resetButton();
    }

    /** 开始语音输入。处理权限检查、浏览器兼容、识别结果回填。*/
    start() {
        // 安全上下文检查
        if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
            this.customAlert('语音输入需要 HTTPS 环境，请在本地或部署到 HTTPS 站点后使用。\n当前页面协议：' + location.protocol, 'warn');
            return;
        }

        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            this.customAlert('您的浏览器不支持语音识别，请使用 Chrome、Edge 或 Safari 等现代浏览器。', 'warn');
            return;
        }

        // 如果已在监听，再点一次则立即停止（不依赖 onend，避免卡在「聆听中」无法退出）
        if (this.isListening && this.recognition) {
            this.stop();
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
        this.#setButtonListening(true);
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
                    errorMsg = '网络错误，请检查网络连接，并确保页面在 HTTPS 或 localhost 环境下运行。';
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

    // ---- 内部 ----
    /**
     * 启动防呆看门狗：部分浏览器（如 360 安全浏览器）能进入「聆听中」，
     * 但实际无法连接云端语音识别服务，既不给结果也不报错，会一直卡住。
     * 超过 STALL_TIMEOUT_MS 无任何事件则自动停止并提示。
     */
    #armStallWatchdog() {
        this.#clearStallWatchdog();
        this.#stallTimer = setTimeout(() => {
            this.#stallTimer = null;
            if (!this.isListening) return;
            this.stop();
            this.customAlert(
                '长时间未收到语音识别结果：请确认已允许麦克风权限、网络可访问语音识别服务。' +
                '（360 安全浏览器等部分浏览器在国内网络下无法连接该服务）建议改用 Edge 或 Chrome 重试。',
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

    #setButtonListening(active) {
        const voiceBtn = document.getElementById('voice-input-btn');
        if (!voiceBtn) return;
        if (active) {
            voiceBtn.style.background = '#4e6eff';
            voiceBtn.innerHTML = '<i class="fas fa-microphone-slash"></i> 语音输入 (聆听中...)';
        }
    }

    #resetButton() {
        const voiceBtn = document.getElementById('voice-input-btn');
        if (!voiceBtn) return;
        voiceBtn.style.background = '';
        voiceBtn.innerHTML = '<i class="fas fa-microphone"></i> 语音输入';
    }
}

export default VoiceInput;
