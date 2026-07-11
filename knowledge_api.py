import uuid
import re
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
import chromadb
from chromadb.config import Settings
from sentence_transformers import SentenceTransformer
import PyPDF2
import docx
import threading
from concurrent.futures import ProcessPoolExecutor

app = Flask(__name__)
CORS(app)

# ========== 配置 ==========
PERSIST_DIR = "./chroma_db"
CHUNK_SIZE = 500
OVERLAP = 100
TOP_K = 3

# ========== 初始化 Chroma 客户端 ==========
client = chromadb.PersistentClient(path=PERSIST_DIR, settings=Settings(anonymized_telemetry=False))

# 元数据集合（存储知识库信息）
meta_collection = client.get_or_create_collection("kb_meta")

# 嵌入模型（主进程保留一份，用于检索接口的实时查询 embedding，单条很快不阻塞）
MODEL_PATH = './local_model/all-MiniLM-L6-v2'
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
def split_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = OVERLAP) -> list:
    """按句子边界分块"""
    if not text.strip():
        return []
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

def parse_file(file) -> str:
    """解析上传文件为纯文本"""
    filename = file.filename
    ext = filename.split('.')[-1].lower()
    if ext == 'txt':
        return file.read().decode('utf-8')
    elif ext == 'pdf':
        reader = PyPDF2.PdfReader(file)
        text = ''
        for page in reader.pages:
            page_text = page.extract_text()
            if page_text:
                text += page_text + '\n'
        return text
    elif ext == 'docx':
        doc = docx.Document(file)
        return '\n'.join([para.text for para in doc.paragraphs])
    else:
        raise ValueError(f"不支持的文件类型: {ext}")

def get_kb_collection(kb_id: str):
    """获取或创建知识库对应的 collection"""
    return client.get_or_create_collection(f"kb_{kb_id}", metadata={"hnsw:space": "cosine"})

def get_doc_meta_collection(kb_id: str):
    """获取或创建知识库的文档元数据集合（每个文档一条记录）"""
    return client.get_or_create_collection(f"kb_{kb_id}_docs")

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

@app.route('/knowledge_bases', methods=['GET'])
def list_knowledge_bases():
    """列出所有知识库（含文档数量）"""
    try:
        all_meta = meta_collection.get()
        if not all_meta['ids']:
            return jsonify({"knowledge_bases": []}), 200

        result = []
        for idx, kb_id in enumerate(all_meta['ids']):
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
        return jsonify({"knowledge_bases": result}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/knowledge_bases', methods=['POST'])
def create_knowledge_base():
    """创建新知识库"""
    data = request.get_json()
    name = data.get('name', '').strip()
    description = data.get('description', '').strip()
    if not name:
        return jsonify({"error": "知识库名称不能为空"}), 400

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
    return jsonify({
        "id": kb_id,
        "name": name,
        "description": description,
        "created_at": created_at
    }), 201

@app.route('/knowledge_bases/<kb_id>', methods=['PUT'])
def update_knowledge_base(kb_id):
    """更新知识库名称或描述"""
    data = request.get_json()
    name = data.get('name', '').strip()
    description = data.get('description', '').strip()
    # 检查是否存在
    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        return jsonify({"error": "知识库不存在"}), 404
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
    return jsonify({"id": kb_id, **new_meta}), 200

@app.route('/knowledge_bases/<kb_id>', methods=['DELETE'])
def delete_knowledge_base(kb_id):
    """删除知识库及其所有文档"""
    # 检查是否存在
    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        return jsonify({"error": "知识库不存在"}), 404
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
    return jsonify({"status": "deleted"}), 200

# ========== 文档管理 API ==========

@app.route('/knowledge_bases/<kb_id>/documents', methods=['POST'])
def upload_document(kb_id):
    """上传文档到指定知识库"""
    if 'file' not in request.files:
        return jsonify({"error": "未提供文件"}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "文件名为空"}), 400
    
    MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB
    if file.content_length > MAX_FILE_SIZE:
        return jsonify({"error": "文件过大，请上传小于 50MB 的文档"}), 413
    
    # 验证知识库是否存在
    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        return jsonify({"error": "知识库不存在"}), 404

    # 触发过期任务清理
    _cleanup_stale_tasks()

    try:
        content = parse_file(file)
        if not content.strip():
            return jsonify({"error": "文件内容为空或无法解析"}), 400

        chunks = split_text(content)
        if not chunks:
            return jsonify({"error": "分块结果为空"}), 400

        doc_id = str(uuid.uuid4())
        filename = file.filename

        # 初始化任务状态
        with tasks_lock:
            tasks[doc_id] = {
                'status': 'processing',
                'progress': 0,
                'filename': filename,
                'kb_id': kb_id
            }

        # 写入文档元数据（避免后续列表查询时遍历所有分块）
        doc_meta_coll = get_doc_meta_collection(kb_id)
        doc_meta_coll.add(
            ids=[doc_id],
            documents=[filename],
            metadatas=[{
                "filename": filename,
                "chunk_count": len(chunks),
                "uploaded_at": datetime.now().isoformat()
            }]
        )

        # 启动后台线程（embedding + 写入均在后台完成，请求立即返回）
        thread = threading.Thread(
            target=process_document_task,
            args=(kb_id, filename, doc_id, chunks)
        )
        thread.daemon = True
        thread.start()

        # 立即返回任务 ID
        return jsonify({
            "doc_id": doc_id,
            "status": "processing",
            "message": "文档已提交处理"
        }), 202  # 202 Accepted

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/task_status/<doc_id>', methods=['GET'])
def task_status(doc_id):
    with tasks_lock:
        if doc_id not in tasks:
            return jsonify({"error": "任务不存在"}), 404
        return jsonify(tasks[doc_id]), 200


@app.route('/knowledge_bases/<kb_id>/tasks', methods=['GET'])
def list_tasks(kb_id):
    """列出知识库中所有活跃的上传任务（用于页面重开时恢复进度条）"""
    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        return jsonify({"error": "知识库不存在"}), 404
    with tasks_lock:
        kb_tasks = {
            doc_id: {k: v for k, v in t.items() if k != 'kb_id'}
            for doc_id, t in tasks.items()
            if t.get('kb_id') == kb_id
        }
    return jsonify({"tasks": kb_tasks}), 200
    
@app.route('/knowledge_bases/<kb_id>/documents', methods=['GET'])
def list_documents(kb_id):
    """列出知识库中的所有文档（从文档元数据集合查询，O(1)）"""
    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        return jsonify({"error": "知识库不存在"}), 404

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
    return jsonify({"documents": documents}), 200

@app.route('/knowledge_bases/<kb_id>/documents/<doc_id>', methods=['DELETE'])
def delete_document(kb_id, doc_id):
    """删除指定文档的所有分块"""
    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        return jsonify({"error": "知识库不存在"}), 404

    kb_coll = get_kb_collection(kb_id)
    doc_meta_coll = get_doc_meta_collection(kb_id)

    # 检查文档是否存在
    if not bool(doc_meta_coll.get(ids=[doc_id])['ids']):
        return jsonify({"error": "文档不存在"}), 404

    # 直接按元数据过滤删除分块，无需先加载全部 ID
    kb_coll.delete(where={"doc_id": doc_id})
    # 同步删除文档元数据
    doc_meta_coll.delete(ids=[doc_id])

    return jsonify({"status": "deleted"}), 200

# ========== 检索 API ==========

@app.route('/knowledge_bases/<kb_id>/search', methods=['POST'])
def search_knowledge(kb_id):
    """在指定知识库中检索"""
    data = request.get_json()
    if not data or 'query' not in data:
        return jsonify({"error": "缺少 query 参数"}), 400
    query = data['query']
    top_k = data.get('top_k', TOP_K)

    existing = meta_collection.get(ids=[kb_id])
    if not existing['ids']:
        return jsonify({"error": "知识库不存在"}), 404

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
        return jsonify({"results": items}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ========== 启动服务 ==========
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5051, debug=True)