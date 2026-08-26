import uuid
import re
import io
import csv
import json
from datetime import datetime
from fastapi import FastAPI, Request, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import chromadb
from chromadb.config import Settings
from chromadb.api.types import Schema, FtsIndexConfig, VectorIndexConfig
from sentence_transformers import SentenceTransformer
import PyPDF2
import docx
import threading
from concurrent.futures import ProcessPoolExecutor
import os
import uvicorn

app = FastAPI(title="Knowledge Base API", version="1.0.0")

# 允许跨域请求
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ========== 配置 ==========
PERSIST_DIR = "./chroma_db"
CHUNK_SIZE = 500
OVERLAP = 100
TOP_K = 3

# ========== 初始化 Chroma 客户端 ==========
client = chromadb.PersistentClient(path=PERSIST_DIR, settings=Settings(anonymized_telemetry=False))

# 禁用 FTS（全文搜索索引），避免 trigram 分词器导致数据库膨胀
# 本项目只用向量检索 (query_embeddings)，不需要 FTS
# 同时配置向量空间为 cosine
_schema_no_fts = Schema()
_schema_no_fts.delete_index(config=FtsIndexConfig(), key="#document")
_schema_no_fts.create_index(config=VectorIndexConfig(space="cosine"))

# 元数据集合（存储知识库信息）
meta_collection = client.get_or_create_collection("kb_meta", schema=_schema_no_fts)

# 记忆向量集合（长期记忆系统的 L2 语义召回，可选增强）
mem_collection = client.get_or_create_collection("memories", schema=_schema_no_fts)

# 嵌入模型（主进程保留一份，用于检索接口的实时查询 embedding，单条很快不阻塞）
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "local_model", "all-MiniLM-L6-v2")
print("正在加载嵌入模型 all-MiniLM-L6-v2 ...")
embedder = SentenceTransformer(MODEL_PATH)
print("嵌入模型加载完成。")

# ========== 独立进程池：文档 embedding 在子进程中运行，绕过 GIL ==========
_embedding_pool = None

def _init_embedding_worker():
    """子进程初始化：复用模块导入时已加载的模型实例"""
    global _worker_embedder
    _worker_embedder = embedder  # embedder 在子进程导入模块时已加载，直接复用引用

def _encode_batch(batch_chunks: list) -> list:
    """在子进程中执行 embedding，返回 list[list[float]]"""
    global _worker_embedder
    return _worker_embedder.encode(batch_chunks).tolist()

def _get_embedding_pool():
    """延迟创建进程池（避免 import 时在子进程中递归创建）"""
    global _embedding_pool
    if _embedding_pool is None:
        _embedding_pool = ProcessPoolExecutor(max_workers=1, initializer=_init_embedding_worker)
    return _embedding_pool

# ========== 辅助函数 ==========
CODE_EXTENSIONS = {
    'py', 'js', 'jsx', 'ts', 'tsx', 'java', 'c', 'h', 'cpp', 'cc', 'cxx',
    'hpp', 'cs', 'go', 'rs', 'php', 'rb', 'swift', 'kt', 'kts', 'sql',
    'sh', 'bash', 'vue'
}


def split_code_text(text: str, chunk_size: int = CHUNK_SIZE,
                    overlap: int = OVERLAP) -> list:
    """按代码块/函数边界分块，尽量避免从一行或一个函数中间截断。"""
    lines = text.splitlines()
    blocks = []
    current = []
    brace_depth = 0

    for line in lines:
        stripped = line.strip()
        # 顶层声明通常是一个新的语义单元；保留注释和缩进代码在原块中。
        is_declaration = bool(re.match(
            r'^(async\s+def|def|class|function|export\s+(default\s+)?(async\s+)?function|'
            r'(public|private|protected|static|virtual|class|struct|namespace|func)\b)',
            stripped, re.IGNORECASE)) and (not line.startswith((' ', '\t')))
        if current and (not stripped or (is_declaration and brace_depth == 0)):
            blocks.append('\n'.join(current).strip())
            current = []
            brace_depth = 0
        if stripped or current:
            current.append(line)
        brace_depth += line.count('{') - line.count('}')
        if brace_depth < 0:
            brace_depth = 0
    if current:
        blocks.append('\n'.join(current).strip())

    chunks = []
    current_lines = []
    current_len = 0
    for block in blocks:
        block_len = len(block)
        if current_lines and current_len + block_len + 1 > chunk_size:
            chunks.append('\n'.join(current_lines))
            # 只重叠完整代码块，而不是截断字符，保留上下文且避免破坏语法。
            overlap_lines = []
            overlap_len = 0
            for old_block in reversed(current_lines):
                if overlap_len + len(old_block) + 1 > overlap:
                    break
                overlap_lines.insert(0, old_block)
                overlap_len += len(old_block) + 1
            current_lines = overlap_lines
            current_len = overlap_len
        current_lines.append(block)
        current_len += block_len + 1
        # 单个超长函数也必须落块，避免后续内容不断累积。
        if current_len >= chunk_size and len(current_lines) == 1:
            chunks.append('\n'.join(current_lines))
            current_lines, current_len = [], 0
    if current_lines:
        chunks.append('\n'.join(current_lines))
    return chunks


def split_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = OVERLAP,
               file_ext: str = '') -> list:
    """普通文本按句子分块，源代码按函数/类等代码块分块。"""
    if not text.strip():
        return []
    if file_ext.lower().lstrip('.') in CODE_EXTENSIONS:
        return split_code_text(text, chunk_size, overlap)
    sentences = re.split(r'(?<=[。！？；])', text)
    chunks = []
    current_chunk = []
    current_len = 0
    for sent in sentences:
        sent = sent.strip()
        if not sent:
            continue
        sent_len = len(sent)
        if current_len + sent_len > chunk_size and current_chunk:
            chunks.append(''.join(current_chunk))
            overlap_text = ''.join(current_chunk[-overlap:]) if overlap > 0 else ''
            current_chunk = [overlap_text + sent] if overlap_text else [sent]
            current_len = len(overlap_text + sent)
        else:
            current_chunk.append(sent)
            current_len += sent_len
    if current_chunk:
        chunks.append(''.join(current_chunk))
    return chunks

def parse_file(filename: str, content: bytes) -> str:
    """解析上传文件为纯文本，仅支持使用 UTF-8 解码，支持常见文本、CSV、JSON、PDF、DOCX 等格式"""
    ext = filename.split('.')[-1].lower()
    if ext in ('txt', 'md', 'markdown', 'log') or ext in CODE_EXTENSIONS:
        return content.decode('utf-8')
    elif ext == 'csv':
        # 将 CSV 转为易读的文本：每行用逗号分隔，并用换行分隔行
        try:
            # 尝试用 utf-8-sig 处理可能的 BOM
            csv_content = content.decode('utf-8-sig')
        except UnicodeDecodeError:
            csv_content = content.decode('latin-1')
        csv_io = io.StringIO(csv_content)
        reader = csv.reader(csv_io)
        rows = []
        for row in reader:
            rows.append(', '.join(row))
        return '\n'.join(rows)
    elif ext == 'json':
        try:
            data = json.loads(content.decode('utf-8'))
            # 将 JSON 转为格式化的字符串（保留缩进，便于阅读）
            return json.dumps(data, ensure_ascii=False, indent=2)
        except Exception:
            # 如果不是标准 JSON，也许是个 JSONL？
            return content.decode('utf-8', errors='ignore')
    elif ext == 'pdf':
        reader = PyPDF2.PdfReader(io.BytesIO(content))
        text = ''
        for page in reader.pages:
            page_text = page.extract_text()
            if page_text:
                text += page_text + '\n'
        return text
    elif ext == 'docx':
        doc = docx.Document(io.BytesIO(content))
        return '\n'.join([para.text for para in doc.paragraphs])
    else:
        raise ValueError(f"不支持的文件类型: {ext}")

def get_kb_collection(kb_id: str):
    """获取或创建知识库对应的 collection（FTS 已禁用）"""
    return client.get_or_create_collection(
        f"kb_{kb_id}",
        schema=_schema_no_fts
    )

def get_doc_meta_collection(kb_id: str):
    """获取或创建知识库的文档元数据集合（每个文档一条记录）"""
    return client.get_or_create_collection(f"kb_{kb_id}_docs", schema=_schema_no_fts)

# 任务状态存储
tasks = {}
tasks_lock = threading.Lock()
TASK_TTL_SECONDS = 3600  # 已完成/失败任务保留 1 小时后自动清理


def _cleanup_stale_tasks():
    """清理已完成/失败超过 TTL 的任务，防止内存泄漏"""
    now = datetime.now()
    with tasks_lock:
        stale_ids = [
            tid for tid, t in tasks.items()
            if t.get('status') in ('completed', 'failed')
            and t.get('finished_at')
            and (now - datetime.fromisoformat(t['finished_at'])).total_seconds() > TASK_TTL_SECONDS
        ]
        for tid in stale_ids:
            del tasks[tid]

# 后台处理函数（分批 embed + 写入，内存占用 O(BATCH_SIZE)）
def process_document_task(kb_id, filename, doc_id, chunks):
    try:
        total = len(chunks)
        kb_coll = get_kb_collection(kb_id)
        BATCH_SIZE = 100  # 每批处理块数，内存 ≈ BATCH_SIZE × 384 × 4B ≈ 150KB

        for i in range(0, total, BATCH_SIZE):
            batch_chunks = chunks[i:i+BATCH_SIZE]
            # 在独立进程中执行 embedding，绕过 GIL，主进程不阻塞
            pool = _get_embedding_pool()
            future = pool.submit(_encode_batch, batch_chunks)
            batch_embeddings = future.result()
            ids = [f"{doc_id}_{i+j}" for j in range(len(batch_chunks))]
            metadatas = [{"doc_id": doc_id, "filename": filename, "chunk_index": i+j} for j in range(len(batch_chunks))]
            kb_coll.add(
                ids=ids,
                documents=batch_chunks,
                embeddings=batch_embeddings,
                metadatas=metadatas
            )
            # 更新进度（百分比）
            progress = min(100, int((i + len(batch_chunks)) / total * 100))
            with tasks_lock:
                tasks[doc_id]['progress'] = progress

        # 完成
        with tasks_lock:
            tasks[doc_id]['status'] = 'completed'
            tasks[doc_id]['progress'] = 100
            tasks[doc_id]['finished_at'] = datetime.now().isoformat()
    except Exception as e:
        with tasks_lock:
            tasks[doc_id]['status'] = 'failed'
            tasks[doc_id]['error'] = str(e)
            tasks[doc_id]['finished_at'] = datetime.now().isoformat()
# ========== 知识库管理 API ==========

@app.get('/knowledge_bases')
def list_knowledge_bases():
    """列出所有知识库（含文档数量）+ 只读的角色记忆库"""
    try:
        all_meta = meta_collection.get()
        result = []
        for idx, kb_id in enumerate(all_meta['ids'] or []):
            meta = all_meta['metadatas'][idx]
            # 从文档元数据集合获取文档数（O(1)）
            try:
                doc_meta_coll = get_doc_meta_collection(kb_id)
                doc_count = doc_meta_coll.count()
            except Exception:
                doc_count = 0
            result.append({
                "id": kb_id,
                "name": meta.get('name', '未命名'),
                "description": meta.get('description', ''),
                "created_at": meta.get('created_at', ''),
                "document_count": doc_count
            })
        # 附加：角色记忆库（由记忆系统自动维护，只读，不可删除/改名）
        try:
            mem_count = mem_collection.count()
        except Exception:
            mem_count = 0
        result.append({
            "id": "__memory__",
            "name": "角色记忆库",
            "description": "存放各角色长期记忆的知识库，由记忆系统自动维护，不可删除或改名",
            "created_at": "",
            "document_count": mem_count,
            "is_memory": True,
            "readonly": True,
        })
        return {"knowledge_bases": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post('/knowledge_bases')
async def create_knowledge_base(request: Request):
    """创建新知识库"""
    data = await request.json()
    name = data.get('name', '').strip()
    description = data.get('description', '').strip()
    if not name:
        raise HTTPException(status_code=400, detail="知识库名称不能为空")

    kb_id = str(uuid.uuid4())
    created_at = datetime.now().isoformat()
    # 存入元数据
    meta_collection.add(
        ids=[kb_id],
        documents=[name],  # 用于搜索知识库（可选）
        metadatas=[{
            "name": name,
            "description": description,
            "created_at": created_at
        }]
    )
    # 自动创建对应的 collection（首次操作时会创建）
    get_kb_collection(kb_id)
    return JSONResponse(
        content={
            "id": kb_id,
            "name": name,
            "description": description,
            "created_at": created_at
        },
        status_code=201
    )

@app.put('/knowledge_bases/{kb_id}')
async def update_knowledge_base(kb_id: str, request: Request):
    """更新知识库名称或描述"""
    if kb_id == '__memory__':
        raise HTTPException(status_code=403, detail="角色记忆库由系统维护，不可改名")
    data = await request.json()
    name = data.get('name', '').strip()
    description = data.get('description', '').strip()
    # 检查是否存在
    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        raise HTTPException(status_code=404, detail="知识库不存在")
    # 更新元数据
    old_meta = existing['metadatas'][0]
    new_meta = {
        "name": name if name else old_meta.get('name', ''),
        "description": description if description else old_meta.get('description', ''),
        "created_at": old_meta.get('created_at', datetime.now().isoformat())
    }
    # 更新文档（Chroma 的 update 需要传入 documents）
    meta_collection.update(
        ids=[kb_id],
        documents=[new_meta['name']],
        metadatas=[new_meta]
    )
    return {"id": kb_id, **new_meta}

@app.delete('/knowledge_bases/{kb_id}')
def delete_knowledge_base(kb_id: str):
    """删除知识库及其所有文档"""
    if kb_id == '__memory__':
        raise HTTPException(status_code=403, detail="角色记忆库由系统维护，不可删除")
    # 检查是否存在
    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        raise HTTPException(status_code=404, detail="知识库不存在")
    # 删除元数据
    meta_collection.delete(ids=[kb_id])
    # 删除对应的 collection
    try:
        client.delete_collection(f"kb_{kb_id}")
    except Exception:
        pass  # 如果 collection 不存在也忽略
    # 删除文档元数据集合
    try:
        client.delete_collection(f"kb_{kb_id}_docs")
    except Exception:
        pass
    return {"status": "deleted"}

# ========== 文档管理 API ==========

@app.post('/knowledge_bases/{kb_id}/documents')
async def upload_document(kb_id: str, file: UploadFile = File(...)):
    """上传文档到指定知识库"""
    if kb_id == '__memory__':
        raise HTTPException(status_code=403, detail="角色记忆库由系统维护，不可上传文档")
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名为空")

    MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="文件过大，请上传小于 50MB 的文档")

    # 验证知识库是否存在
    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        raise HTTPException(status_code=404, detail="知识库不存在")

    # 触发过期任务清理
    _cleanup_stale_tasks()

    try:
        text = parse_file(file.filename, content)
        if not text.strip():
            raise HTTPException(status_code=400, detail="文件内容为空或无法解析")

        chunks = split_text(text, file_ext=file.filename.rsplit('.', 1)[-1])
        if not chunks:
            raise HTTPException(status_code=400, detail="分块结果为空")

        doc_id = str(uuid.uuid4())

        # 初始化任务状态
        with tasks_lock:
            tasks[doc_id] = {
                'status': 'processing',
                'progress': 0,
                'filename': file.filename,
                'kb_id': kb_id
            }

        # 写入文档元数据（避免后续列表查询时遍历所有分块）
        doc_meta_coll = get_doc_meta_collection(kb_id)
        doc_meta_coll.add(
            ids=[doc_id],
            documents=[file.filename],
            metadatas=[{
                "filename": file.filename,
                "chunk_count": len(chunks),
                "uploaded_at": datetime.now().isoformat()
            }]
        )

        # 启动后台线程（embedding + 写入均在后台完成，请求立即返回）
        thread = threading.Thread(
            target=process_document_task,
            args=(kb_id, file.filename, doc_id, chunks)
        )
        thread.daemon = True
        thread.start()

        # 立即返回任务 ID（202 Accepted）
        return JSONResponse(
            content={
                "doc_id": doc_id,
                "status": "processing",
                "message": "文档已提交处理"
            },
            status_code=202
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/task_status/{doc_id}')
def task_status(doc_id: str):
    with tasks_lock:
        if doc_id not in tasks:
            raise HTTPException(status_code=404, detail="任务不存在")
        return tasks[doc_id]


@app.get('/knowledge_bases/{kb_id}/tasks')
def list_tasks(kb_id: str):
    """列出知识库中所有活跃的上传任务（用于页面重开时恢复进度条）"""
    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        raise HTTPException(status_code=404, detail="知识库不存在")
    with tasks_lock:
        kb_tasks = {
            doc_id: {k: v for k, v in t.items() if k != 'kb_id'}
            for doc_id, t in tasks.items()
            if t.get('kb_id') == kb_id
        }
    return {"tasks": kb_tasks}

@app.get('/knowledge_bases/{kb_id}/documents')
def list_documents(kb_id: str):
    """列出知识库中的所有文档（从文档元数据集合查询，O(1)）"""
    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        raise HTTPException(status_code=404, detail="知识库不存在")

    doc_meta_coll = get_doc_meta_collection(kb_id)
    all_data = doc_meta_coll.get(include=["metadatas"])

    documents = []
    for idx, doc_id in enumerate(all_data['ids']):
        meta = all_data['metadatas'][idx] if all_data['metadatas'] else {}
        documents.append({
            "doc_id": doc_id,
            "filename": meta.get('filename', '未知'),
            "chunks": meta.get('chunk_count', 0)
        })
    return {"documents": documents}

@app.delete('/knowledge_bases/{kb_id}/documents/{doc_id}')
def delete_document(kb_id: str, doc_id: str):
    """删除指定文档的所有分块"""
    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        raise HTTPException(status_code=404, detail="知识库不存在")

    kb_coll = get_kb_collection(kb_id)
    doc_meta_coll = get_doc_meta_collection(kb_id)

    # 检查文档是否存在
    if not bool(doc_meta_coll.get(ids=[doc_id])['ids']):
        raise HTTPException(status_code=404, detail="文档不存在")

    # 直接按元数据过滤删除分块，无需先加载全部 ID
    kb_coll.delete(where={"doc_id": doc_id})
    # 同步删除文档元数据
    doc_meta_coll.delete(ids=[doc_id])

    return {"status": "deleted"}

# ========== 检索 API ==========

@app.post('/knowledge_bases/{kb_id}/search')
async def search_knowledge(kb_id: str, request: Request):
    """在指定知识库中检索"""
    data = await request.json()
    if not data or 'query' not in data:
        raise HTTPException(status_code=400, detail="缺少 query 参数")
    query = data['query']
    top_k = data.get('top_k', TOP_K)

    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        raise HTTPException(status_code=404, detail="知识库不存在")

    kb_coll = get_kb_collection(kb_id)
    try:
        query_embedding = embedder.encode([query]).tolist()
        results = kb_coll.query(
            query_embeddings=query_embedding,
            n_results=top_k,
            include=["documents", "metadatas", "distances"]
        )
        documents = results['documents'][0] if results['documents'] else []
        metadatas = results['metadatas'][0] if results['metadatas'] else []
        distances = results['distances'][0] if results['distances'] else []

        items = []
        for doc, meta, dist in zip(documents, metadatas, distances):
            items.append({
                "content": doc,
                "filename": meta.get('filename', '未知'),
                "score": 1 - dist / 2
            })
        return {"results": items}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ========== 记忆向量接口(L2 语义召回,长期记忆系统的可选增强) ==========

@app.post('/memories/upsert')
async def upsert_memory(request: Request):
    """写入/更新一条记忆的 embedding(前端提取新记忆后调用)"""
    data = await request.json()
    mid = data.get('id')
    content = data.get('content', '')
    chat_id = data.get('chatId', '')
    if not mid or not content:
        raise HTTPException(status_code=400, detail="缺少 id 或 content")
    try:
        embedding = embedder.encode([content]).tolist()
        mem_collection.upsert(
            ids=[mid],
            documents=[content],
            embeddings=embedding,
            metadatas=[{"chatId": str(chat_id)}]
        )
        return {"status": "ok", "id": mid}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post('/memories/search')
async def search_memories(request: Request):
    """按语义检索记忆,返回命中的记忆 id 与相似度分数"""
    data = await request.json()
    query = data.get('query', '')
    chat_id = data.get('chatId', '')
    top_k = data.get('top_k', 5)
    if not query:
        raise HTTPException(status_code=400, detail="缺少 query")
    try:
        embedding = embedder.encode([query]).tolist()
        where = {"chatId": str(chat_id)} if chat_id not in (None, '') else None
        results = mem_collection.query(
            query_embeddings=embedding,
            n_results=top_k,
            where=where,
            include=["distances"]
        )
        ids = results['ids'][0] if results['ids'] else []
        distances = results['distances'][0] if results['distances'] else []
        items = [{"id": mid, "score": 1 - d / 2} for mid, d in zip(ids, distances)]
        return {"results": items}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete('/memories/{memory_id}')
def delete_memory(memory_id: str):
    """删除单条记忆的 embedding"""
    try:
        mem_collection.delete(ids=[memory_id])
        return {"status": "deleted"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete('/memories/by-chat/{chat_id}')
def delete_memories_by_chat(chat_id: str):
    """按对话删除该角色的全部记忆 embedding(删除对话时级联)"""
    try:
        mem_collection.delete(where={"chatId": str(chat_id)})
        return {"status": "deleted"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ========== 启动服务 ==========
if __name__ == '__main__':
    uvicorn.run(app, host='0.0.0.0', port=5051)
