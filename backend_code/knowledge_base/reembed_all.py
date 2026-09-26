"""换嵌入模型后的向量重建工具。

适用场景：把 `KB_EMBED_MODEL` / `KB_EMBED_MODEL_DIR` 换成另一个模型后，旧向量维度与新模型
不一致，检索会报错。本脚本读取**已存在的向量集合里的原文**（文档 chunk / 记忆 content），
用**新模型**重新计算向量并覆盖原集合，因此不需要重新上传文档、也不会动 MySQL 里的记忆原文。

用法（先停掉 knowledge_api 服务，避免两个进程同时写同一个 chroma_db）：

    # 预览：只报告各集合的规模与维度，不做任何改动
    python backend_code/knowledge_base/reembed_all.py --dry-run

    # 实际重建（默认只重建记忆向量，安全）
    python backend_code/knowledge_base/reembed_all.py

    # 连同知识库文档向量一起重建
    python backend_code/knowledge_base/reembed_all.py --include-kb

    # 只重建某个知识库
    python backend_code/knowledge_base/reembed_all.py --include-kb --kb-id 420c7322-...

不重建 `kb_meta` / `kb_xxx_docs`：它们是元数据集合，本身不存文本向量。
"""
import argparse
import os
import sys
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

from dotenv import load_dotenv
load_dotenv(os.path.join(BASE_DIR, '..', '..', '.env'))
load_dotenv()

# 复用 knowledge_api 的模型配置（会打印模型信息并做维度检查）
import knowledge_api as api

BATCH = 64


def rebuild_collection(coll, label, dry_run=False):
    """把集合内所有文本用新模型重算向量。

    ⚠️ chromadb 1.5 的集合在创建时**锁定向量维度**，往旧集合写新维度会直接报
    InvalidArgumentError。所以流程必须是「读出原文 → 删除集合 → 按新维度重建 → 重新写入」。
    原文（documents）保存在集合里，删除集合不会丢；重建期间不影响其它集合。
    返回 (处理条数, 新集合句柄, 是否成功)。
    """
    total = coll.count()
    if total == 0:
        print(f"  {label}: 空集合，跳过")
        return 0, coll, True

    got = coll.get(include=['documents', 'embeddings', 'metadatas'])
    ids = got.get('ids') or []
    docs = got.get('documents') or []
    embs = got.get('embeddings')
    metas = got.get('metadatas') or []

    old_dim = len(embs[0]) if embs is not None and len(embs) else None
    name = coll.name
    print(f"  {label}: {total} 条，旧维度 {old_dim} → 新维度 {api._EMBED_DIM}")

    if dry_run:
        print(f"    [dry-run] 不写入（重建时会先删除集合 {name} 再按新维度创建）")
        return total, coll, True

    if old_dim == api._EMBED_DIM:
        print(f"    （维度已一致，仍会重算，保证向量来自同一模型）")

    # 1) 删除旧集合并按新维度重建（维度被锁定，无法原地改）
    client = getattr(api, 'client', None)
    if client is None:
        print(f"    ✗ 无法获取 chroma client，跳过")
        return 0, coll, False
    try:
        client.delete_collection(name)
    except Exception as e:
        print(f"    ✗ 删除旧集合失败：{e}")
        return 0, coll, False
    new_coll = client.get_or_create_collection(name, schema=api._schema_no_fts)

    # 2) 分批重算并写回
    done = 0
    t0 = time.time()
    for i in range(0, total, BATCH):
        chunk_ids = ids[i:i + BATCH]
        chunk_docs = [d if d is not None else '' for d in docs[i:i + BATCH]]
        chunk_metas = [m if m is not None else {} for m in metas[i:i + BATCH]]
        if not chunk_ids:
            continue
        vectors = api.embed_texts(chunk_docs)          # 文档侧编码：不加查询前缀
        new_coll.upsert(ids=chunk_ids, documents=chunk_docs,
                        embeddings=vectors, metadatas=chunk_metas)
        done += len(chunk_ids)
        pct = done * 100 // total
        print(f"    {done}/{total} ({pct}%)  {time.time() - t0:.1f}s", end='\r', flush=True)
    print(f"    {done}/{total} 完成，用时 {time.time() - t0:.1f}s")
    return done, new_coll, True


def main():
    ap = argparse.ArgumentParser(description='用当前嵌入模型重建向量')
    ap.add_argument('--dry-run', action='store_true', help='只报告，不写入')
    ap.add_argument('--include-kb', action='store_true', help='同时重建知识库文档向量')
    ap.add_argument('--kb-id', default='', help='只重建指定知识库（隐含 --include-kb）')
    args = ap.parse_args()

    print('=' * 70)
    print(f"嵌入模型: {api.EMBED_MODEL_NAME}")
    print(f"模型路径: {api.MODEL_PATH}")
    print(f"向量维度: {api._EMBED_DIM}")
    print(f"查询前缀: {api.QUERY_PREFIX or '（无）'}")
    print('=' * 70)

    report = api.check_embedding_dimension()
    print('当前集合维度状态:')
    for k, v in report.items():
        print(f"  {k}: {v}")

    print('\n开始重建:')
    n, new_coll, ok = rebuild_collection(api.mem_collection, 'memories（长期记忆向量）', args.dry_run)
    if ok and new_coll is not api.mem_collection:
        api.mem_collection = new_coll          # 集合已就地重建，刷新模块级句柄

    if args.include_kb or args.kb_id:
        kbs = api.kb_ids_and_names()
        if not kbs:
            print('  （没有知识库，跳过）')
        for kid, name in kbs:
            if args.kb_id and kid != args.kb_id:
                continue
            # 知识库主集合（文档 chunk）
            coll = api.get_kb_collection(kid)
            n, unused, ok = rebuild_collection(coll, f"知识库「{name}」({kid[:8]})", args.dry_run)
            # 文档元数据集合 kb_xxx_docs 同样被锁定在旧维度，需一并重建
            if ok:
                docs_coll = api.get_doc_meta_collection(kid)
                rebuild_collection(docs_coll, f"  文档元数据 kb_{kid[:8]}_docs", args.dry_run)
        if not args.kb_id:
            # kb_meta 自身也存向量，维度不一致会让「知识库列表」相关请求异常
            meta_coll = api.client.get_or_create_collection('kb_meta', schema=api._schema_no_fts)
            _, new_meta, ok = rebuild_collection(meta_coll, '知识库清单 kb_meta', args.dry_run)
            if ok and not args.dry_run and new_meta is not meta_coll:
                api.meta_collection = new_meta

    print('\n完成。请重启 knowledge_api 服务。')
    print('提示: 记忆只需重建向量，原文仍在浏览器 IndexedDB 与 MySQL 中；')
    print('      若 dimension 检查仍显示 mismatch，可执行')
    print('      curl -X POST http://localhost:5051/admin/reset-collections  后用前端「立即同步」补齐。')


if __name__ == '__main__':
    main()
