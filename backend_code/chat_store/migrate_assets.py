# -*- coding: utf-8 -*-
"""把 MySQL 聊天 JSON 里的 base64 图片迁移到文件系统，替换为 asset://<id> 引用。

递归扫描整个 JSON：任何字符串字段（settings、message.text、images、file.content、
quoteRef.imageUrls、modelInputText …）中的 data URI 都会被导出成文件并替换。

用法：
  python migrate_assets.py            # 仅预览（dry-run），不写库
  python migrate_assets.py --apply    # 真正执行迁移并写回
"""
import sys
import json
import re
import pymysql
from dotenv import load_dotenv
import os
import assets

load_dotenv()

DRY_RUN = '--apply' not in sys.argv

DATA_URI_RE = re.compile(r'data:[^\s\)"\'<>]+')

stats = {'chats': 0, 'whole_uri': 0, 'embedded_uri': 0}


def is_data_uri(v):
    return isinstance(v, str) and v.startswith('data:')


def save_uri(uri):
    try:
        return 'asset://' + assets.save_data_url(uri)
    except Exception:
        return uri


def transform(value):
    """递归处理：返回 (新值, 是否变更)。"""
    changed = False
    if isinstance(value, dict):
        for k in list(value.keys()):
            nv, c = transform(value[k])
            if c:
                value[k] = nv
                changed = True
        return value, changed
    if isinstance(value, list):
        for i in range(len(value)):
            nv, c = transform(value[i])
            if c:
                value[i] = nv
                changed = True
        return value, changed
    if isinstance(value, str):
        if value.startswith('data:'):
            stats['whole_uri'] += 1
            return save_uri(value), True
        if 'data:' in value:
            cnt = [0]
            def repl(m):
                cnt[0] += 1
                return save_uri(m.group(0))
            nv = DATA_URI_RE.sub(repl, value)
            if cnt[0]:
                stats['embedded_uri'] += cnt[0]
                return nv, True
    return value, changed


conn = pymysql.connect(host=os.getenv('DB_HOST', '127.0.0.1'), port=int(os.getenv('DB_PORT', '3306')),
                       user=os.getenv('DB_USER', 'root'), password=os.getenv('DB_PASSWORD', ''),
                       database=os.getenv('DB_NAME', 'ai_chat_sync'), charset='utf8mb4',
                       cursorclass=pymysql.cursors.DictCursor)
with conn.cursor() as cur:
    cur.execute('SELECT id, data FROM chats')
    rows = cur.fetchall()

changed_rows = []
for row in rows:
    try:
        d = json.loads(row['data'])
    except Exception:
        continue
    if not isinstance(d, dict):
        continue
    _, c = transform(d)
    if c:
        stats['chats'] += 1
        changed_rows.append((json.dumps(d, ensure_ascii=False), row['id']))

print('=' * 50)
print('模式:', 'DRY-RUN（不写库）' if DRY_RUN else 'APPLY（写库）')
print('资源目录:', assets.ASSET_DIR)
print('-' * 50)
for k, v in stats.items():
    print(f'  {k}: {v}')
print(f'需更新的会话数: {len(changed_rows)}')

if not DRY_RUN and changed_rows:
    with conn.cursor() as cur:
        for data_str, cid in changed_rows:
            cur.execute('UPDATE chats SET data=%s WHERE id=%s', (data_str, cid))
    conn.commit()
    print('已写入数据库。')
conn.close()
