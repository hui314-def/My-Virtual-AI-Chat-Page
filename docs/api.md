# 后端 API 接口文档

> 适用版本：v1.0.0（2026-08 整理）
> 本文档覆盖项目全部 4 类后端服务（语音合成为千问 / MOSS 两个实现版本）、共 40 个 HTTP 接口。
> 所有服务均为 FastAPI，自带 Swagger 交互文档（启动后访问 `http://<host>:<port>/docs`）；本文档补充业务语义、鉴权说明、请求/响应示例与错误码。

---

## 0. 服务总览

| 服务 | 文件 | 默认端口 | 鉴权 | 说明 |
|---|---|---|---|---|
| 聊天存储（云同步） | `backend_code/chat_store/chat_store_api.py` | 8001 | JWT（`Authorization: Bearer`） | 账号体系、聊天记录、设置、资源文件 |
| 知识库 | `backend_code/knowledge_base/knowledge_api.py` | 5051 | 无 | 知识库/文档管理、语义检索、记忆向量 |
| 语音合成（千问） | `backend_code/tts/tts_api.py` | 5000 | `X-API-Key`（可选） | Qwen3-TTS 合成与音色克隆 |
| 语音合成（MOSS） | `backend_code/tts/moss_tts_server.py` | 5000 | `X-API-Key`（可选） | MOSS 合成（非流式 + SSE 流式）与音色克隆 |
| 图片/音频生成 | `backend_code/image_gen/image_gen_api.py` | 5050 | `X-API-Key`（可选） | ComfyUI 文生图、音乐生成 |

> ⚠️ 千问 TTS 与 MOSS TTS 均监听 5000 端口，**两者只能同时启动一个**；推荐 MOSS 版（README 建议）。

### 0.1 通用约定

- **错误响应**：FastAPI 标准格式 `{"detail": "<错误信息>"}`；image_gen 服务个别接口返回 `{"error": "<信息>"}`。
- **CORS**：全部服务允许跨域（`allow_origins=*`），浏览器直连可用。
- **内容编码**：chat_store 启用了 GZip（响应 ≥1000 字节自动压缩），客户端需带 `Accept-Encoding: gzip` 或由 HTTP 库自动处理。
- **认证方式**：
  - **JWT**（chat_store）：请求头 `Authorization: Bearer <token>`；令牌 HS256 签名，有效期 **30 天**；除 `/api/health`、`/api/auth/register`、`/api/auth/login`、`/api/assets/{id}` 外均需登录。
  - **API Key**（tts / image_gen）：请求头 `X-API-Key: <key>`；对应环境变量（`TTS_API_KEY` / `IMG_API_KEY`）**为空时免鉴权**（仅限开发环境，生产务必设置）。

---

## 1. 聊天存储服务（chat_store，端口 8001）

### 1.1 健康检查

#### `GET /api/health` · 无需登录

检查服务与数据库状态。

```json
// 200
{"status": "ok", "db": "ok"}
// 数据库异常时
{"status": "degraded", "db": "error"}
```

### 1.2 账号体系

#### `POST /api/auth/register` · 注册

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `username` | string | ✅ | 1~64 字符 |
| `password` | string | ✅ | ≥4 位 |

```json
// 201 Created
{"token": "<JWT>", "username": "alice"}
```

错误码：`400` 参数为空/过长/密码过短；`409` 用户名已存在。

#### `POST /api/auth/login` · 登录

请求体同注册。响应：

```json
// 200
{"token": "<JWT>", "username": "alice"}
```

错误码：`401` 用户名或密码错误。

#### `GET /api/auth/me` · 当前用户信息（需登录）

```json
// 200
{"username": "alice"}
```

错误码：`401` 未登录/凭证失效；`404` 用户不存在。

#### `PUT /api/auth/username` · 修改用户名（需登录，需密码确认）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `username` | string | ✅ | 新用户名（1~64 字符） |
| `password` | string | ✅ | 当前密码 |

```json
// 200
{"username": "alice_new"}
```

> 数据按 `user_id` 关联，改名不影响云端聊天记录。

错误码：`400`、`401` 密码错误、`404`、`409` 用户名被占用。

#### `PUT /api/auth/password` · 修改密码（需登录，需原密码确认）

| 参数 | 类型 | 必填 |
|---|---|---|
| `old_password` | string | ✅ |
| `new_password` | string | ✅（≥4 位） |

```json
// 200
{"ok": true}
```

#### `DELETE /api/auth/account` · 注销账户（需登录，需密码确认）

| 参数 | 类型 | 必填 |
|---|---|---|
| `password` | string | ✅ |

```json
// 200
{"deleted": true}
```

> 该用户的聊天记录与设置由数据库外键**级联删除**；云端资源文件不自动清理。

### 1.3 资源文件

#### `POST /api/assets` · 上传图片（data URL，需登录）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `dataUrl` | string | ✅ | `data:image/...;base64,...` 格式 |

```json
// 200
{"assetId": "a1b2c3...", "url": "/api/assets/a1b2c3..."}
```

#### `POST /api/assets/raw` · 上传原始二进制（视频/音频等大文件，需登录）

请求体**直接是文件内容**，`Content-Type` 决定扩展名（如 `video/mp4`、`audio/mpeg`）。响应同上 `{assetId, url}`。

#### `GET /api/assets/{asset_id}` · 读取资源（**匿名可读**）

返回文件本体，`<img>/<video>/<audio>` 可直接引用。`asset_id` 为随机不可猜字符串；**局域网内匿名可读**，如需更强鉴权请自行扩展。

### 1.4 聊天记录

> chat 对象结构即前端 IndexedDB 中保存的完整会话对象（`{id, title, date, topics: [...], currentTopicIndex, settings, pinned}`）。

#### `GET /api/chats` · 获取全部会话（需登录）

```json
// 200
{"chats": [
  {"id": 123, "title": "...", "topics": [], "settings": {}, "_serverUpdatedAt": "2026-08-28T12:00:00"}
]}
```

每项内嵌 `_serverUpdatedAt`（服务端最后更新时间，ISO 格式），按更新时间倒序。

#### `PUT /api/chats` · 全量替换（需登录）

请求体 `{"chats": [chat对象, ...]}` → `200 {"count": N}`。对应前端"保存全部会话"。

#### `PUT /api/chats/{chat_id}` · 单会话 upsert（需登录）

请求体为完整 chat 对象 → `200 {"updatedAt": "<ISO>"}`。

#### `PATCH /api/chats/{chat_id}` · 话题级增量合并（需登录）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `meta` | object | 可选 | 字段级覆盖；`settings` 子对象深合并 |
| `topics` | array | 可选 | 按 `id` 替换已存在话题 / 追加新话题 |
| `removeTopicIds` | array | 可选 | 删除指定 id 的话题 |

```json
// 请求示例：更新元数据 + 替换一个话题 + 删除一个话题
{
  "meta": {"title": "新标题", "settings": {"temperature": 0.8}},
  "topics": [{"id": 2, "name": "话题 2", "messages": []}],
  "removeTopicIds": [3]
}
```

```json
// 200
{"updatedAt": "2026-08-28T12:00:00"}
```

> 服务端自动校验 `currentTopicIndex` 越界并重置为 0。此接口为**长会话增量同步**的核心：只传变化的元数据 + 当前话题，避免整包重传。

#### `DELETE /api/chats/{chat_id}` · 删除会话（需登录）

```json
// 200
{"deleted": true}
```

### 1.5 设置

#### `GET /api/settings` · 获取全局设置（需登录）

```json
// 200
{"settings": {"temperature": 0.7, "theme": "dark"}, "updatedAt": "2026-08-28T12:00:00"}
// 未保存过时
{"settings": {}, "updatedAt": null}
```

#### `PUT /api/settings` · 覆盖全局设置（需登录）

请求体 `{"settings": {...}}` → `200 {"updatedAt": "<ISO>"}`。

---

## 2. 知识库服务（knowledge_base，端口 5051）

> **无鉴权**，直接开放（依赖网络隔离保护）。
> 内置一个**只读的「角色记忆库」**（id 恒为 `__memory__`），由长期记忆系统自动维护，不可改名/删除/上传文档；其检索走独立的 `/memories/*` 接口。

### 2.1 知识库管理

#### `GET /knowledge_bases` · 列出全部知识库

```json
// 200
{"knowledge_bases": [
  {"id": "uuid", "name": "我的库", "description": "", "created_at": "2026-08-01T00:00:00", "document_count": 3},
  {"id": "__memory__", "name": "角色记忆库", "description": "...", "created_at": "", "document_count": 12, "is_memory": true, "readonly": true}
]}
```

#### `POST /knowledge_bases` · 创建知识库

| 参数 | 类型 | 必填 |
|---|---|---|
| `name` | string | ✅（非空） |
| `description` | string | 可选 |

```json
// 201 Created
{"id": "uuid", "name": "我的库", "description": "", "created_at": "2026-08-28T00:00:00"}
```

#### `PUT /knowledge_bases/{kb_id}` · 更新名称/描述

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 可选 | 留空则保持原值 |
| `description` | string | 可选 | 留空则保持原值 |

错误码：`403` 角色记忆库不可改名；`404` 知识库不存在。

#### `DELETE /knowledge_bases/{kb_id}` · 删除知识库及全部文档

错误码：`403` 角色记忆库不可删除；`404` 不存在。

### 2.2 文档管理

#### `POST /knowledge_bases/{kb_id}/documents` · 上传文档（multipart/form-data）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | File | ✅ | 支持 docx / pdf / txt / csv / 代码文件等；**≤50MB** |

上传后**立即返回任务 ID（202）**，解析/分块/向量化在后台线程执行：

```json
// 202 Accepted
{"doc_id": "uuid", "status": "processing", "message": "文档已提交处理"}
```

错误码：`400` 文件名空/内容空/分块为空；`403` 角色记忆库；`404` 知识库不存在；`413` 超过 50MB。

> 分块参数：`CHUNK_SIZE=500` 字符、`OVERLAP=100`；代码文件按函数/类边界智能分块。

#### `GET /task_status/{doc_id}` · 查询上传处理进度

```json
// 200
{"status": "processing", "progress": 42, "filename": "a.pdf", "kb_id": "uuid"}
// 完成后
{"status": "completed", "progress": 100, "filename": "a.pdf", "kb_id": "uuid", "finished_at": "2026-08-28T12:00:00"}
// 失败
{"status": "failed", "progress": 0, "error": "...", "finished_at": "..."}
```

错误码：`404` 任务不存在（任务为内存态，服务重启后丢失）。

#### `GET /knowledge_bases/{kb_id}/tasks` · 列出该库全部活跃任务（页面刷新恢复进度条用）

```json
// 200
{"tasks": {"<doc_id>": {"status": "processing", "progress": 42, "filename": "a.pdf"}}}
```

#### `GET /knowledge_bases/{kb_id}/documents` · 列出库内文档

```json
// 200
{"documents": [{"doc_id": "uuid", "filename": "a.pdf", "chunks": 12}]}
```

#### `DELETE /knowledge_bases/{kb_id}/documents/{doc_id}` · 删除文档及其全部分块

错误码：`404` 知识库或文档不存在。

### 2.3 检索

#### `POST /knowledge_bases/{kb_id}/search` · 语义检索

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | ✅ | 查询文本 |
| `top_k` | int | 可选 | 返回条数，默认 **3** |

```json
// 200
{"results": [
  {"content": "分块文本...", "filename": "a.pdf", "score": 0.87}
]}
```

> `score = 1 - 余弦距离/2`，越接近 1 越相关。对 `__memory__` 调用返回 `{"results": []}`（记忆检索走 2.4）。

### 2.4 记忆向量接口（长期记忆 L2 语义召回，可选增强）

#### `POST /memories/upsert` · 写入/更新一条记忆的向量

| 参数 | 类型 | 必填 |
|---|---|---|
| `id` | string | ✅ |
| `content` | string | ✅ |
| `chatId` | string | 可选 |

```json
// 200
{"status": "ok", "id": "mem_xxx"}
```

#### `POST /memories/search` · 语义检索记忆

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | ✅ | |
| `chatId` | string | 可选 | 传入则只在该对话（角色）的记忆中检索 |
| `top_k` | int | 可选 | 默认 **5** |

```json
// 200
{"results": [{"id": "mem_xxx", "score": 0.92}]}
```

#### `DELETE /memories/{memory_id}` · 删除单条记忆向量

#### `DELETE /memories/by-chat/{chat_id}` · 按对话删除全部记忆向量（删除对话时级联）

两者均返回 `{"status": "deleted"}`。

---

## 3. 语音合成服务（tts，端口 5000）

> 千问版（`tts_api.py`）与 MOSS 版（`moss_tts_server.py`）**共用端口 5000，二选一启动**。接口签名基本一致，差异见各小节标注。
> 鉴权：`X-API-Key: <key>`；环境变量 `TTS_API_KEY` 为空则免鉴权。
> 音频输出均为 **WAV（16bit PCM）**；服务端按 `text + voiceId` 哈希缓存，相同请求直接返回缓存（缓存上限 5GB / 1000 文件 / 7 天自动清理）。

### 3.1 `GET /voices` · 可用音色列表

```json
// 200
{"voices": ["default", "萝莉", "御姐"]}
```

> MOSS 版音色来自 Mosi 平台账号（登录后自动同步）；千问版来自本地 `音色库/` 目录的 `.pkl` 音色克隆文件。

### 3.2 `POST /tts` · 语音合成（非流式）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | ✅ | 要朗读的文本 |
| `voiceId` | string | 可选 | 音色名，默认 `default` |

响应：`audio/wav` 二进制流（缓存命中同样返回 WAV）。

错误码：`400` text 为空 / 音色不存在（无默认音色兜底时）；`401` API Key 错误（启用鉴权时）；`500` 生成失败；MOSS 版上游失败返回 `502`。

```bash
# 示例（curl）
curl -X POST http://localhost:5000/tts \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_key" \
  -d '{"text": "你好呀", "voiceId": "default"}' \
  -o out.wav
```

### 3.3 `POST /tts/stream` · 流式合成（SSE，仅 MOSS 版）

| 参数 | 类型 | 必填 |
|---|---|---|
| `text` | string | ✅ |
| `voiceId` | string | 可选（默认 `default`） |

响应为 `text/event-stream`，事件载荷为 JSON：

```
data: {"type":"start","sampleRate":48000,"channels":1,"bitDepth":16}
data: {"type":"audio","data":"<base64 PCM 分片>"}
data: {"type":"audio","data":"<base64 PCM 分片>"}
data: {"type":"done"}
```

错误事件：`{"type":"error","message":"..."}`。前端边收 PCM 边用 Web Audio API 播放；若已有缓存则直接返回完整 WAV（非 SSE）。

### 3.4 `POST /clone_voice` · 克隆音色（multipart/form-data）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `voice_name` | string | ✅ | 仅限字母/数字/下划线/点/横线 |
| `audio` | File | ✅ | 参考音频（≥数秒清晰人声） |
| `ref_text` | string | ✅ | 音频对应的文本（用于对齐） |

```json
// 200（MOSS 版）
{"message": "音色克隆成功", "voice_name": "我的音色"}
```

> 千问版返回体为生成结果本身（详见 Swagger）；克隆成功后即可在 `/tts` 中通过 `voiceId` 使用。
> 错误码：`400` 名称非法/缺文件；`401` 未授权；`502` 上游克隆失败；`500` 内部错误。

---

## 4. 图片/音频生成服务（image_gen，端口 5050）

> 依赖 [ComfyUI](http://127.0.0.1:8188) 运行中。接口为**同步阻塞**（内部轮询 ComfyUI，图片最多等 120s、音频最多等 180s）。
> 鉴权：`X-API-Key: <key>`；环境变量 `IMG_API_KEY` 为空则免鉴权。

### 4.1 `POST /generate_image` · 文生图

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `prompt` | string | ✅ | 图片描述 |
| `negative` | string | 可选 | 负面提示词 |
| `size` | string | 可选 | `WIDTHxHEIGHT`，默认 `1024x1024`，宽高 64~4096 |
| `count` | int | 可选 | 1~8，默认 1（工作流批处理上限 4） |
| `model` | string | 可选 | 默认 `flux` |

```json
// 200
{"images": ["<base64 PNG 图片>", "..."]}
```

错误码：`400` prompt 为空 / size 格式错误 / count 越界 / 宽高超范围；`401` 未授权；`500` ComfyUI 错误或超时。

```bash
# 示例（curl）
curl -X POST http://localhost:5050/generate_image \
  -H "Content-Type: application/json" \
  -d '{"prompt": "星空下的鲸鱼，梦幻风格", "size": "1024x1024"}' \
  | jq -r '.images[0]' | base64 -d > out.png
```

### 4.2 `POST /generate_audio` · 生成背景音乐（Stable Audio）

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `positive_prompt` | string | ✅ | 音乐描述（建议英文，可由前端「AI 生成英文提示词」辅助） |
| `negative_prompt` | string | 可选 | |
| `duration` | int | 可选 | 1~120 秒，默认 40 |
| `seed` | int | 可选 | 随机种子（不传则随机） |

响应：`audio/mpeg` 二进制（MP3），`Content-Disposition: attachment`。

错误码：`400` prompt 为空 / duration 越界；`401` 未授权；`500` 生成失败。

---

## 5. 常见问题

- **哪些接口需要登录？** chat_store 除 `GET /api/health`、注册、登录、`GET /api/assets/{asset_id}` 外均需 `Authorization: Bearer <JWT>`；知识库无需鉴权；tts / image_gen 看是否设置了对应 `*_API_KEY`。
- **JWT 失效了怎么办？** 有效期 30 天，过期后重新 `POST /api/auth/login`。
- **知识库文档上传后一直 processing？** 后台线程正在做 embedding，可用 `GET /task_status/{doc_id}` 轮询进度；服务重启后任务记录丢失（内存态），重新上传即可。
- **TTS 请求很慢？** 首次合成需加载模型；之后命中缓存秒回。缓存目录 `backend_code/tts/音频缓存/`，可手动清理。
- **生图超时？** 图片生成等待上限 120 秒（ComfyUI 排队+出图时间），高峰期可适当调大 ComfyUI 并发或使用更快的模型。
