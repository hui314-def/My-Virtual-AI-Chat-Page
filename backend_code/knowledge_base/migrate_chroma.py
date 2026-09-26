# -*- coding: utf-8 -*-
"""向量库迁移/合并工具（一次性历史工具）。

背景：knowledge_api 早期用 `PERSIST_DIR = "./chroma_db"` 这种**相对路径**，从仓库根目录启动
得到 `<仓库>/chroma_db`，从 backend_code/knowledge_base 启动得到 `<...>/chroma_db`，
于是会出现两个内容不同的向量库 —— 换启动方式就像「知识库/记忆向量消失了」。

完整修复：knowledge_api 已改为锚定脚本目录的绝对路径 + 可用 `CHROMA_DIR` 环境变量覆盖，
本脚本用于把历史遗留的另一个库合并到规范位置。

注意：仓库根目录的旧库已经在迁移后删除；如果你**又**发现了一个孤立的库，把它的路径传给 --from。

用法：
    # 预览（把 --from 的库合并进规范位置，默认来源已不存在时会直接提示无需迁移）
    python backend_code/knowledge_base/migrate_chroma.py --from <旧库目录>

    # 实际执行（结束后会把旧目录改名保留）
    python backend_code/knowledge_base/migrate_chroma.py --from <旧库目录> --apply
"""
import argparse
import os
import shutil
import sys
import time

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))

import chromadb
from chromadb.config import Settings


def open_client(path):
    return chromadb.PersistentClient(path=path, settings=Settings(anonymized_telemetry=False))


def copy_records(coll, new_coll, got, records, suffix=''):
    """把若干记录写入目标集合，返回实际写入条数。"""
    if not records:
        return 0
    new_coll.upsert(
        ids=[r['id'] + suffix for r in records],
        documents=[(r.get('document') if r.get('document') is not None else '') for r in records],
        embeddings=[r['embedding'] for r in records],
        metadatas=[(r.get('metadata') if r.get('metadata') is not None else {}) for r in records],
    )
    return len(records)


def fetch_all(coll, n):
    """分批取回集合全部记录（id / document / embedding / metadata）。"""
    out = []
    BATCH = 256
    for i in range(0, n, BATCH):
        got = coll.get(limit=BATCH, offset=i, include=['documents', 'embeddings', 'metadatas'])
        ids = got.get('ids') or []
        docs = got.get('documents') or []
        embs = got.get('embeddings')
        metas = got.get('metadatas') or []
        for j, rid in enumerate(ids):
            out.append({
                'id': rid,
                'document': docs[j] if j < len(docs) else '',
                'embedding': (embs[j] if embs is not None and j < len(embs) else None),
                'metadata': metas[j] if j < len(metas) else {},
            })
    return [r for r in out if r['embedding'] is not None]


def main():
    ap = argparse.ArgumentParser(description='合并/迁移 chroma 向量库')
    ap.add_argument('--from', dest='src', default=os.path.join(REPO_ROOT, 'chroma_db'),
                    help='来源库目录（默认 <仓库根>/chroma_db，通常已不存在）')
    ap.add_argument('--to', dest='dst', default=os.path.join(HERE, 'chroma_db'),
                    help='目标库目录（默认 backend_code/knowledge_base/chroma_db）')
    ap.add_argument('--apply', action='store_true', help='实际执行；不加则只预览')
    args = ap.parse_args()

    src, dst = os.path.abspath(args.src), os.path.abspath(args.dst)
    print('=' * 72)
    print(f'来源: {src}')
    print(f'目标: {dst}')
    print(f'模式: {"执行" if args.apply else "预览（加 --apply 才会写入）"}')
    print('=' * 72)

    if not os.path.isdir(src):
        print('来源目录不存在，无需迁移。')
        return 0
    if src == dst:
        print('来源与目标相同，无需迁移。')
        return 0
    if not os.path.exists(os.path.join(src, 'chroma.sqlite3')):
        print('来源目录不是 chroma 库（缺少 chroma.sqlite3）。')
        return 0

    src_client = open_client(src)
    dst_client = open_client(dst)

    src_colls = sorted(c.name for c in src_client.list_collections())
    dst_colls = set(c.name for c in dst_client.list_collections())
    print(f'来源集合 {len(src_colls)} 个，目标集合 {len(dst_colls)} 个\n')

    moved = total_records = 0
    for name in src_colls:
        coll = src_client.get_collection(name)
        n = coll.count()
        if n == 0:
            print(f'  {name}: 空集合，跳过')
            continue
        # 逐条读出（带向量），再决定怎么落进目标
        records = fetch_all(coll, n)
        if not records:
            print(f'  {name}: 无可用向量记录，跳过')
            continue

        if name not in dst_colls:
            print(f'  {name} ({len(records)} 条) → 新增到目标')
            if args.apply:
                new_coll = dst_client.get_or_create_collection(name)
                total_records += copy_records(coll, new_coll, None, records)
            moved += 1
            continue

        # 同名集合：按 id 合并，避免覆盖目标数据（kb_meta 这类关键集合必须合并而不能改名）
        dst_coll = dst_client.get_collection(name)
        dst_got = dst_coll.get(include=['documents', 'embeddings', 'metadatas'])
        dst_ids = set(dst_got.get('ids') or [])
        fresh = [r for r in records if r['id'] not in dst_ids]
        dup = [r for r in records if r['id'] in dst_ids]   # id 冲突：加后缀保留两份，绝不静默覆盖
        suffix = f'_moved_{int(time.time())}'
        print(f'  {name} ({len(records)} 条) → 合并进目标（新增 {len(fresh)}，'
              f'同 id 冲突 {len(dup)} → 加后缀 {suffix} 保留）')
        if args.apply:
            total_records += copy_records(coll, dst_coll, None, fresh)
            total_records += copy_records(coll, dst_coll, None, dup, suffix=suffix)
        moved += 1

    if not args.apply:
        print('\n预览完成。确认无误后加 --apply 执行。')
        return 0

    print(f'\n合并完成：处理 {moved} 个集合，写入 {total_records} 条记录。')
    backup = f'{src}_old_{int(time.time())}'
    try:
        os.rename(src, backup)
        print(f'旧目录已改名保留: {backup}')
        print(f'确认无误后可手动删除: rmdir /s /q "{backup}"')
    except Exception as e:
        print(f'⚠ 旧目录改名失败（可手动删除 {src}）: {e}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
