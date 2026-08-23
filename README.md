# 虚拟AI · 暗夜对话 · 灵境投影

一款沉浸式 AI 伴侣聊天网页，融合科幻视觉与深度对话体验，支持角色定制、语音合成、图片生成及多话题管理。

## 📖 项目简介

本项目旨在打造一个不同于普通大模型对话平台的沉浸式 AI 交互空间。在这里，你可以与拥有独立人格的 AI 角色进行深入交流，体验透明气泡、动态背景和数字图腾带来的“灵境”氛围。

项目具有较高的自由度：你可以自由设定角色的名字、人设、头像和对话背景图，调整模型参数（温度、上下文长度等）以生成多样化的回复，可以让 AI 的回复通过语音合成朗读出来，并支持语音输入，打造属于你的专属对话角色人格。对话过程上，你不仅可以直接操作消息框 ，遇到不满意的回复可以删除和重新生成，还可以使用话题管理功能组织对话脉络，随时切换话题场景，并将精彩对话导出为 JSON 或 HTML 文件保存或分享。

## ✨ 主要特性

- 🎭 **角色定制** — 自定义 AI 角色的名称、性格设定、头像和开场白，打造专属灵魂伴侣。
- 🖼️ **聊天背景** — 可上传自定义背景图，支持静态背景（图片）和动态背景（视频），配合透明玻璃消息气泡，营造沉浸式视觉氛围。
- 🎵 **背景音乐** — 可上传自定义背景音乐，增强沉浸式听觉体验。
- 🎙️ **语音交互** — 支持语音输入（Web Speech API）及语音合成（TTS），让对话更自然。
- 🧠 **模型兼容** — 原生支持 Ollama 和 OpenAI 兼容 API（如 GPT、DeepSeek 等），可自由切换模型。
- 📚 **话题管理** — 通过“新话题”分隔不同对话片段，便于回溯与切换，支持自动/手动生成话题简介。
- 💾 **数据持久化** — 聊天记录与设置自动保存在浏览器 IndexedDB 中，重启不丢失；支持接入 MySQL 后端实现多设备云同步；图片/视频/音频等资源以文件形式存储（`asset://` 短引用），聊天数据只存引用不存二进制。
- 🔍 **全局搜索** — 快速搜索历史消息和会话，一键跳转定位。
- 📤 **导入/导出** — 支持导出单会话为 JSON 或 HTML 文件，也可导入之前导出的 JSON 会话。
- 🤝 **sillytavern支持** — 接入sillytavern生态，支持v2角色卡片的导入
- 🖼️ **AI 图片生成** — 集成 ComfyUI 后端，可根据描述生成图片并自动插入对话。
- 🌓 **暗夜/明亮主题** — 原生支持深色、扩展支持浅色主题，适配不同使用场景。
- ⌨️ **快捷键支持** — 内置常用快捷键（新建对话、新话题、聚焦输入等），且可自定义。
- ✨ **消息框操作** — 双击消息框弹出操作栏，支持消息的删除、引用等功能，实现和微信一样的消息管理方式。
- 📖 **知识库搭建** — 支持docx，pdf，txt等格式的文档上传到知识库和多知识库管理操作。

## 🔧 安装与配置

### 1. 前端网页（必须）

将本项目文件下载到本地，确保目录结构包含以下主要文件（部分示例）：

```plaintext
├── 提示词模板/
├── backend_code/
|   ├── chat_store/
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

安装 [Ollama](https://ollama.com/) 并拉取模型（如 gemma2、llama3 等）。

设置环境变量以允许跨域请求（重启 Ollama 生效）：

```bash
# Windows
set OLLAMA_ORIGINS=*

# Linux/macOS
export OLLAMA_ORIGINS=*
```

默认 Ollama API 地址为 `http://localhost:11434`（指向本地端口），可在网页“个性化设置”中根据实际情况修改。

#### OpenAI 兼容 API

支持任何兼容 OpenAI 格式的 API（如 DeepSeek、智谱等），设置中支持一键切换模型厂商，仅需一次配置 API-Key 即可随意切换，也可以支持在设置中填写自定义 Base URL。

### 3. 语音合成服务（建议）

若需要语音朗读功能，可选择启动 `tts_api.py`或`moss_tts_api.py`，建议安装python3.12

#### 千问语音合成服务

安装以下依赖项

```bash
pip install -r backend_code/requirements/tts_requirements.txt
python backend_code/tts/tts_api.py
```

默认监听端口 5000，支持音色克隆（通过上传参考音频），支持 API Key 鉴权（通过 `.env` 设置 `TTS_API_KEY`）。项目文件夹里已经有我克隆好的音色文件，免费使用

首次启动会自动加载 Qwen3-TTS 模型（可提前下载模型权重，参考 [Qwen3-TTS 官方文档](https://modelscope.cn/models/Qwen/Qwen3-TTS-12Hz-1.7B-Base/summary)）。编辑.env文件输入模型路径QWEN_MODEL_DIR

#### MOSS 语音合成服务（推荐）

需要登录 [Mossland](https://mossland.studio/)平台获取 API Key，并在 `.env` 文件中设置 `MOSS_API_KEY`。安装依赖并启动服务：

```bash
pip install -r backend_code/requirements/moss_tts_requirements.txt
python backend_code/tts/moss_tts_api.py
```

默认监听端口 5000，需要设置 API Key 鉴权（通过 `.env` 设置 `MOSS_API_KEY`）。

⚠️ 注意事项：mossland每天有100免费积分额度，当天积分次日清零。所以，第二天使用前需要登录mossland平台签到获取

### 4. 图片生成服务（可选）

若需要 AI 生图功能，需安装 [ComfyUI](https://github.com/Comfy-Org/ComfyUI)，同时需要开启ComfyUI的开发者模式，并将工作流文件（`image_gen_workflow.json`）放置于项目目录下（示例工作流，可按需修改和替换），自行准备模型文件。随后启动图片生成 API：

```bash
pip install -r backend_code/requirements/image_gen_requirements.txt
python backend_code/image_gen/image_gen_api.py
```

默认监听端口 5050，并支持 API Key 鉴权（通过 `.env` 设置 `IMG_API_KEY`）。

⚠️ 注意事项：生成后的图片放在消息框内但不会加入到语言模型的上下文对话列表中，如有需要可以双击消息框打开操作栏选择引用该图片（需要视觉模型支持）

### 5. 知识库搭建服务（可选）

若需要搭建知识库，则运行：

```bash
pip install -r backend_code/requirements/knowledge_base_requirements.txt
python backend_code/knowledge_base/knowledge_api.py
```

默认监听端口 5051

### 6. 聊天存储服务（云同步，MySQL）（建议）

若需要**跨设备同步聊天记录与全局设置**、防止浏览器数据丢失，可启动聊天存储服务（需要安装 [MySQL](https://dev.mysql.com/downloads/)）：

```bash
pip install pymysql PyJWT bcrypt python-dotenv
python backend_code/chat_store/chat_store_api.py
```

默认监听端口 8001。启动前在项目根目录 `.env` 配置：

```env
# ===== 聊天存储服务（MySQL 云同步）=====
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的MySQL密码
DB_NAME=ai_chat_sync
JWT_SECRET=随意一段随机字符串
CHAT_STORE_PORT=8001

# ===== 图片/视频/音频资源目录（文件系统存储，建议放 D 盘等大容量磁盘）=====
ASSET_DIR=D:\code3\AI聊天网站\backend_code\chat_store\assets
```

启动后打开网页，点击**左上角头像**即可注册/登录。登录后：

- 聊天记录与全局设置（模型参数、主题、用户名等）自动同步到 MySQL，支持多设备共享；
- 同步采用**话题级增量**（`PATCH /api/chats/{id}`）：发消息 / 改设置只上传「元数据 + 当前话题」+ 变化的元数据，长会话不再整包重传；
- **API Key 不会上传**，每台设备需各自填写；
- 未登录时仍用本地 IndexedDB/localStorage，断网也能看旧记录；
- 支持账户管理：**修改用户名 / 修改密码 / 注销账户**（在「个性化设置 → 账号·云同步」中操作）。

#### 图片 / 视频 / 音频资源存储（文件系统 + URL 引用）

- 图片、背景视频、背景音乐等二进制资源**不存入 MySQL**，而是落盘到 `ASSET_DIR` 目录（默认 `backend_code/chat_store/assets`，通过 `.env` 的 `ASSET_DIR` 修改，建议放 D 盘等大容量磁盘）；
- 聊天数据里只存 `asset://<id>` 短引用，渲染时自动解析为 `http://<主机>:8001/api/assets/<id>`，浏览器按 URL 缓存，跨设备（局域网内）均可访问；
- 接口：
  - `POST /api/assets` — 图片上传（data URL，需登录）；
  - `POST /api/assets/raw` — 视频 / 音频等大文件二进制直传（需登录，Content-Type 决定扩展名）；
  - `GET /api/assets/{id}` — 匿名读取（`<img>`/`<video>`/`<audio>` 直接引用，id 为随机不可猜）；
- **旧数据迁移**（把库里已有的 base64 图片批量导出成文件并替换为引用）：

  ```bash
  python backend_code/chat_store/migrate_assets.py          # 先预览
  python backend_code/chat_store/migrate_assets.py --apply  # 实际执行
  ```

- 注意：视频 / 音频的**历史本地文件**（此前存在浏览器 IndexedDB 中）无法迁移到服务端，但**新上传的**都会进后端、实现跨设备；资源接口当前为局域网内匿名可读（随机 id 防猜），如需更强鉴权可自行扩展。

### 7. 环境变量与安全（可选）

在项目根目录创建 `.env` 文件，可配置 API Key 以启用鉴权：

```env
# TTS 服务鉴权（若启用）
TTS_API_KEY=your_tts_api_key_here

# 图片生成服务鉴权（若启用）
IMG_API_KEY=your_img_api_key_here

# 图片/视频/音频资源存储目录（聊天存储服务使用，默认 backend_code/chat_store/assets）
ASSET_DIR=backend_code\chat_store\assets
```

如果未设置 `*_API_KEY`，则对应服务无需鉴权（仅限开发环境）。

### 8. 一键启动脚本（建议）

项目根目录下提供了两个批处理文件，用于简化项目依赖的部署过程：

- `install_dependencies.bat`：安装所有后端依赖项。
- `start.bat`：启动所有前后端服务。

直接点击运行即可

## 🚀 WebUI使用技巧

- 开启新话题：点击输入框下方的“话题管理”按钮，或使用快捷键 `Ctrl+/`，可自动开启新的话题片段。
- 更改话题简介：点击输入框下方的“话题管理”按钮打开的弹窗中，每个话题卡片除了可以点击“生成简介”调用语言模型，还可以直接双击简介文本进行编辑
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
- MySQL（聊天存储服务，云同步必备）

更多依赖项详见 `backend_code/requirements`文件夹。

## ⚠️ 注意事项

- 本项目仅供学习和交流使用，严禁用于商业用途。
- 所有代码均由 DeepSeek AI 生成，开发者未直接参与编写。如有侵权或不当之处，请及时联系删除。
- 语音合成、图片生成和后端数据库服务需额外配置其他开源项目或服务。
- 强烈建议在生产环境中启用 API Key 鉴权，避免未授权访问。
- 资源文件（图片/视频/音频）存储在 `ASSET_DIR` 目录（默认 `backend_code/chat_store/assets`），**删除该目录会导致历史图片/背景视频/音乐无法显示**，请定期备份；资源接口当前为局域网内匿名可读（随机 id），如需更强安全请自行添加鉴权。

## 📬 联系方式

- 开发者：广州大学 2024 级本科生
- 邮箱：[2083180893@qq.com](mailto:2083180893@qq.com)
- 开发时间：2026 年 3 月 31 日 ～ 至今

## 😎 开发者的话

感谢deepseek智能体，让我拥有了零代码编写程序的能力，我会将我的想法不断落地。同时我也在不断学习技术和开发新功能，项目会不断更新和完善，后面可能会考虑面向生产环境的搭建。如果有什么改进建议和bug问题欢迎各位添加我的联系方式提出，我会尽量回应。

感谢您的关注与支持！🎉
