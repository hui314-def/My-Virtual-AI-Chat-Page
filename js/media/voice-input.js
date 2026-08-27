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

    /** 是否正在监听 */
    isActive() { return this.isListening; }

    /** 停止语音识别 */
    stop() {
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

        // 如果已在监听，则停止
        if (this.isListening && this.recognition) {
            this.recognition.stop();
            return;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new SpeechRecognition();
        this.recognition.lang = Constants.SPEECH_RECOGNITION_LANG;
        this.recognition.interimResults = true;
        this.recognition.maxAlternatives = 1;
        this.recognition.continuous = false;

        this.recognition.start();
        this.isListening = true;
        this.#setButtonListening(true);

        this.recognition.onresult = (event) => {
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
            this.isListening = false;
            this.#resetButton();
        };

        this.recognition.onerror = (event) => {
            console.error('语音识别错误', event.error);
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
