// 知识库管理模块，负责知识库的列表/详情/创建/编辑/上传等功能。
import { escapeHtml } from './utils.js';

export class KnowledgeBaseManager {
    /**
     * @param {Object} deps
     * @param {Function} deps.customAlert      — (message, type) 弹窗提示
     * @param {Function} deps.showCustomDialog — (options) Promise 自定义弹窗
     */
    constructor(deps) {
        this.customAlert = deps.customAlert;
        this.showCustomDialog = deps.showCustomDialog;
        this.kbListCache = null;
        this.kbCustomName = localStorage.getItem('kb_name_default') || '默认知识库';
        this.apiBase = localStorage.getItem('kb_api_base') || 'http://localhost:5051';
    }

    _api(path) {
        return `${this.apiBase}${path}`;
    }

    // ==================== 知识库列表 ====================

    async renderKnowledgeBase() {
        const container = document.getElementById('knowledge-base-container');
        if (!container) return;

        // 先渲染页面框架（头栏 + 输入框 + 按钮），确保即使接口出错也能修改地址
        this._renderKbHeader(container);

        // 尝试加载列表数据
        try {
            let kbList = [];
            if (this.kbListCache !== null) {
                kbList = this.kbListCache;
            } else {
                const response = await fetch(`${this.apiBase}/knowledge_bases`);
                if (!response.ok) throw new Error('网络错误');
                const data = await response.json();
                kbList = data.knowledge_bases || [];
                this.kbListCache = kbList;
            }
            this._renderKbList(container, kbList);
        } catch (err) {
            this._renderKbContent(container, `<div style="grid-column:1/-1; text-align:center;padding:40px;color:#ff7a5c;">加载失败：${err.message}<br><span style="font-size:0.8rem;color:#8e8eb3;">请检查上方接口地址是否正确</span></div>`);
        }
    }

    /** 渲染页头（始终可见，不受接口错误影响） */
    _renderKbHeader(container) {
        container.innerHTML = `
            <div id="kb-header">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                    <h4 style="margin:0; color:#ccd6ff;"><i class="fas fa-database" style="margin-right:8px;"></i>知识库</h4>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <input type="text" id="kb-api-base" value="${this.apiBase}" placeholder="后端接口地址" title="后端接口地址，修改后自动重载"
                            style="width:180px; background:rgba(30,34,55,0.6); border:1px solid rgba(100,130,255,0.3); border-radius:20px; padding:6px 12px; color:#b7c4ff; font-size:0.8rem; outline:none; transition:border-color 0.2s;"
                            onfocus="this.style.borderColor='rgba(100,130,255,0.7)'" onblur="this.style.borderColor='rgba(100,130,255,0.3)'">
                        <button class="action-btn" id="new-kb-btn"><i class="fas fa-plus"></i> 新建知识库</button>
                    </div>
                </div>
            </div>
            <div id="kb-content" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap:16px;">
                <div style="grid-column:1/-1; text-align:center;padding:40px;"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>
            </div>
        `;

        // 绑定新建按钮（始终可用）
        document.getElementById('new-kb-btn').addEventListener('click', () => {
            this.createKnowledgeBase();
        });

        // 绑定 API 地址输入框
        const apiInput = document.getElementById('kb-api-base');
        apiInput.addEventListener('change', () => {
            const newBase = apiInput.value.trim().replace(/\/+$/, '');
            if (newBase && newBase !== this.apiBase) {
                this.apiBase = newBase;
                localStorage.setItem('kb_api_base', this.apiBase);
                this.kbListCache = null;
                this.renderKnowledgeBase();
            }
        });
    }

    /** 渲染知识库卡片列表 */
    _renderKbList(container, kbList) {
        let html = '';
        if (kbList.length === 0) {
            html += `<div style="grid-column:1/-1; text-align:center; padding:40px; color:#8e8eb3;">暂无知识库，点击"新建知识库"创建</div>`;
        } else {
            for (const kb of kbList) {
                html += `
                    <div class="knowledge-card" data-kb-id="${kb.id}" style="background:rgba(30,34,55,0.6); border-radius:16px; padding:20px; border:1px solid rgba(100,130,255,0.3); cursor:pointer; transition:0.2s; position:relative;">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                            <i class="fas fa-database" style="font-size:1.5rem; color:#5f7eff;"></i>
                            <div>
                                <button class="edit-kb-btn" data-kb-id="${kb.id}" style="background:transparent; border:none; color:#b7c4ff; cursor:pointer; margin-right:8px;"><i class="fas fa-pencil-alt"></i></button>
                                <button class="delete-kb-btn" data-kb-id="${kb.id}" style="background:transparent; border:none; color:#ff8a7a; cursor:pointer;"><i class="fas fa-trash-alt"></i></button>
                            </div>
                        </div>
                        <div class="kb-card-name" style="font-size:1.1rem; font-weight:500; margin:12px 0 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(kb.name)}</div>
                        ${kb.description ? `<div class="kb-card-desc" style="font-size:0.8rem; color:#b7c4ff; margin-bottom:8px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; word-break:break-word;">${escapeHtml(kb.description)}</div>` : ''}
                        <div style="font-size:0.8rem; color:#8e8eb3;">文档数：${kb.document_count || 0}</div>
                        <div style="font-size:0.7rem; color:#6c7b9e; margin-top:4px;">创建：${kb.created_at ? kb.created_at.substring(0,10) : '未知'}</div>
                    </div>
                `;
            }
        }
        this._renderKbContent(container, html);

        // 绑定卡片事件
        container.querySelectorAll('.knowledge-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                this.showKnowledgeDetail(card.dataset.kbId);
            });
        });

        container.querySelectorAll('.edit-kb-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const kbId = btn.dataset.kbId;
                const card = btn.closest('.knowledge-card');
                const nameDiv = card.querySelector('.kb-card-name');
                const descDiv = card.querySelector('.kb-card-desc');
                const currentName = nameDiv ? nameDiv.textContent : '';
                const currentDesc = (descDiv && !descDiv.textContent.includes('文档数')) ? descDiv.textContent : '';
                this.editKnowledgeBase(kbId, currentName, currentDesc);
            });
        });

        container.querySelectorAll('.delete-kb-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const kbId = btn.dataset.kbId;
                if (!confirm('确定要删除该知识库及其所有文档吗？')) return;
                try {
                    const res = await fetch(`${this.apiBase}/knowledge_bases/${kbId}`, { method: 'DELETE' });
                    if (res.ok) {
                        this.kbListCache = null;
                        this.customAlert('删除成功', 'success');
                        this.renderKnowledgeBase();
                    } else {
                        const err = await res.json();
                        this.customAlert('删除失败：' + err.error, 'error');
                    }
                } catch (err) {
                    this.customAlert('删除失败：' + err.message, 'error');
                }
            });
        });
    }

    /** 替换内容区 HTML（不触碰头栏） */
    _renderKbContent(container, html) {
        const contentEl = document.getElementById('kb-content');
        if (contentEl) {
            contentEl.innerHTML = html;
        }
    }

    // ==================== 知识库详情 ====================

    async showKnowledgeDetail(kbId) {
        const container = document.getElementById('knowledge-base-container');
        if (!container) return;

        // 获取知识库名称
        let kbName = '知识库';
        if (this.kbListCache) {
            const found = this.kbListCache.find(kb => kb.id === kbId);
            if (found) kbName = found.name;
        } else {
            try {
                const response = await fetch(`${this.apiBase}/knowledge_bases`);
                if (response.ok) {
                    const data = await response.json();
                    this.kbListCache = data.knowledge_bases || [];
                    const found = this.kbListCache.find(kb => kb.id === kbId);
                    if (found) kbName = found.name;
                }
            } catch (e) {
                console.warn('获取知识库名称失败', e);
            }
        }
        try {
            const response = await fetch(`${this.apiBase}/knowledge_bases/${kbId}/documents`);
            if (!response.ok) throw new Error('网络错误');
            const data = await response.json();
            const docs = data.documents || [];
            let html = `
                <div id="upload-progress-container" style="display:none; margin-bottom:16px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span id="upload-progress-label">上传中...</span>
                        <span id="upload-progress-percent">0%</span>
                    </div>
                    <div style="width:100%; height:6px; background:rgba(30,34,55,0.6); border-radius:3px; overflow:hidden; margin-top:4px;">
                        <div id="upload-progress-bar" style="width:0%; height:100%; background:linear-gradient(90deg, #5f7eff, #7f9eff); transition:width 0.3s;"></div>
                    </div>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                    <div style="display:flex; align-items:center; gap:12px;">
                        <button class="action-btn" id="back-to-kb-list"><i class="fas fa-arrow-left"></i> 返回</button>
                        <h4 style="margin:0; color:#ccd6ff;">
                            <span class="kb-detail-name" data-kb-id="${kbId}" style="cursor:text;">${kbName}</span>
                        </h4>
                    </div>
                    <button class="action-btn" id="upload-doc-btn"><i class="fas fa-upload"></i> 上传文档</button>
                </div>
                <div style="background:rgba(20,24,45,0.5); border-radius:16px; padding:16px;">
            `;
            if (docs.length === 0) {
                html += `<div style="text-align:center;padding:40px; color:#8e8eb3;">暂无文档，点击"上传文档"添加</div>`;
            } else {
                html += `<div style="display:flex; flex-direction:column; gap:12px;">`;
                for (const doc of docs) {
                    html += `
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px; background:rgba(30,34,55,0.4); border-radius:12px; border-left:3px solid #5f7eff;">
                            <div>
                                <i class="fas fa-file-alt" style="color:#5f7eff; margin-right:12px;"></i>
                                <span>${doc.filename}</span>
                                <span style="font-size:0.7rem; color:#8e8eb3; margin-left:12px;">块数：${doc.chunks}</span>
                            </div>
                            <button class="delete-doc-btn" data-doc-id="${doc.doc_id}" style="background:transparent; border:none; color:#ff8a7a; cursor:pointer;">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                        </div>
                    `;
                }
                html += `</div>`;
            }
            html += `</div>`;
            container.innerHTML = html;

            // 返回列表
            document.getElementById('back-to-kb-list').addEventListener('click', () => {
                this.renderKnowledgeBase();
            });

            // 删除文档
            container.querySelectorAll('.delete-doc-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const docId = btn.dataset.docId;
                    if (!confirm(`确定要删除该文档吗？`)) return;
                    try {
                        const res = await fetch(`${this.apiBase}/knowledge_bases/${kbId}/documents/${docId}`, { method: 'DELETE' });
                        if (res.ok) {
                            this.kbListCache = null;
                            this.showKnowledgeDetail(kbId);
                            this.customAlert('删除成功', 'success');
                        } else {
                            const err = await res.json();
                            this.customAlert('删除失败：' + err.error, 'error');
                        }
                    } catch (err) {
                        this.customAlert('删除失败：' + err.message, 'error');
                    }
                });
            });

            // 上传文档
            document.getElementById('upload-doc-btn').addEventListener('click', () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.txt,.pdf,.docx';
                input.onchange = async (e) => {
                    const file = e.target.files[0];
                    if (!file) return;

                    const uploadBtn = document.getElementById('upload-doc-btn');
                    const originalHTML = uploadBtn.innerHTML;
                    uploadBtn.disabled = true;
                    uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 上传中...';
                    uploadBtn.style.opacity = '0.7';

                    const progressContainer = document.getElementById('upload-progress-container');
                    const progressBar = document.getElementById('upload-progress-bar');
                    const progressPercent = document.getElementById('upload-progress-percent');
                    const progressLabel = document.getElementById('upload-progress-label');
                    progressContainer.style.display = 'block';
                    progressBar.style.width = '0%';
                    progressPercent.textContent = '0%';
                    progressLabel.textContent = `正在上传 ${file.name} ...`;

                    const formData = new FormData();
                    formData.append('file', file);

                    try {
                        const uploadRes = await fetch(`${this.apiBase}/knowledge_bases/${kbId}/documents`, {
                            method: 'POST',
                            body: formData
                        });

                        if (!uploadRes.ok) {
                            const err = await uploadRes.json();
                            throw new Error(err.error || '上传失败');
                        }

                        const uploadData = await uploadRes.json();
                        const taskId = uploadData.doc_id;

                        progressLabel.textContent = '上传完成，正在处理...';
                        progressBar.style.width = '10%';
                        progressPercent.textContent = '10%';

                        let lastProg = 10;
                        let delay = 3000;
                        let pollTimer = null;

                        const doPoll = async () => {
                            try {
                                const statusRes = await fetch(`${this.apiBase}/task_status/${taskId}`);
                                if (!statusRes.ok) throw new Error('状态查询失败');
                                const statusData = await statusRes.json();

                                if (statusData.status === 'processing') {
                                    const prog = statusData.progress || 0;
                                    progressBar.style.width = prog + '%';
                                    progressPercent.textContent = prog + '%';
                                    progressLabel.textContent = `处理中 ${prog}%`;

                                    if (prog === lastProg) {
                                        delay = Math.min(delay * 2, 30000);
                                    } else {
                                        delay = 3000;
                                        lastProg = prog;
                                    }
                                    pollTimer = setTimeout(doPoll, delay);
                                } else if (statusData.status === 'completed') {
                                    clearTimeout(pollTimer);
                                    progressLabel.textContent = '处理完成 ✅';
                                    progressBar.style.width = '100%';
                                    progressPercent.textContent = '100%';
                                    this.kbListCache = null;
                                    await this.showKnowledgeDetail(kbId);
                                    uploadBtn.disabled = false;
                                    uploadBtn.innerHTML = originalHTML;
                                    this.customAlert('上传成功', 'success');
                                    setTimeout(() => {
                                        progressContainer.style.display = 'none';
                                    }, 2000);
                                } else if (statusData.status === 'failed') {
                                    clearTimeout(pollTimer);
                                    uploadBtn.disabled = false;
                                    uploadBtn.innerHTML = originalHTML;
                                    this.customAlert('处理失败：' + (statusData.error || '未知错误'), 'error');
                                    setTimeout(() => {
                                        progressContainer.style.display = 'none';
                                    }, 3000);
                                }
                            } catch (err) {
                                clearTimeout(pollTimer);
                                this.customAlert('状态查询异常：' + err.message, 'error');
                            }
                        };
                        pollTimer = setTimeout(doPoll, delay);
                    } catch (err) {
                        this.customAlert('上传失败：' + err.message, 'error');
                        uploadBtn.disabled = false;
                        uploadBtn.innerHTML = originalHTML;
                        progressContainer.style.display = 'none';
                    }
                };
                input.click();
            });

            // 恢复进行中的上传任务进度条
            this._restoreUploadProgress(kbId);
        } catch (err) {
            container.innerHTML = `
                <div style="text-align:center;padding:40px;color:#ff7a5c;">
                    加载失败：${err.message}<br>
                    <span style="font-size:0.8rem;color:#8e8eb3;">请检查接口地址是否正确</span><br>
                    <button class="action-btn" id="back-to-list-on-error" style="margin-top:12px;"><i class="fas fa-arrow-left"></i> 返回列表</button>
                </div>`;
            document.getElementById('back-to-list-on-error').addEventListener('click', () => {
                this.renderKnowledgeBase();
            });
        }
    }

    async _restoreUploadProgress(kbId) {
        try {
            const res = await fetch(`${this.apiBase}/knowledge_bases/${kbId}/tasks`);
            if (!res.ok) return;
            const data = await res.json();
            const tasks = data.tasks || {};

            const progressContainer = document.getElementById('upload-progress-container');
            const progressBar = document.getElementById('upload-progress-bar');
            const progressPercent = document.getElementById('upload-progress-percent');
            const progressLabel = document.getElementById('upload-progress-label');
            if (!progressContainer || !progressBar || !progressPercent || !progressLabel) return;

            for (const [taskId, task] of Object.entries(tasks)) {
                if (task.status === 'processing') {
                    progressContainer.style.display = 'block';
                    progressBar.style.width = task.progress + '%';
                    progressPercent.textContent = task.progress + '%';
                    progressLabel.textContent = `处理中 ${task.progress}%`;

                    let lastProg = task.progress || 0;
                    let delay = 3000;
                    let pollTimer = null;

                    const doPoll = async () => {
                        try {
                            const statusRes = await fetch(`${this.apiBase}/task_status/${taskId}`);
                            if (!statusRes.ok) { clearTimeout(pollTimer); return; }
                            const s = await statusRes.json();
                            if (s.status === 'processing') {
                                const prog = s.progress || 0;
                                progressBar.style.width = prog + '%';
                                progressPercent.textContent = prog + '%';
                                progressLabel.textContent = `处理中 ${prog}%`;

                                if (prog === lastProg) {
                                    delay = Math.min(delay * 2, 30000);
                                } else {
                                    delay = 3000;
                                    lastProg = prog;
                                }
                                pollTimer = setTimeout(doPoll, delay);
                            } else if (s.status === 'completed') {
                                clearTimeout(pollTimer);
                                progressLabel.textContent = '处理完成 ✅';
                                progressBar.style.width = '100%';
                                progressPercent.textContent = '100%';
                                this.kbListCache = null;
                                await this.showKnowledgeDetail(kbId);
                            } else if (s.status === 'failed') {
                                clearTimeout(pollTimer);
                                progressContainer.style.display = 'none';
                                this.customAlert('处理失败：' + (s.error || '未知错误'), 'error');
                            }
                        } catch (e) {
                            clearTimeout(pollTimer);
                        }
                    };
                    pollTimer = setTimeout(doPoll, delay);
                    return;
                }
            }
        } catch (e) {
            // 静默失败
        }
    }

    // ==================== 知识库 CRUD ====================

    async showCreateKbDialog() {
        const result = await this.showCustomDialog({
            title: '新建知识库',
            message: `
                <div class="form-group">
                    <label>知识库名称</label>
                    <input type="text" id="new-kb-name" placeholder="请输入名称" style="width:100%;">
                </div>
                <div class="form-group">
                    <label>描述（可选）</label>
                    <textarea id="new-kb-desc" rows="2" placeholder="请输入描述" style="width:100%;"></textarea>
                </div>
            `,
            buttons: [
                { text: '取消', value: null, className: 'cancel' },
                { text: '创建', value: true, className: 'save' }
            ],
            closable: false
        });

        if (result) {
            const nameInput = document.getElementById('new-kb-name');
            const descInput = document.getElementById('new-kb-desc');
            const name = nameInput ? nameInput.value.trim() : '';
            const description = descInput ? descInput.value.trim() : '';
            if (!name) {
                this.customAlert('请输入知识库名称', 'warning');
                return;
            }
            try {
                const res = await fetch(`${this.apiBase}/knowledge_bases`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, description })
                });
                if (res.ok) {
                    this.kbListCache = null;
                    await this.renderKnowledgeBase();
                    this.customAlert('知识库创建成功', 'success');
                } else {
                    const err = await res.json();
                    this.customAlert('创建失败：' + err.error, 'error');
                }
            } catch (err) {
                this.customAlert('创建失败：' + err.message, 'error');
            }
        }
    }

    async createKnowledgeBase() {
        const result = await this.showCustomDialog({
            title: '新建知识库',
            message: `
                <div style="margin-bottom:12px;">
                    <label style="display:block; margin-bottom:4px; color:#b7c4ff;">名称</label>
                    <input type="text" id="new-kb-name" style="width:100%; background:rgba(30,34,55,0.7); border:1px solid rgba(100,130,255,0.4); border-radius:20px; padding:10px 16px; color:#f0f3ff; font-size:0.9rem; outline:none;">
                </div>
                <div>
                    <label style="display:block; margin-bottom:4px; color:#b7c4ff;">描述</label>
                    <textarea id="new-kb-desc" rows="2" style="width:100%; background:rgba(30,34,55,0.7); border:1px solid rgba(100,130,255,0.4); border-radius:20px; padding:10px 16px; color:#f0f3ff; font-size:0.9rem; outline:none; resize:vertical;"></textarea>
                </div>
            `,
            buttons: [
                { text: '取消', value: null, className: 'cancel' },
                { text: '创建', value: 'create', className: 'save' }
            ],
            isHtml: true
        });
        if (result === 'create') {
            const nameInput = document.getElementById('new-kb-name');
            const descInput = document.getElementById('new-kb-desc');
            const name = nameInput ? nameInput.value.trim() : '';
            const description = descInput ? descInput.value.trim() : '';
            if (!name) {
                this.customAlert('请输入知识库名称', 'error');
                return;
            }
            try {
                const res = await fetch(`${this.apiBase}/knowledge_bases`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, description })
                });
                if (res.ok) {
                    this.kbListCache = null;
                    this.customAlert('创建成功', 'success');
                    this.renderKnowledgeBase();
                } else {
                    const err = await res.json();
                    this.customAlert('创建失败：' + err.error, 'error');
                }
            } catch (err) {
                this.customAlert('创建失败：' + err.message, 'error');
            }
        }
    }

    async editKnowledgeBase(kbId, currentName, currentDesc) {
        const result = await this.showCustomDialog({
            title: '编辑知识库',
            message: `
                <div style="margin-bottom:12px;">
                    <label style="display:block; margin-bottom:4px; color:#b7c4ff;">名称</label>
                    <input type="text" id="edit-kb-name" value="${escapeHtml(currentName)}" style="width:100%; background:rgba(30,34,55,0.7); border:1px solid rgba(100,130,255,0.4); border-radius:20px; padding:10px 16px; color:#f0f3ff; font-size:0.9rem; outline:none;">
                </div>
                <div>
                    <label style="display:block; margin-bottom:4px; color:#b7c4ff;">描述</label>
                    <textarea id="edit-kb-desc" rows="2" style="width:100%; background:rgba(30,34,55,0.7); border:1px solid rgba(100,130,255,0.4); border-radius:20px; padding:10px 16px; color:#f0f3ff; font-size:0.9rem; outline:none; resize:vertical;">${escapeHtml(currentDesc || '')}</textarea>
                </div>
            `,
            buttons: [
                { text: '取消', value: null, className: 'cancel' },
                { text: '保存', value: 'save', className: 'save' }
            ],
            isHtml: true
        });
        if (result === 'save') {
            const nameInput = document.getElementById('edit-kb-name');
            const descInput = document.getElementById('edit-kb-desc');
            const name = nameInput ? nameInput.value.trim() : '';
            const description = descInput ? descInput.value.trim() : '';
            if (!name) {
                this.customAlert('请输入知识库名称', 'error');
                return;
            }
            try {
                const res = await fetch(`${this.apiBase}/knowledge_bases/${kbId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, description })
                });
                if (res.ok) {
                    this.kbListCache = null;
                    this.customAlert('更新成功', 'success');
                    this.renderKnowledgeBase();
                } else {
                    const err = await res.json();
                    this.customAlert('更新失败：' + err.error, 'error');
                }
            } catch (err) {
                this.customAlert('更新失败：' + err.message, 'error');
            }
        }
    }
}
