// 背景音乐管理器：按对话设置播放背景音乐（URL 或本地文件）
// 由 applyCurrentChatSettings() 调用，传入当前对话的 settings
import AssetStore from './asset-store.js';
import { resolveAssetUrl } from './asset-sync.js';

class BgMusicManager {
    static #audio = null;           // HTMLAudioElement
    static #currentSrc = null;      // 当前播放的音频 src（用于 blob URL 回收）
    static #currentChatId = null;   // 当前播放音乐所属 chatId
    static #playerBar = null;       // 浮动播放器 DOM
    static #volume = 0.5;           // 当前音量
    // 拖动状态
    static #dragging = false;
    static #dragStartX = 0;
    static #dragStartY = 0;
    static #barStartLeft = 0;
    static #barStartTop = 0;

    /**
     * 应用背景音乐
     * @param {Object} opts — 当前对话的音乐设置
     * @param {string|null} opts.chatId
     * @param {boolean}     opts.bgMusicEnabled
     * @param {string}      opts.bgMusicUrl    — URL 模式下的音频地址
     * @param {string}      opts.bgMusicMode   — 'url' | 'file'
     * @param {string}      opts.bgMusicName   — 文件模式下显示的文件名
     * @param {number}      opts.bgMusicVolume — 0.0–1.0
     */
    static async apply(opts = {}) {
        const { chatId = null, bgMusicEnabled = false, bgMusicUrl = '', bgMusicMode = 'url', bgMusicName = '', bgMusicVolume = 0.5 } = opts;

        if (!bgMusicEnabled || chatId == null) {
            this.stop();
            this.#removePlayerBar();
            return;
        }

        // 同一对话且在播放 → 仅更新音量
        if (this.#currentChatId === chatId && this.#audio && !this.#audio.paused) {
            this.setVolume(bgMusicVolume);
            this.#updatePlayerBarVolume();
            return;
        }

        this.#volume = bgMusicVolume;
        this.#currentChatId = chatId;

        let src = null;
        if (bgMusicMode === 'file' && chatId != null) {
            const blob = await AssetStore.getAudio(chatId);   // 优先本地 IndexedDB（离线可用）
            if (blob) {
                if (this.#currentSrc && this.#currentSrc.startsWith('blob:')) {
                    URL.revokeObjectURL(this.#currentSrc);
                }
                src = URL.createObjectURL(blob);
            } else if (bgMusicUrl && bgMusicUrl.startsWith('asset://')) {
                src = resolveAssetUrl(bgMusicUrl);   // 本地缺失 → 后端文件系统（跨设备）
            }
        } else if (bgMusicMode === 'url' && bgMusicUrl) {
            src = resolveAssetUrl(bgMusicUrl);
        }

        if (!src) {
            this.stop();
            this.#removePlayerBar();
            return;
        }

        this.#createAudio(src, bgMusicName || '背景音乐');
    }

    static #createAudio(src, name) {
        if (this.#audio) {
            if (this.#audio.src !== src) {
                this.#audio.src = src;
                this.#audio.load();
            }
            this.#audio.volume = this.#volume;
            this.#audio.play().catch(() => {});
            this.#currentSrc = src;
            this.#showPlayerBar(name);
            return;
        }

        const audio = new Audio();
        audio.src = src;
        audio.loop = true;
        audio.volume = this.#volume;
        audio.preload = 'auto';
        audio.onerror = () => {
            console.warn('BgMusicManager: 音频加载失败');
            this.stop();
            this.#removePlayerBar();
        };
        audio.play().catch(() => {});
        document.body.appendChild(audio);
        this.#audio = audio;
        this.#currentSrc = src;

        this.#createPlayerBar(name);
    }

    // ==================== 浮动播放器 UI（支持拖动）====================

    static #createPlayerBar(name) {
        this.#removePlayerBar();

        const bar = document.createElement('div');
        bar.className = 'bg-music-player-bar';
        bar.innerHTML = `
            <i class="fas fa-music music-icon"></i>
            <span class="music-name" title="${name}">${name}</span>
            <button class="music-btn" id="music-btn-prev" title="暂停/播放"><i class="fas fa-pause"></i></button>
            <input type="range" id="music-bar-volume" class="music-volume-slider" min="0" max="100" value="${Math.round(this.#volume * 100)}">
            <button class="music-btn" id="music-btn-close" title="关闭音乐"><i class="fas fa-times"></i></button>
        `;
        document.body.appendChild(bar);
        this.#playerBar = bar;

        // —— 暂停/播放 ——
        bar.querySelector('#music-btn-prev').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!this.#audio) return;
            const btn = bar.querySelector('#music-btn-prev i');
            if (this.#audio.paused) {
                this.#audio.play().catch(() => {});
                btn.className = 'fas fa-pause';
            } else {
                this.#audio.pause();
                btn.className = 'fas fa-play';
            }
        });

        // —— 音量滑块 ——
        const volSlider = bar.querySelector('#music-bar-volume');
        volSlider.addEventListener('input', (e) => {
            e.stopPropagation();
            const vol = parseInt(volSlider.value) / 100;
            this.setVolume(vol);
        });

        // —— 关闭按钮 ——
        bar.querySelector('#music-btn-close').addEventListener('click', (e) => {
            e.stopPropagation();
            this.stop();
            this.#removePlayerBar();
        });

        // —— 拖动支持 ——
        this.#bindDrag(bar);

        // 监听音频播放/暂停状态同步按钮图标
        if (this.#audio) {
            this.#audio.addEventListener('play', () => {
                const btn = bar.querySelector('#music-btn-prev i');
                if (btn) btn.className = 'fas fa-pause';
            });
            this.#audio.addEventListener('pause', () => {
                const btn = bar.querySelector('#music-btn-prev i');
                if (btn) btn.className = 'fas fa-play';
            });
        }
    }

    /** 绑定拖动事件 */
    static #bindDrag(bar) {
        const onStart = (e) => {
            // 如果点击的是按钮或滑块，不触发拖动
            if (e.target.closest('button') || e.target.closest('input')) return;

            e.preventDefault();
            this.#dragging = true;

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            this.#dragStartX = clientX;
            this.#dragStartY = clientY;

            const rect = bar.getBoundingClientRect();
            this.#barStartLeft = rect.left;
            this.#barStartTop = rect.top;

            // 切换为 left/top 定位
            bar.style.right = 'auto';
            bar.style.bottom = 'auto';
            bar.style.left = `${rect.left}px`;
            bar.style.top = `${rect.top}px`;
            bar.style.transition = 'none';
            bar.style.cursor = 'grabbing';
            bar.classList.add('dragging');

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        };

        const onMove = (e) => {
            if (!this.#dragging) return;
            e.preventDefault();

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const dx = clientX - this.#dragStartX;
            const dy = clientY - this.#dragStartY;

            let newLeft = this.#barStartLeft + dx;
            let newTop = this.#barStartTop + dy;

            // 限制在视口内
            const barW = bar.offsetWidth;
            const barH = bar.offsetHeight;
            newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - barW));
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - barH));

            bar.style.left = `${newLeft}px`;
            bar.style.top = `${newTop}px`;
        };

        const onEnd = () => {
            if (!this.#dragging) return;
            this.#dragging = false;
            bar.style.transition = '';
            bar.style.cursor = '';
            bar.classList.remove('dragging');

            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
        };

        bar.addEventListener('mousedown', onStart);
        bar.addEventListener('touchstart', onStart, { passive: false });
    }

    static #showPlayerBar(name) {
        if (this.#playerBar) {
            this.#playerBar.classList.remove('hidden');
            const nameSpan = this.#playerBar.querySelector('.music-name');
            if (nameSpan) {
                nameSpan.textContent = name;
                nameSpan.title = name;
            }
            this.#updatePlayerBarVolume();
        } else {
            this.#createPlayerBar(name);
        }
    }

    static #updatePlayerBarVolume() {
        if (!this.#playerBar) return;
        const volSlider = this.#playerBar.querySelector('#music-bar-volume');
        if (volSlider) volSlider.value = Math.round(this.#volume * 100);
    }

    static #removePlayerBar() {
        if (this.#playerBar) {
            this.#playerBar.remove();
            this.#playerBar = null;
        }
        this.#dragging = false;
    }

    // ==================== 公共 API ====================

    /** 切换播放/暂停 */
    static togglePlay() {
        if (!this.#audio) return;
        if (this.#audio.paused) {
            this.#audio.play().catch(() => {});
        } else {
            this.#audio.pause();
        }
    }

    /** 设置音量（0.0–1.0） */
    static setVolume(v) {
        this.#volume = Math.max(0, Math.min(1, v));
        if (this.#audio) this.#audio.volume = this.#volume;
        this.#updatePlayerBarVolume();
    }

    /** 获取当前音量 */
    static getVolume() { return this.#volume; }

    /** 是否正在播放 */
    static isPlaying() { return this.#audio && !this.#audio.paused; }

    /** 停止播放并清理音频资源 */
    static stop() {
        if (this.#audio) {
            this.#audio.pause();
            this.#audio.removeAttribute('src');
            this.#audio.load();
            this.#audio.remove();
            this.#audio = null;
        }
        if (this.#currentSrc && this.#currentSrc.startsWith('blob:')) {
            URL.revokeObjectURL(this.#currentSrc);
        }
        this.#currentSrc = null;
        this.#currentChatId = null;
    }

    /** 完全销毁（页面关闭时调用） */
    static destroy() {
        this.stop();
        this.#removePlayerBar();
    }
}

export default BgMusicManager;
