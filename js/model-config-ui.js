// 模型配置 UI:模型列表管理、快速切换下拉框、厂商状态持久化
// 从 script.js 分离(阶段1),风格与其余 js/ 模块一致(构造注入依赖)
import Constants from './constants.js';
import { escapeHtml } from './utils.js';
import { ModelService } from './model-service.js';
import { SettingsManager } from './settings-manager.js';

export class ModelConfigUI {
    /**
     * @param {Object} deps
     * @param {() => Object} deps.getModalManager 惰性获取 modalManager(避免构造期循环依赖,运行时才调用)
     */
    constructor({ getModalManager }) {
        this.getModalManager = getModalManager;
    }

    /** 运行时才解析 modalManager 引用 */
    get modalManager() {
        return this.getModalManager();
    }

    // 渲染模型列表 UI(全局设置 -> 模型设置)
    renderModelListUI() {
        // 辅助任务模型下拉框与模型列表同源，每次刷新时同步
        this.renderAuxModelSelect();
        const models = ModelService.getModels();
        const container = document.getElementById('model-list-container');
        if (!container) return;
        if (models.length === 0) {
            container.innerHTML = '<div style="padding: 8px; text-align: center; opacity: 0.6;">暂无模型，请添加</div>';
            return;
        }
        const currentModel = SettingsManager.getModelName();
        // 当前选中的模型置顶显示，其余保持原顺序（仅影响渲染，不改动存储顺序）
        const sortedModels = [...models].sort((a, b) => (b === currentModel) - (a === currentModel));
        container.innerHTML = sortedModels.map(model => {
            const isCurrent = model === currentModel;
            return `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-bottom: 1px solid rgba(100,130,255,0.2); ${isCurrent ? 'background: rgba(95,126,255,0.16); border-radius: 8px; border-left: 3px solid #5f7eff;' : ''}">
                <span style="${isCurrent ? 'color: #9db4ff; font-weight: 600;' : ''}">🤖 ${escapeHtml(model)}${isCurrent ? ' <span style="font-size:0.72rem; color:#5f7eff; border:1px solid rgba(95,126,255,0.5); border-radius:10px; padding:0 6px; margin-left:4px;">当前</span>' : ''}</span>
                <div>
                    ${isCurrent
                        ? '<span style="color: #7f9eff; margin-right: 8px;">✓ 使用中</span>'
                        : `<button class="select-model-btn" data-model="${escapeHtml(model)}" style="background: none; border: none; color: #5f7eff; cursor: pointer; margin-right: 8px;">✓ 使用</button>`}
                    <button class="delete-model-btn" data-model="${escapeHtml(model)}" style="background: none; border: none; color: #ff8a7a; cursor: pointer;">🗑 删除</button>
                </div>
            </div>
        `;
        }).join('');

        // 绑定使用和删除事件
        document.querySelectorAll('.select-model-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const modelName = btn.getAttribute('data-model');
                // 更新全局设置中的当前模型
                SettingsManager.update({ modelName });
                // 更新全局设置弹窗中的模型名称输入框
                const modelNameInput = document.getElementById('global-model-name');
                if (modelNameInput) modelNameInput.value = modelName;
                // 刷新快速切换下拉菜单
                this.updateModelSelector();
                this.renderModelListUI();    // 刷新列表（当前模型置顶高亮）
                this.modalManager.customAlert(`已切换到模型：${modelName}`, 'success');
            });
        });
        document.querySelectorAll('.delete-model-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const modelName = btn.getAttribute('data-model');
                const currentModels = ModelService.getModels();
                if (currentModels.length === 1) {
                    this.modalManager.customAlert('至少保留一个模型');
                    return;
                }
                ModelService.removeModel(modelName);
                this.saveModelListToStorage();
                this.renderModelListUI();      // 刷新列表
                this.updateModelSelector();    // 刷新下拉框
                // 如果删除的是辅助任务模型，则重置为「跟随主模型」
                if (SettingsManager.getAuxModel() === modelName) {
                    SettingsManager.update({ auxModel: '' });
                }
                // 如果删除的是当前使用的模型，则自动切换到列表第一个
                if (SettingsManager.getModelName() === modelName) {
                    SettingsManager.update({ modelName: models[0] });
                    const modelNameInput = document.getElementById('global-model-name');
                    if (modelNameInput) modelNameInput.value = models[0];
                    this.updateModelSelector();
                }
            });
        });
    }

    // 渲染「辅助任务模型」下拉框(全局设置 -> 模型设置)，与模型列表同源
    renderAuxModelSelect() {
        const select = document.getElementById('global-aux-model');
        if (!select) return;
        const models = ModelService.getModels();
        const current = SettingsManager.getAuxModel();
        const mainModel = SettingsManager.getModelName();
        select.innerHTML = '';
        const followOpt = document.createElement('option');
        followOpt.value = '';
        followOpt.textContent = mainModel ? `跟随主模型（${mainModel}）` : '跟随主模型';
        select.appendChild(followOpt);
        models.forEach(model => {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = model === mainModel ? `${model}（主模型）` : model;
            if (model === current) option.selected = true;
            select.appendChild(option);
        });
        if (!current) followOpt.selected = true;
    }

    // 更新快速切换下拉框
    updateModelSelector() {
        const models = ModelService.getModels();
        const select = document.getElementById('quick-model-select');
        if (!select) return;
        const currentModel = SettingsManager.getModelName();
        select.innerHTML = '';
        models.forEach(model => {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = model;
            if (model === currentModel) option.selected = true;
            select.appendChild(option);
        });
        if (models.length === 0) {
            select.innerHTML = '<option>无模型</option>';
        }
    }

    // 监听快速切换
    bindQuickModelSwitch() {
        const select = document.getElementById('quick-model-select');
        if (!select) return;
        select.addEventListener('change', (e) => {
            const newModel = e.target.value;
            SettingsManager.update({ modelName: newModel });
            // 同步更新全局设置弹窗中的输入框
            const modelNameInput = document.getElementById('global-model-name');
            if (modelNameInput) modelNameInput.value = newModel;
            // 刷新模型列表高亮（若列表已渲染）
            this.renderModelListUI();
            // 显示提示
            this.modalManager.showBriefToast(`已切换到模型：${newModel}`)
        });
    }

    // 添加模型
    addModel(modelName) {
        if (ModelService.addModel(modelName)) {
            this.saveModelListToStorage();
            this.renderModelListUI();
            this.updateModelSelector();
            return true;
        }
        return false;
    }

    // 保存模型列表到 localStorage(由调用方负责触发)
    saveModelListToStorage() {
        const models = ModelService.getModels();
        localStorage.setItem(Constants.STORAGE_KEYS.MODEL_LIST, JSON.stringify(models));
        // 同步更新当前厂商模型列表(保留已有的 apiKey / modelHost)
        const currentProvider = SettingsManager.getModelProvider();
        const existing = SettingsManager.loadProviderState(currentProvider) || {};
        SettingsManager.saveProviderState(currentProvider, {
            apiKey: existing.apiKey ?? SettingsManager.getApiKey(),
            modelHost: existing.modelHost ?? SettingsManager.getModelHost(),
            models: models,
            currentModel: SettingsManager.getModelName(),
        });
    }

    // 加载模型列表并初始化 ModelService 的静态列表
    loadModelListAndInit() {
        const currentProvider = SettingsManager.getModelProvider();
        // 优先从厂商独立状态中恢复模型列表
        const savedState = SettingsManager.loadProviderState(currentProvider);
        let models = [];
        if (savedState && savedState.models && savedState.models.length > 0) {
            models = savedState.models;
            // 同时恢复该厂商的当前模型
            if (savedState.currentModel) {
                SettingsManager.update({ modelName: savedState.currentModel });
            }
        } else {
            // 回退到旧的全局 model_list
            const stored = localStorage.getItem(Constants.STORAGE_KEYS.MODEL_LIST);
            if (stored) {
                models = JSON.parse(stored);
            } else {
                models = [SettingsManager.getModelName()];
                localStorage.setItem(Constants.STORAGE_KEYS.MODEL_LIST, JSON.stringify(models));
            }
        }
        ModelService.setModels(models);
    }
}
