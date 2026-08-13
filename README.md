# 虚拟AI · 暗夜对话 · 灵境投影

一款沉浸式 AI 伴侣聊天网页，融合科幻视觉与深度对话体验，支持角色定制、语音合成、图片生成及多话题管理。

## 📖 项目简介

本项目旨在打造一个不同于普通大模型对话平台的沉浸式 AI 交互空间。在这里，你可以与拥有独立人格的 AI 角色进行深入交流，体验透明气泡、动态背景和数字图腾带来的“灵境”氛围。

你可以自由设定角色的名字、人设、头像和背景图，调整模型参数（温度、上下文长度等），甚至让 AI 的回复通过语音合成朗读出来，并支持实时语音输入。打造属于你的专属对话角色人格。你还可以使用话题管理功能组织对话脉络，随时切换话题场景，并将精彩对话导出为 JSON 或 HTML 文件保存或分享。

此外，该项目还有更多功能等待你的发掘……

## ✨ 主要特性

- 🎭 **角色定制** — 自定义 AI 角色的名称、性格设定、头像和开场白，打造专属灵魂伴侣。
- 🖼️ **聊天背景** — 可上传自定义背景图，支持图片（静态背景）和视频（动态背景），配合透明玻璃消息气泡，营造沉浸式视觉氛围。
- 🎵 **背景音乐** — 可上传自定义背景音乐，增强沉浸式听觉体验。
- 🎙️ **语音交互** — 支持语音输入（Web Speech API）及语音合成（TTS），让对话更自然。
- 🧠 **模型兼容** — 原生支持 Ollama 和 OpenAI 兼容 API（如 GPT、DeepSeek 等），可自由切换模型。
- 📚 **话题管理** — 通过“新话题”分隔不同对话片段，便于回溯与切换，支持自动/手动生成话题简介。
- 💾 **数据持久化** — 所有聊天记录自动保存在浏览器 IndexedDB 中，重启不丢失。
- 🔍 **全局搜索** — 快速搜索历史消息和会话，一键跳转定位。
- 📤 **导入/导出** — 支持导出单会话为 JSON 或 HTML 文件，也可导入之前导出的 JSON 会话。
- 🖼️ **AI 图片生成** — 集成 ComfyUI 后端，可根据描述生成图片并自动插入对话。
- 🌓 **暗夜/明亮主题** — 原生支持深色、扩展支持浅色主题，适配不同使用场景。
- ⌨️ **快捷键支持** — 内置常用快捷键（新建对话、新话题、聚焦输入等），且可自定义。
- 📖 **知识库搭建** — 支持docx，pdf，txt等格式的文档上传到知识库和多知识库管理操作。

## 🔧 安装与配置

### 1. 前端网页（必须）

将本项目文件下载到本地，确保目录结构包含以下主要文件（部分示例）：

```plaintext
├── 提示词模板/
├── backend_code/
|   ├── requirements/
|   ├── image_gen/
|   ├── knowledge_base/
|   └── tts/
├── js/
|  ├── model-service.js
|  ├── utils.js
|  └── ...
├── css/
|  ├──base.css
|  └── ...
├── index.html
├── script.js
├── ico.png
├── install_dependencies.bat
├── start.bat
└── README.md
```

克隆仓库并通过命令行切换至当前目录下

```bash
git clone https://github.com/hui314-def/My-Virtual-AI-Chat-Page
cd My-Virtual-AI-Chat-Page
```

使用任意 HTTP 服务器启动前端（推荐 Python 内置）：

```bash
python -m http.server 8000
```

访问 `http://localhost:8000` 即可开始使用（支持手机和电脑）。

### 2. 模型服务（Ollama 或 OpenAI 兼容）

#### Ollama 配置（推荐本地部署）

安装 Ollama 并拉取模型（如 gemma2、llama3 等）。

设置环境变量以允许跨域请求（重启 Ollama 生效）：

```bash
# Windows
set OLLAMA_ORIGINS=*

# Linux/macOS
export OLLAMA_ORIGINS=*
```

默认 Ollama API 地址为 `http://localhost:11434`，可在网页“个性化设置”中根据实际情况修改。

#### OpenAI 兼容 API

支持任何兼容 OpenAI 格式的 API（如 DeepSeek、智谱等），设置中支持一键切换模型厂商，仅需一次配置 API-Key 即可随意切换，也可以支持在设置中填写自定义 Base URL。

### 3. 语音合成服务（可选）

若需要语音朗读功能，需启动 `tts_api.py`，建议安装python3.12：

```bash
pip install -r backend_code/requirements/tts_requirements.txt
python backend_code/tts/tts_api.py
```

默认监听端口 5000，支持音色克隆（通过上传参考音频），支持 API Key 鉴权（通过 `.env` 设置 `TTS_API_KEY`）。项目文件夹里已经有我克隆好的音色文件，免费使用

首次启动会自动加载 Qwen3-TTS 模型（需提前下载模型权重，参考 [Qwen3-TTS 官方文档](https://modelscope.cn/models/Qwen/Qwen3-TTS-12Hz-1.7B-Base/summary)）。编辑.env文件输入模型路径QWEN_MODEL_DIR

### 4. 图片生成服务（可选）

若需要 AI 生图功能，需安装 [ComfyUI](https://github.com/Comfy-Org/ComfyUI)，并将工作流文件（`image_gen_workflow.json`）放置于项目目录下（示例工作流，可按需修改和替换）。随后启动图片生成 API：

```bash
pip install -r backend_code/requirements/image_gen_requirements.txt
python backend_code/image_gen/image_gen_api.py
```

默认监听端口 5050，并支持 API Key 鉴权（通过 `.env` 设置 `IMG_API_KEY`）。

⚠️ 注意事项：生成后的图片不会加入到语言模型的对话列表中，如有需要可以双击消息框打开操作栏选择引用该图片

### 5. 知识库搭建服务（可选）

若需要搭建知识库，则运行：

```bash
pip install -r backend_code/requirements/knowledge_base_requirements.txt
python backend_code/knowledge_base/knowledge_api.py
```

默认监听端口 5051

### 6. 环境变量与安全（可选）

在项目根目录创建 `.env` 文件，可配置 API Key 以启用鉴权：

```env
# TTS 服务鉴权（若启用）
TTS_API_KEY=your_tts_api_key_here

# 图片生成服务鉴权（若启用）
IMG_API_KEY=your_img_api_key_here
```

如果未设置 `*_API_KEY`，则对应服务无需鉴权（仅限开发环境）。

### 7. 一键启动脚本（建议）

项目根目录下提供了两个批处理文件，用于简化开发环境的启动过程：

- `install_dependencies.bat`：安装所有后端依赖项。
- `start.bat`：启动所有前后端服务。

直接点击运行即可

## 🚀 WebUI使用技巧

- 开启新话题：点击输入框下方的“话题管理”按钮，或使用快捷键 `Ctrl+/`，可自动开启新的话题片段。
- 更改话题简介：点击输入框下方的“话题管理”按钮，除了可以点击“生成简介”调用语言模型，还可以双击简介文本直接编辑
- 调整模型参数：在“对话设置”中可为每个对话独立调整温度、Top-P 、上下文长度等等，实现不同风格的回复。
- 语音输入：点击“语音输入”按钮，在 HTTPS 或 localhost 环境下即可使用麦克风转文字（需要浏览器支持）。
- 文件上传：支持上传 `.txt`、`.md`、`.json` 等文本文件以及`.jpg`、`.png`等图片文件（需要模型支持识别图片），可直接将文件拖入网页中，内容将自动附加到消息中发送给模型。
- 消息操作：双击任意消息气泡，弹出操作栏可进行引用、删除、重新生成（AI 消息）或继续生成（AI 消息）等操作。
- 搜索功能：点击右上角圆形搜索按钮，输入关键词即可搜索所有会话的消息和会话标题，点击结果快速跳转。
- 导出与导入：在左侧历史列表点击会话旁的“···”菜单，可选择导出为 JSON 或 HTML；在列表顶部点击“导入”可恢复之前导出的 JSON 会话。
- 沉浸模式体验：默认快捷键ctrl+shift+f隐藏侧边栏和上边栏，再次按下退出。
- 快捷键自定义：在“个性化设置” -> “快捷键”面板中可修改或恢复默认快捷键。

## 📦 依赖项

### 前端

- 无额外依赖，仅需现代浏览器（支持 ES Module）。

### 后端服务（按需选择）

- Python 3.12
- FastAPI（后端接口服务必备）
- Qwen3-TTS（语音合成，flash_attention_2模式需 GPU 支持）
- ComfyUI（图片生成，独立安装）
- chromadb（向量数据库，知识库搭建必备）

更多依赖项详见 `backend_code/requirements`文件夹。

## ⚠️ 注意事项

- 本项目仅供学习和交流使用，严禁用于商业用途。
- 所有代码均由 DeepSeek AI 生成，开发者未直接参与编写。如有侵权或不当之处，请及时联系删除。
- 语音合成和图片生成服务需额外配置其他开源项目，非必需功能。
- 图片生成使用 ComfyUI 工作流，需自行安装ComfyUI和准备模型文件，文件已包含基础图片生成工作流image_gen_workflow.json，可根据需求修改。
- 强烈建议在生产环境中启用 API Key 鉴权，避免未授权访问。
- 由于使用浏览器 IndexedDB 存储数据，不支持多台设备间共享同一浏览器数据。

## 📬 联系方式

- 开发者：广州大学 2024 级学生
- 邮箱：[2083180893@qq.com](mailto:2083180893@qq.com)
- 开发时间：2026 年 3 月 31 日 ～ 至今

## 😎 开发者的话

我也在不断学习技术和开发新功能，项目会不断更新和完善，后面可能会考虑面向生产环境的搭建。如果有什么改进建议和bug问题欢迎各位添加我的联系方式提出，我会尽量回应。

感谢您的关注与支持！🎉
