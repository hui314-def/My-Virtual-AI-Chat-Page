// 新手引导 + 功能地图
// 1) 聚光灯引导：首次访问自动弹出 5 步「必须先会」的操作（可跳过），完成状态记入 localStorage；
// 2) 功能地图：按分类列出站内全部功能与入口，支持搜索过滤与「一键定位」（在界面上高亮对应按钮）。
// 入口：个性化设置 → 新手引导（或引导结束页的「打开功能地图」）。
import Constants from '../core/constants.js';

// ==================== 新手引导步骤（只讲必会的 5 件事）====================
// target 为 null / 找不到时 → 提示气泡居中显示（不显示高亮光圈）
const STEPS = [
    {
        target: '.setting-btn',
        placement: 'right',
        title: '第 1 步 · 先配好模型服务',
        desc: '这是唯一「不做就用不了」的一步：点左下角「个性化·设置」→ 左侧「模型设置」，填写 Ollama 地址（本地模型）或 OpenAI 兼容 API Key（DeepSeek / 智谱等），填完点「测试连接」确认能通。',
        tips: [
            '顺手把「辅助任务模型」也选上：话题摘要、记忆提炼、消息建议、内隐状态结算都靠它，建议选非推理模型（如 gemma2 / gpt-4o-mini）。',
            '推理模型会把大量 token 花在「思考」上，maxTokens 太小时正文可能为空。',
        ],
        action: { label: '打开模型设置', open: 'model' },
    },
    {
        target: '.new-chat-row',
        placement: 'top',
        title: '第 2 步 · 创建角色',
        desc: '点「新建角色」会弹出选择：新建空白角色，或导入角色卡 / 对话存档。旁边的 👥 按钮可以建立 2~10 个角色的群聊。',
        tips: [
            '导入支持 SillyTavern 社区角色卡（PNG 内嵌 JSON / JSON）与本站导出的对话 JSON —— 人设、开场白、头像会自动配好。',
        ],
    },
    {
        target: '.input-container',
        placement: 'top',
        title: '第 3 步 · 开始对话',
        desc: '在输入框里输入消息，回车发送。输入框右侧的 ✨ 按钮可以让 AI 帮你出 3 个回复建议。',
        tips: [
            '文本 / 图片文件可以直接拖进网页，内容会附加到本轮消息发给模型。',
            '按钮栏里的「语音输入」点一下就能说话转文字。',
        ],
    },
    {
        target: ['.chat-messages .message:last-child', '.chat-messages'],
        placement: 'center',
        title: '第 4 步 · 消息气泡可以双击',
        desc: '双击任意一条消息气泡，会弹出操作栏：引用、删除、重新生成、继续生成、朗读。',
        tips: [
            '对回复不满意时用「重新生成」，比重新打字更快。',
            '模型思考过程与「内心OS」都在可折叠面板里，不会进入下一轮上下文。',
        ],
    },
    {
        target: '#topics-manage-btn',
        placement: 'top',
        title: '第 5 步 · 用话题给对话分段',
        desc: '聊长了以后点「话题管理」开一个新话题（快捷键 Ctrl + /），每个话题有独立的消息上下文，互不干扰。',
        tips: [
            '话题卡片可以「生成简介」，也可以用卡片右侧的 ⋯ 菜单「编辑摘要」。',
            '⋯ 菜单里还能把整个话题导出成 HTML 保存。',
        ],
    },
];

// ==================== 功能地图（分类 → 功能项）====================
// locate：点击「定位」后在界面上高亮的元素选择器（留空则只显示文字入口说明）
const FEATURE_GROUPS = [
    {
        title: '🚀 快速上手', open: true,
        items: [
            { name: '模型服务', icon: 'fas fa-microchip', desc: '接入 Ollama 本地模型，或任何 OpenAI 兼容 API（DeepSeek / 智谱等），顶部下拉可快速换模型。', entry: '个性化设置 → 模型设置', locate: '.setting-btn' },
            { name: '辅助任务模型', icon: 'fas fa-bolt', desc: '话题摘要、记忆提炼、消息建议、内隐状态结算共用的小模型，建议选非推理模型。', entry: '个性化设置 → 模型设置 → 辅助任务模型', locate: '.setting-btn' },
            { name: '新建角色', icon: 'fas fa-user-plus', desc: '点开会弹出两个选择：新建空白角色，或导入角色卡 / 对话存档。每个角色拥有独立的人设、头像、开场白、音色与模型参数。', entry: '侧边栏底部 → 新建角色', locate: '.new-chat-btn' },
            { name: '导入角色卡 / 对话存档', icon: 'fas fa-file-import', desc: '支持 SillyTavern 社区角色卡（PNG 内嵌 JSON / JSON）与本站导出的对话 JSON，导入后自动应用人设、开场白与头像。', entry: '侧边栏底部 →「新建角色」弹窗 → 导入角色卡 / 对话存档', locate: '.new-chat-btn' },
            { name: '对话设置', icon: 'fas fa-sliders-h', desc: '人设、开场白、温度、Top-P、上下文长度、最大 Token、思考深度、音色 —— 每个角色互不影响。', entry: '输入框下方 → 对话设置', locate: '#chat-settings-btn' },
        ],
    },
    {
        title: '💬 对话与消息',
        items: [
            { name: '双击消息气泡', icon: 'fas fa-hand-pointer', desc: '弹出操作栏：引用、删除、重新生成、继续生成、朗读语音。', entry: '直接双击任意消息' },
            { name: '消息建议', icon: 'fas fa-wand-magic-sparkles', desc: '让 AI 帮你想 3 种回复，聚焦输入框时按钮会滑出。', entry: '输入框右侧 ✨', locate: '#suggest-btn' },
            { name: '话题管理', icon: 'fas fa-list-ul', desc: '用话题给对话分段（独立上下文），支持生成简介、编辑摘要、导出 HTML。', entry: '输入框下方 → 话题管理（Ctrl + /）', locate: '#topics-manage-btn' },
            { name: '全局搜索', icon: 'fas fa-search', desc: '搜索全部会话标题与消息内容，点结果一键跳转定位。', entry: '右上角放大镜', locate: '#search-toggle-btn' },
            { name: '导出 / 导入对话', icon: 'fas fa-file-export', desc: '单会话可导出为 JSON 或 HTML；导出的对话 JSON 可以从「新建角色」弹窗重新导入。', entry: '导出：历史列表里会话旁的 ⋯ 菜单' },
            { name: '文件与图片上传', icon: 'fas fa-file-upload', desc: '文本、图片附加进本轮消息（图片需要视觉模型支持）。', entry: '输入框下方 → 文件上传，或直接拖入网页', locate: '#upload-file-btn' },
            { name: '流式输出', icon: 'fas fa-stream', desc: '回复逐字淡入，括号（）内的动作描写会在括号闭合瞬间变斜体。', entry: '默认开启，可在通用设置里调打字速度' },
        ],
    },
    {
        title: '🧠 让角色更聪明',
        items: [
            { name: '长期记忆', icon: 'fas fa-brain', desc: '自动提取事实 → 活跃度升降温 → 休眠 / 归档 → 相关时自动注入；每个角色的记忆互相隔离。', entry: '个性化设置 → 记忆', locate: '.setting-btn' },
            { name: '提示词注入', icon: 'fas fa-pen-nib', desc: '增删改自定义注入提示词，内置「角色内心OS输出」开关。', entry: '个性化设置 → 提示词注入', locate: '.setting-btn' },
            { name: 'SillyTavern 宏', icon: 'fas fa-code', desc: '角色卡与注入提示词支持 {{char}} {{user}} {{random}} {{roll}} 等宏，动态宏每轮实时解析。', entry: '直接写在人设 / 提示词文本里' },
            { name: '内隐状态（AI 人格深度）', icon: 'fas fa-heartbeat', desc: '好感度、情绪、精力、着装等会随对话自动演化的隐藏状态，悬浮卡片只读展示、可拖动。', entry: '对话设置 → 内隐状态 → 启用', locate: '#chat-settings-btn' },
            { name: '知识库', icon: 'fas fa-database', desc: '上传 docx / pdf / txt 建立知识库，对话时按相关性注入（需启动知识库后端服务）。', entry: '个性化设置 → 知识库 / 输入框下方 → 选择知识库', locate: '#kb-select-btn' },
            { name: '上下文与截断', icon: 'fas fa-scissors', desc: '上下文长度决定带回多少条历史消息；长对话建议配合话题分段使用。', entry: '对话设置 → 上下文长度' },
        ],
    },
    {
        title: '🎨 沉浸与外观',
        items: [
            { name: '聊天背景', icon: 'fas fa-image', desc: '静态图片或动态视频背景，支持裁剪并实时预览。', entry: '对话设置 → 背景', locate: '#chat-settings-btn' },
            { name: '背景音乐', icon: 'fas fa-music', desc: '上传喜欢的音乐做氛围，可调音量；也可只对某个角色生效。', entry: '对话设置 → 背景音乐', locate: '#chat-settings-btn' },
            { name: '深色 / 浅色主题', icon: 'fas fa-adjust', desc: '暗夜与明亮主题一键切换。', entry: '个性化设置 → 通用设置', locate: '.setting-btn' },
            { name: '沉浸模式', icon: 'fas fa-expand', desc: '隐藏侧边栏与顶栏，只留对话区域。', entry: '快捷键 Ctrl + Shift + F' },
            { name: '打字速度与字号', icon: 'fas fa-font', desc: '调整流式输出的打字节奏与界面字号大小。', entry: '个性化设置 → 通用设置', locate: '.setting-btn' },
        ],
    },
    {
        title: '🎙️ 语音与创作',
        items: [
            { name: '语音输入', icon: 'fas fa-microphone', desc: '麦克风转文字，需在 localhost 或 HTTPS 环境下使用。', entry: '输入框下方 → 语音输入', locate: '#voice-input-btn' },
            { name: '语音合成 TTS', icon: 'fas fa-volume-up', desc: '让角色把回复读出来；支持音色克隆与「音色设计」（需启动 TTS 后端服务）。', entry: '对话设置 → 语音' },
            { name: 'AI 生图', icon: 'fas fa-image', desc: '按描述生成图片并插入对话（需自行安装 ComfyUI 并启动生图服务）。', entry: '输入框下方 → 生成图片', locate: '#generate-image-btn' },
            { name: '生图后要手动引用', icon: 'fas fa-quote-right', desc: '生成的图片不会自动进入上下文，需要双击消息 → 引用图片（需视觉模型）。', entry: '双击含图片的消息' },
        ],
    },
    {
        title: '👥 多角色与外部',
        items: [
            { name: '多智能体群聊', icon: 'fas fa-users', desc: '2~10 个角色同群聊天，可 @点名、旁观模式、发言途中插话；成员设定实时继承各自的私聊。', entry: '侧边栏「新建角色」旁的 👥 按钮', locate: '#new-group-btn' },
            { name: 'QQ 接入', icon: 'fab fa-qq', desc: '让某个角色以小号身份在 QQ 群里陪聊，继承人设、可选知识库与语音。', entry: '个性化设置 → QQ 接入', locate: '.setting-btn' },
            { name: '账号 · 云同步', icon: 'fas fa-cloud', desc: '登录后聊天记录、长期记忆、全局设置同步到 MySQL，换设备 / 清缓存不丢。', entry: '左上角头像', locate: '#user-profile' },
            { name: '记忆救援工具', icon: 'fas fa-life-ring', desc: '记忆「消失」时用于诊断与跨库迁移（须与网站同源地址打开，如 http://localhost:8000/记忆救援工具.html）。', entry: '项目根目录 记忆救援工具.html' },
        ],
    },
    {
        title: '⌨️ 快捷键与小技巧',
        items: [
            { name: '快捷键', icon: 'fas fa-keyboard', desc: '新话题 Ctrl + / 、沉浸模式 Ctrl + Shift + F 、聚焦输入、新建对话等，全部可自定义。', entry: '个性化设置 → 快捷键', locate: '.setting-btn' },
            { name: '工具条可折叠', icon: 'fas fa-chevron-right', desc: '按钮栏右侧的小箭头可展开更多工具：知识库、文件上传、生成图片。', entry: '输入框下方按钮栏最右', locate: '#collapse-toggle-btn' },
            { name: '隐藏内容不进上下文', icon: 'fas fa-eye-slash', desc: '模型的思考过程与内心OS只用于展示，不会占用后续对话的上下文，也不影响角色记忆。', entry: '无需配置，默认如此' },
            { name: '数据存在哪', icon: 'fas fa-hdd', desc: '未登录时数据存浏览器 IndexedDB（清站点数据会丢）；登录后同步到云端。', entry: '左上角头像 → 账号·云同步' },
        ],
    },
];

export class Onboarding {
    /**
     * @param {Object} deps
     * @param {() => Object} [deps.getModalManager] 惰性获取 modalManager（用于 toast 提示）
     * @param {(tabOrNull: string|null) => void} [deps.openGlobalSettings] 打开个性化设置（可指定分区）
     */
    constructor({ getModalManager = null, openGlobalSettings = null } = {}) {
        this.getModalManager = getModalManager;
        this.openGlobalSettings = openGlobalSettings;

        this._root = null;
        this._blocker = null;
        this._spotlight = null;
        this._tip = null;
        this._steps = [];
        this._stepIndex = 0;
        this._active = false;
        this._currentTarget = null;
        this._onKeyDown = null;
        this._onReflow = null;
        this._featureMapEl = null;
        this._hintRoot = null;
    }

    // ==================== 公共 API ====================

    /** 是否已完成/跳过过引导 */
    isDone() {
        try { return localStorage.getItem(Constants.STORAGE_KEYS.ONBOARDING_DONE) === '1'; } catch { return false; }
    }

    /**
     * 首次访问自动启动（已完成后不再打扰）
     * @param {boolean} hasHistory 本地是否已有对话记录：老用户不自动弹（入口仍保留在设置里）
     */
    maybeAutoStart(hasHistory = false) {
        if (this.isDone() || this._active || hasHistory) return false;
        // 等主界面淡入与首屏渲染稳定后再开始
        setTimeout(() => {
            if (!this.isDone() && !this._active) this.start();
        }, 900);
        return true;
    }

    /** 开始 / 重新开始引导 */
    start() {
        this.#teardown(true);
        this._steps = STEPS;
        this._stepIndex = 0;
        this._active = true;
        this.#buildRoot();
        this.#renderStep();
        this.#bindGlobal();
    }

    /** 结束引导（silent = true 时不写入「已完成」标记，用于内部重启） */
    finish(silent = false) {
        this.#teardown(silent);
    }

    /** 打开功能地图 */
    openFeatureMap() {
        if (this._featureMapEl) {
            this._featureMapEl.style.display = 'flex';
            return;
        }
        const wrap = document.createElement('div');
        wrap.className = 'settings-modal feature-map-modal';
        wrap.id = 'feature-map-modal';
        wrap.style.display = 'flex';
        wrap.innerHTML = `
            <div class="modal-content feature-map-content">
                <div class="modal-header">
                    <h3><i class="fas fa-map-signs"></i> 功能地图</h3>
                    <button class="modal-close" data-fm-act="close">&times;</button>
                </div>
                <div class="feature-map-search">
                    <i class="fas fa-search"></i>
                    <input type="text" class="feature-map-search-input" placeholder="搜索功能…（试试：记忆、语音、群聊、导出）">
                </div>
                <div class="feature-map-body">
                    ${FEATURE_GROUPS.map((group, gi) => `
                        <details class="fm-group" data-group-index="${gi}"${group.open ? ' open' : ''}>
                            <summary>
                                <span class="fm-group-title">${group.title}</span>
                                <span class="fm-group-count">${group.items.length}</span>
                            </summary>
                            <div class="fm-items">
                                ${group.items.map(item => `
                                    <div class="fm-item">
                                        <div class="fm-item-icon"><i class="${item.icon}"></i></div>
                                        <div class="fm-item-main">
                                            <div class="fm-item-name">${item.name}</div>
                                            <div class="fm-item-desc">${item.desc}</div>
                                            <div class="fm-item-entry"><i class="fas fa-location-arrow"></i> ${item.entry}</div>
                                        </div>
                                        ${item.locate ? `<button class="fm-locate" data-locate="${item.locate}" data-locate-name="${item.name}" title="在界面上高亮这个入口">定位</button>` : ''}
                                    </div>
                                `).join('')}
                            </div>
                        </details>
                    `).join('')}
                </div>
                <div class="feature-map-footer">
                    <div class="feature-map-empty" hidden>没有匹配的功能，换个关键词试试～</div>
                    <div class="feature-map-actions">
                        <button class="modal-btn" data-fm-act="replay"><i class="fas fa-graduation-cap"></i> 重看新手引导</button>
                        <button class="modal-btn cancel" data-fm-act="close">关闭</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(wrap);
        this._featureMapEl = wrap;

        wrap.querySelectorAll('[data-fm-act]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const act = btn.getAttribute('data-fm-act');
                if (act === 'close') this.closeFeatureMap();
                else if (act === 'replay') { this.closeFeatureMap(); this.start(); }
            });
        });
        // 点击遮罩空白处关闭
        wrap.addEventListener('click', (e) => {
            if (e.target === wrap) this.closeFeatureMap();
        });
        // 定位：关闭地图 → 在界面上高亮对应入口
        wrap.querySelectorAll('.fm-locate').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const selector = btn.getAttribute('data-locate');
                const name = btn.getAttribute('data-locate-name') || '该入口';
                this.closeFeatureMap();
                setTimeout(() => this.highlightOnce(selector, name), 160);
            });
        });
        // 搜索过滤
        const searchInput = wrap.querySelector('.feature-map-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                const q = searchInput.value.trim().toLowerCase();
                let anyVisible = false;
                wrap.querySelectorAll('.fm-group').forEach(group => {
                    let visible = 0;
                    group.querySelectorAll('.fm-item').forEach(item => {
                        const hit = !q || item.textContent.toLowerCase().includes(q);
                        item.style.display = hit ? '' : 'none';
                        if (hit) visible++;
                    });
                    group.style.display = visible > 0 ? '' : 'none';
                    if (visible > 0) anyVisible = true;
                    if (q) group.open = visible > 0;
                    else group.open = group.getAttribute('data-group-index') === '0';
                });
                const emptyEl = wrap.querySelector('.feature-map-empty');
                if (emptyEl) emptyEl.hidden = anyVisible;
            });
        }
        setTimeout(() => searchInput && searchInput.focus(), 80);
    }

    /** 关闭功能地图 */
    closeFeatureMap() {
        if (this._featureMapEl) this._featureMapEl.style.display = 'none';
    }

    /**
     * 一次性高亮某个入口（功能地图「定位」用）：光圈 + 小提示，约 3 秒后自动消失
     * @param {string} selector
     * @param {string} name 功能名（用于提示文案）
     */
    highlightOnce(selector, name = '该入口') {
        const el = selector ? document.querySelector(selector) : null;
        if (!el) {
            this.#toast('没找到这个入口～它可能不在此界面');
            return false;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) {
            this.#toast('该入口当前不可见，先展开对应面板再试一次');
            return false;
        }
        this.#clearHint();

        const root = document.createElement('div');
        root.className = 'onboarding-root onboarding-root--hint';
        const pad = 6;
        root.innerHTML = `
            <div class="onboarding-blocker"></div>
            <div class="onboarding-spotlight"></div>
            <div class="onboarding-hint" style="left:${Math.max(12, Math.min(rect.left, window.innerWidth - 220))}px">
                <i class="fas fa-hand-point-up"></i> ${name} 在这里
            </div>
        `;
        document.body.appendChild(root);
        this._hintRoot = root;

        const spot = root.querySelector('.onboarding-spotlight');
        spot.style.left = `${rect.left - pad}px`;
        spot.style.top = `${rect.top - pad}px`;
        spot.style.width = `${rect.width + pad * 2}px`;
        spot.style.height = `${rect.height + pad * 2}px`;

        // 提示条贴在光圈的上面或下面
        const hint = root.querySelector('.onboarding-hint');
        const hintTop = rect.top > 46 ? rect.top - 40 : rect.bottom + 12;
        hint.style.top = `${Math.max(12, hintTop)}px`;

        const close = () => this.#clearHint();
        root.addEventListener('click', close);
        setTimeout(close, 3200);
        return true;
    }

    // ==================== 内部：引导流程 ====================

    #buildRoot() {
        const root = document.createElement('div');
        root.className = 'onboarding-root';
        root.innerHTML = `
            <div class="onboarding-blocker"></div>
            <div class="onboarding-spotlight" hidden></div>
            <div class="onboarding-tip" hidden></div>
        `;
        document.body.appendChild(root);
        this._root = root;
        this._blocker = root.querySelector('.onboarding-blocker');
        this._spotlight = root.querySelector('.onboarding-spotlight');
        this._tip = root.querySelector('.onboarding-tip');
        // 引导期间锁定页面交互：点空白处 = 下一步（不会误触页面元素）
        this._blocker.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.next();
        });
    }

    /** 解析步骤目标元素：支持候选选择器数组，返回第一个「存在且可见」的元素 */
    #resolveTarget(step) {
        if (!step || !step.target) return null;
        const list = Array.isArray(step.target) ? step.target : [step.target];
        for (const sel of list) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 1 && r.height > 1) return el;
        }
        return null;
    }

    #renderStep() {
        const step = this._steps[this._stepIndex];
        if (!step || !this._tip) return;
        const isLast = this._stepIndex === this._steps.length - 1;
        const dots = this._steps
            .map((_, i) => `<span class="onboarding-dot${i === this._stepIndex ? ' active' : ''}"></span>`)
            .join('');

        this._tip.hidden = false;
        this._tip.classList.remove('centered');
        this._tip.innerHTML = `
            <div class="onboarding-tip-head">
                <span class="onboarding-badge">${this._stepIndex + 1} / ${this._steps.length}</span>
                <span class="onboarding-tip-title">${step.title}</span>
            </div>
            <div class="onboarding-tip-desc">${step.desc}</div>
            ${step.tips && step.tips.length ? `<ul class="onboarding-tip-list">${step.tips.map(t => `<li>${t}</li>`).join('')}</ul>` : ''}
            ${step.action ? `<button class="onboarding-btn inline-action" data-act="step-action"><i class="fas fa-arrow-up-right-from-square"></i> ${step.action.label}</button>` : ''}
            <div class="onboarding-tip-foot">
                <div class="onboarding-dots">${dots}</div>
                <div class="onboarding-tip-btns">
                    <button class="onboarding-btn ghost" data-act="skip">跳过</button>
                    ${this._stepIndex > 0 ? '<button class="onboarding-btn ghost" data-act="prev">上一步</button>' : ''}
                    <button class="onboarding-btn primary" data-act="next">${isLast ? '完成 ✓' : '下一步'}</button>
                </div>
            </div>
        `;

        this._tip.querySelectorAll('[data-act]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const act = btn.getAttribute('data-act');
                if (act === 'next') this.next();
                else if (act === 'prev') this.prev();
                else if (act === 'skip') this.finish();
                else if (act === 'step-action') {
                    const tab = step.action.open;
                    this.finish();
                    if (typeof this.openGlobalSettings === 'function') this.openGlobalSettings(tab);
                }
            });
        });

        this._currentTarget = this.#resolveTarget(step);
        // 目标可能在需要滚动才可见的位置：先滚过去，再定位
        if (this._currentTarget && typeof this._currentTarget.scrollIntoView === 'function') {
            const r = this._currentTarget.getBoundingClientRect();
            if (r.top < 0 || r.bottom > window.innerHeight) {
                this._currentTarget.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        }
        this.#position(step.placement);
        // 滚动是平滑的：稍后再定位一次，避免光圈停在中途
        setTimeout(() => { if (this._active) this.#position(step.placement); }, 320);
    }

    #position(placement) {
        const tip = this._tip;
        const spot = this._spotlight;
        if (!tip) return;
        const target = this._currentTarget;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pad = 6, gap = 14, margin = 12;
        const rect = target ? target.getBoundingClientRect() : null;

        if (!rect || rect.width < 2 || rect.height < 2) {
            // 目标不存在/不可见 → 居中显示，不画光圈
            if (spot) spot.hidden = true;
            tip.classList.add('centered');
            const tr = tip.getBoundingClientRect();
            tip.style.left = `${Math.max(margin, (vw - tr.width) / 2)}px`;
            tip.style.top = `${Math.max(margin, (vh - tr.height) / 2)}px`;
            return;
        }

        if (spot) {
            spot.hidden = false;
            spot.style.left = `${rect.left - pad}px`;
            spot.style.top = `${rect.top - pad}px`;
            spot.style.width = `${rect.width + pad * 2}px`;
            spot.style.height = `${rect.height + pad * 2}px`;
        }

        const tipRect = tip.getBoundingClientRect();
        let place = placement && placement !== 'auto' ? placement : 'auto';
        if (place === 'auto' || place === 'center') {
            const below = vh - rect.bottom;
            const above = rect.top;
            const right = vw - rect.right;
            if (right > tipRect.width + gap + margin) place = 'right';
            else if (below > tipRect.height + gap + margin) place = 'bottom';
            else if (above > tipRect.height + gap + margin) place = 'top';
            else place = 'center';
        }

        let left, top;
        if (place === 'right') { left = rect.right + gap; top = rect.top; }
        else if (place === 'left') { left = rect.left - tipRect.width - gap; top = rect.top; }
        else if (place === 'top') { left = rect.left; top = rect.top - tipRect.height - gap; }
        else if (place === 'bottom') { left = rect.left; top = rect.bottom + gap; }
        else { left = (vw - tipRect.width) / 2; top = (vh - tipRect.height) / 2; }

        left = Math.min(Math.max(margin, left), Math.max(margin, vw - tipRect.width - margin));
        top = Math.min(Math.max(margin, top), Math.max(margin, vh - tipRect.height - margin));
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
        tip.dataset.placement = place;
    }

    #showDoneTip() {
        if (!this._tip) return;
        if (this._spotlight) this._spotlight.hidden = true;
        this._tip.classList.add('centered', 'done');
        this._tip.innerHTML = `
            <div class="onboarding-tip-head">
                <span class="onboarding-tip-title">🎉 引导完成！</span>
            </div>
            <div class="onboarding-tip-desc">现在可以开始和角色聊天啦。想看更多玩法，可以打开「功能地图」——那里按分类列出了全部功能与入口。</div>
            <ul class="onboarding-tip-list">
                <li>随时可以在「个性化设置 → 新手引导」里重看本引导或打开功能地图。</li>
            </ul>
            <div class="onboarding-tip-foot">
                <div class="onboarding-dots"></div>
                <div class="onboarding-tip-btns">
                    <button class="onboarding-btn ghost" data-act="done-close">开始使用</button>
                    <button class="onboarding-btn primary" data-act="done-map">打开功能地图</button>
                </div>
            </div>
        `;
        this._tip.querySelectorAll('[data-act]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const act = btn.getAttribute('data-act');
                this.finish();
                if (act === 'done-map') setTimeout(() => this.openFeatureMap(), 120);
            });
        });
        const tr = this._tip.getBoundingClientRect();
        this._tip.style.left = `${Math.max(12, (window.innerWidth - tr.width) / 2)}px`;
        this._tip.style.top = `${Math.max(12, (window.innerHeight - tr.height) / 2)}px`;
    }

    next() {
        if (!this._active) return;
        if (this._stepIndex < this._steps.length - 1) {
            this._stepIndex++;
            this.#renderStep();
        } else {
            this.#showDoneTip();
        }
    }

    prev() {
        if (!this._active || this._stepIndex === 0) return;
        this._stepIndex--;
        this.#renderStep();
    }

    #bindGlobal() {
        this._onKeyDown = (e) => {
            if (!this._active) return;
            if (e.key === 'Escape') { e.stopPropagation(); this.finish(); }
            else if (e.key === 'ArrowRight') { e.stopPropagation(); this.next(); }
            else if (e.key === 'ArrowLeft') { e.stopPropagation(); this.prev(); }
        };
        this._onReflow = () => {
            if (!this._active || !this._tip) return;
            const step = this._steps[this._stepIndex];
            this._currentTarget = this.#resolveTarget(step);
            this.#position(step ? step.placement : null);
        };
        document.addEventListener('keydown', this._onKeyDown, true);
        window.addEventListener('resize', this._onReflow);
        window.addEventListener('scroll', this._onReflow, true);
    }

    #teardown(silent = false) {
        if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown, true);
        if (this._onReflow) {
            window.removeEventListener('resize', this._onReflow);
            window.removeEventListener('scroll', this._onReflow, true);
        }
        this._onKeyDown = null;
        this._onReflow = null;
        if (this._root) {
            this._root.remove();
            this._root = null;
            this._blocker = null;
            this._spotlight = null;
            this._tip = null;
        }
        this._currentTarget = null;
        this._active = false;
        if (!silent) {
            try { localStorage.setItem(Constants.STORAGE_KEYS.ONBOARDING_DONE, '1'); } catch { /* ignore */ }
        }
    }

    #clearHint() {
        if (this._hintRoot) {
            this._hintRoot.remove();
            this._hintRoot = null;
        }
    }

    #toast(msg) {
        const mm = this.getModalManager ? this.getModalManager() : null;
        if (mm && typeof mm.showBriefToast === 'function') mm.showBriefToast(msg);
        else console.log('[Onboarding]', msg);
    }
}

export default Onboarding;
// 供调试/测试引用的数据（正常使用无需关心）
export { STEPS as ONBOARDING_STEPS, FEATURE_GROUPS as ONBOARDING_FEATURE_GROUPS };
