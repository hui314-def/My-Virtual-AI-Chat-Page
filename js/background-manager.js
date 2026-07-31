// 背景管理器：按对话设置应用静态背景或视频背景
// 由 applyCurrentChatSettings() 调用，传入当前对话的 settings
import Constants from './constants.js';
import AssetStore from './asset-store.js';

class BackgroundManager {
    static #currentVideoSrc = null;
    static #videoLayer = null;
    static #overlayLayer = null;
    static #currentChatId = null;   // 当前正在显示的视频所属 chatId

    /**
     * 应用背景
     * @param {Object} opts — 当前对话的背景设置
     * @param {string|null} opts.chatId
     * @param {string|null} opts.bgType       — null | 'image' | 'video'
     * @param {string|null} opts.bgImageUrl   — 静态图片 data URI
     * @param {string}      opts.bgVideoUrl   — 视频 URL
     * @param {string}      opts.bgVideoMode  — 'url' | 'file'
     */
    static async apply(opts = {}) {
        const { chatId = null, bgType = null, bgImageUrl = null, bgVideoUrl = '', bgVideoMode = 'url' } = opts;
        const mainChat = document.querySelector('.main-chat');
        if (!mainChat) return;

        // 兼容旧数据：如果 bgImageUrl 为空但 bgUrl 存在，用 bgUrl
        const imageUrl = bgImageUrl || opts.bgUrl || null;

        // 1. 静态图片
        if (bgType === 'image' && imageUrl) {
            this.#removeVideoLayer();
            mainChat.style.backgroundImage = `linear-gradient(0deg, rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0.55)), url(${imageUrl})`;
            mainChat.style.backgroundSize = 'cover';
            mainChat.style.backgroundPosition = 'center';
            return;
        }

        // 2. 视频背景
        if (bgType === 'video') {
            let src = null;

            if (bgVideoMode === 'file' && chatId != null) {
                const blob = await AssetStore.getVideo(chatId);
                if (blob) {
                    if (this.#currentVideoSrc && this.#currentVideoSrc.startsWith('blob:')) {
                        URL.revokeObjectURL(this.#currentVideoSrc);
                    }
                    src = URL.createObjectURL(blob);
                }
            } else if (bgVideoMode === 'url' && (bgVideoUrl || opts.bgUrl)) {
                src = bgVideoUrl || opts.bgUrl;
            }

            if (src) {
                this.#createVideoLayer(src);
                this.#currentChatId = chatId;
                return;
            }
            // 视频源无效 → 降级到默认
        }

        // 3. 默认 SVG 背景
        this.#removeVideoLayer();
        mainChat.style.backgroundImage = Constants.getDefaultChatBackgroundImage();
        mainChat.style.backgroundSize = 'cover';
        mainChat.style.backgroundPosition = 'center';
    }

    static #createVideoLayer(src) {
        const mainChat = document.querySelector('.main-chat');
        if (!mainChat) return;

        mainChat.style.backgroundImage = 'none';
        mainChat.classList.add('has-video-bg');

        if (this.#videoLayer) {
            if (this.#videoLayer.src !== src) {
                this.#videoLayer.src = src;
                this.#videoLayer.load();
            }
            this.#currentVideoSrc = src;
            this.#videoLayer.play().catch(() => {});
            return;
        }

        const video = document.createElement('video');
        video.className = 'bg-video-layer';
        video.src = src;
        video.muted = true;
        video.autoplay = true;
        video.loop = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.onerror = () => {
            this.#removeVideoLayer();
            mainChat.style.backgroundImage = Constants.getDefaultChatBackgroundImage();
            mainChat.style.backgroundSize = 'cover';
            mainChat.style.backgroundPosition = 'center';
        };

        const overlay = document.createElement('div');
        overlay.className = 'bg-video-overlay';

        mainChat.insertBefore(overlay, mainChat.firstChild);
        mainChat.insertBefore(video, mainChat.firstChild);

        this.#videoLayer = video;
        this.#overlayLayer = overlay;
        this.#currentVideoSrc = src;
        video.play().catch(() => {});
    }

    static #removeVideoLayer() {
        const mainChat = document.querySelector('.main-chat');
        if (this.#videoLayer) {
            this.#videoLayer.pause();
            this.#videoLayer.remove();
            this.#videoLayer = null;
        }
        if (this.#overlayLayer) {
            this.#overlayLayer.remove();
            this.#overlayLayer = null;
        }
        if (this.#currentVideoSrc && this.#currentVideoSrc.startsWith('blob:')) {
            URL.revokeObjectURL(this.#currentVideoSrc);
        }
        this.#currentVideoSrc = null;
        this.#currentChatId = null;
        if (mainChat) {
            mainChat.classList.remove('has-video-bg');
        }
    }

    static destroy() {
        this.#removeVideoLayer();
    }
}

export default BackgroundManager;
