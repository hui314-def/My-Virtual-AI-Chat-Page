"""聊天存储服务：健康检查 + 注册/登录/JWT + 聊天记录、长期记忆与设置数据 API。"""
import json
import os
import time
import uvicorn
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

import db
from auth import hash_password, verify_password, create_token, get_current_user_id
import assets

load_dotenv()

app = FastAPI(title='Chat Store API', version='1.0.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=False,
    allow_methods=['*'],
    allow_headers=['*'],
)
# 聊天文本压缩率很高（尤其长文本），压缩后传输体积可降 5~10 倍
app.add_middleware(GZipMiddleware, minimum_size=1000)

PORT = int(os.getenv('CHAT_STORE_PORT', '8001'))

# 启动即建库建表（幂等）；失败不阻断进程，/api/health 会反映 db 状态
try:
    db.init_schema()
    print('[chat_store] 数据库初始化完成')
except Exception as e:
    print('[chat_store] 数据库初始化失败:', e)


# ============ 工具 ============
def _iso(dt_obj):
    return dt_obj.isoformat(timespec='seconds') if dt_obj is not None else None


def _parse_json(value):
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (bytes, bytearray)):
        value = value.decode('utf-8')
    return json.loads(value)


# ============ 健康检查 ============
@app.get('/api/health')
def health():
    try:
        conn = db.get_conn()
        with conn.cursor() as cur:
            cur.execute('SELECT 1')
        conn.close()
        db_ok = True
    except Exception:
        db_ok = False
    return {'status': 'ok' if db_ok else 'degraded', 'db': 'ok' if db_ok else 'error'}


# ============ 鉴权 ============
@app.post('/api/auth/register')
async def register(request: Request):
    data = await request.json()
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    if not username or not password:
        raise HTTPException(status_code=400, detail='用户名和密码不能为空')
    if len(username) > 64:
        raise HTTPException(status_code=400, detail='用户名过长')
    if len(password) < 4:
        raise HTTPException(status_code=400, detail='密码至少 4 位')

    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT id FROM users WHERE username=%s', (username,))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail='用户名已存在')
            cur.execute(
                'INSERT INTO users (username, password_hash) VALUES (%s, %s)',
                (username, hash_password(password))
            )
            user_id = cur.lastrowid
    finally:
        conn.close()

    return JSONResponse(
        {'token': create_token(user_id), 'username': username},
        status_code=201,
    )


@app.post('/api/auth/login')
async def login(request: Request):
    data = await request.json()
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT id, password_hash FROM users WHERE username=%s', (username,))
            row = cur.fetchone()
    finally:
        conn.close()

    if not row or not verify_password(password, row['password_hash']):
        raise HTTPException(status_code=401, detail='用户名或密码错误')
    return {'token': create_token(row['id']), 'username': username}


@app.get('/api/auth/me')
def me(user_id: int = Depends(get_current_user_id)):
    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT username FROM users WHERE id=%s', (user_id,))
            row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail='用户不存在')
    return {'username': row['username']}


@app.put('/api/auth/username')
async def change_username(request: Request, user_id: int = Depends(get_current_user_id)):
    """修改用户名（需当前密码确认）。数据按 user_id 关联，改名不影响云端数据。"""
    data = await request.json()
    new_username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    if not new_username:
        raise HTTPException(status_code=400, detail='新用户名不能为空')
    if len(new_username) > 64:
        raise HTTPException(status_code=400, detail='用户名过长')
    if not password:
        raise HTTPException(status_code=400, detail='请输入当前密码以确认')

    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT password_hash FROM users WHERE id=%s', (user_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail='用户不存在')
            if not verify_password(password, row['password_hash']):
                raise HTTPException(status_code=401, detail='密码错误')
            cur.execute(
                'SELECT id FROM users WHERE username=%s AND id<>%s',
                (new_username, user_id),
            )
            if cur.fetchone():
                raise HTTPException(status_code=409, detail='用户名已被占用')
            cur.execute('UPDATE users SET username=%s WHERE id=%s', (new_username, user_id))
    finally:
        conn.close()
    return {'username': new_username}


@app.put('/api/auth/password')
async def change_password(request: Request, user_id: int = Depends(get_current_user_id)):
    """修改密码（需原密码确认）。"""
    data = await request.json()
    old_password = data.get('old_password') or ''
    new_password = data.get('new_password') or ''
    if not old_password or not new_password:
        raise HTTPException(status_code=400, detail='请输入原密码和新密码')
    if len(new_password) < 4:
        raise HTTPException(status_code=400, detail='新密码至少 4 位')

    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT password_hash FROM users WHERE id=%s', (user_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail='用户不存在')
            if not verify_password(old_password, row['password_hash']):
                raise HTTPException(status_code=401, detail='原密码错误')
            cur.execute(
                'UPDATE users SET password_hash=%s WHERE id=%s',
                (hash_password(new_password), user_id),
            )
    finally:
        conn.close()
    return {'ok': True}


@app.delete('/api/auth/account')
async def delete_account(request: Request, user_id: int = Depends(get_current_user_id)):
    """注销账户（需当前密码确认）。chats / user_settings 由外键级联删除。"""
    data = await request.json()
    password = data.get('password') or ''
    if not password:
        raise HTTPException(status_code=400, detail='请输入当前密码以确认')

    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT password_hash FROM users WHERE id=%s', (user_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail='用户不存在')
            if not verify_password(password, row['password_hash']):
                raise HTTPException(status_code=401, detail='密码错误')
            cur.execute('DELETE FROM users WHERE id=%s', (user_id,))
    finally:
        conn.close()
    return {'deleted': True}


# ============ 图片/二进制资源（文件系统 + URL 引用） ============
@app.post('/api/assets')
async def upload_asset(request: Request, user_id: int = Depends(get_current_user_id)):
    """上传一张图（data URL）→ 落盘 → 返回 assetId / url。"""
    data = await request.json()
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail='请求体需为对象')
    data_url = data.get('dataUrl')
    asset_id = assets.save_data_url(data_url)
    return {'assetId': asset_id, 'url': f'/api/assets/{asset_id}'}


@app.post('/api/assets/raw')
async def upload_asset_raw(request: Request, user_id: int = Depends(get_current_user_id)):
    """上传原始二进制（视频/音频等大文件，请求体即文件内容，Content-Type 决定扩展名）。"""
    body = await request.body()
    mime = (request.headers.get('content-type') or '').split(';')[0].strip().lower()
    ext = assets.MIME_EXT.get(mime, 'bin')
    asset_id = assets.save_bytes(body, ext)
    return {'assetId': asset_id, 'url': f'/api/assets/{asset_id}'}


@app.get('/api/assets/{asset_id}')
def read_asset(asset_id: str):
    """读取资源文件（局域网内匿名可读，便于 <img> 直接引用；asset_id 为随机不可猜）。"""
    return assets.asset_file_response(asset_id)


# ============ 聊天记录 ============
@app.get('/api/chats')
def list_chats(user_id: int = Depends(get_current_user_id)):
    """返回该用户全部 chat 对象，每项内嵌 _serverUpdatedAt。"""
    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT chat_id, data, updated_at FROM chats WHERE user_id=%s ORDER BY updated_at DESC',
                (user_id,),
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    chats = []
    for r in rows:
        chat = _parse_json(r['data']) or {}
        if isinstance(chat, dict):
            chat['_serverUpdatedAt'] = _iso(r['updated_at'])
            chats.append(chat)
    return {'chats': chats}


@app.put('/api/chats')
async def replace_chats(request: Request, user_id: int = Depends(get_current_user_id)):
    """全量替换（对应前端 saveAllChats）。"""
    body = await request.json()
    if not isinstance(body, dict) or not isinstance(body.get('chats'), list):
        raise HTTPException(status_code=400, detail='请求体需为 {chats: [...]}')
    chats = body['chats']

    conn = db.get_conn()
    conn.autocommit(False)
    try:
        with conn.cursor() as cur:
            cur.execute('DELETE FROM chats WHERE user_id=%s', (user_id,))
            for chat in chats:
                cid = str(chat.get('id')) if isinstance(chat, dict) else ''
                cur.execute(
                    'INSERT INTO chats (user_id, chat_id, data) VALUES (%s, %s, %s)',
                    (user_id, cid, json.dumps(chat, ensure_ascii=False)),
                )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return {'count': len(chats)}


@app.put('/api/chats/{chat_id}')
async def upsert_chat(chat_id: str, request: Request, user_id: int = Depends(get_current_user_id)):
    """单会话 upsert。"""
    chat = await request.json()
    if not isinstance(chat, dict):
        raise HTTPException(status_code=400, detail='请求体需为 chat 对象')

    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'REPLACE INTO chats (user_id, chat_id, data) VALUES (%s, %s, %s)',
                (user_id, chat_id, json.dumps(chat, ensure_ascii=False)),
            )
            cur.execute(
                'SELECT updated_at FROM chats WHERE user_id=%s AND chat_id=%s',
                (user_id, chat_id),
            )
            row = cur.fetchone()
    finally:
        conn.close()
    return {'updatedAt': _iso(row['updated_at']) if row else None}


@app.patch('/api/chats/{chat_id}')
async def patch_chat(chat_id: str, request: Request, user_id: int = Depends(get_current_user_id)):
    """话题级增量合并：meta（字段级覆盖）+ topics（按 id 替换/新增）+ removeTopicIds。"""
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail='请求体需为对象')

    meta = body.get('meta')
    topics = body.get('topics')
    remove_topic_ids = body.get('removeTopicIds')
    if meta is not None and not isinstance(meta, dict):
        raise HTTPException(status_code=400, detail='meta 需为对象')
    if topics is not None and not isinstance(topics, list):
        raise HTTPException(status_code=400, detail='topics 需为数组')
    if remove_topic_ids is not None and not isinstance(remove_topic_ids, list):
        raise HTTPException(status_code=400, detail='removeTopicIds 需为数组')

    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT data FROM chats WHERE user_id=%s AND chat_id=%s',
                (user_id, chat_id),
            )
            row = cur.fetchone()
            chat = _parse_json(row['data']) if row else {}
            if not isinstance(chat, dict):
                chat = {}

            # 1) meta 字段级覆盖；settings 深合并，避免冲掉未变字段
            if meta:
                meta = dict(meta)  # 拷贝，避免 pop 影响后续
                if isinstance(meta.get('settings'), dict) and isinstance(chat.get('settings'), dict):
                    settings = meta.pop('settings')
                    chat.update(meta)
                    chat['settings'] = {**chat['settings'], **settings}
                else:
                    chat.update(meta)

            # 2) topics 按 id 替换或追加
            topics_list = chat.get('topics')
            if not isinstance(topics_list, list):
                topics_list = []
                chat['topics'] = topics_list
            by_id = {}
            for i, t in enumerate(topics_list):
                if isinstance(t, dict) and t.get('id') is not None:
                    by_id[str(t['id'])] = i
            if topics:
                for t in topics:
                    if not isinstance(t, dict) or t.get('id') is None:
                        continue
                    key = str(t['id'])
                    idx = by_id.get(key)
                    if idx is not None:
                        topics_list[idx] = t
                    else:
                        by_id[key] = len(topics_list)
                        topics_list.append(t)

            # 3) removeTopicIds 删除指定话题
            if remove_topic_ids:
                remove_keys = {str(tid) for tid in remove_topic_ids if tid is not None}
                chat['topics'] = [
                    x for x in topics_list
                    if not (isinstance(x, dict) and x.get('id') is not None and str(x['id']) in remove_keys)
                ]

            # 4) 校验 currentTopicIndex 越界
            n_topics = len(chat.get('topics', []))
            cti = chat.get('currentTopicIndex')
            if n_topics == 0 or not isinstance(cti, int) or cti < 0 or cti >= n_topics:
                chat['currentTopicIndex'] = 0

            cur.execute(
                'REPLACE INTO chats (user_id, chat_id, data) VALUES (%s, %s, %s)',
                (user_id, chat_id, json.dumps(chat, ensure_ascii=False)),
            )
            cur.execute(
                'SELECT updated_at FROM chats WHERE user_id=%s AND chat_id=%s',
                (user_id, chat_id),
            )
            updated = cur.fetchone()
    finally:
        conn.close()
    return {'updatedAt': _iso(updated['updated_at']) if updated else None}


@app.delete('/api/chats/{chat_id}')
def delete_chat(chat_id: str, user_id: int = Depends(get_current_user_id)):
    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute('DELETE FROM chats WHERE user_id=%s AND chat_id=%s', (user_id, chat_id))
    finally:
        conn.close()
    return {'deleted': True}


# ============ 设置 ============
@app.get('/api/settings')
def get_settings(user_id: int = Depends(get_current_user_id)):
    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT data, updated_at FROM user_settings WHERE user_id=%s', (user_id,))
            row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return {'settings': {}, 'updatedAt': None}
    return {'settings': _parse_json(row['data']) or {}, 'updatedAt': _iso(row['updated_at'])}


@app.put('/api/settings')
async def put_settings(request: Request, user_id: int = Depends(get_current_user_id)):
    body = await request.json()
    if not isinstance(body, dict) or not isinstance(body.get('settings'), dict):
        raise HTTPException(status_code=400, detail='请求体需为 {settings: {...}}')
    settings = body['settings']

    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'REPLACE INTO user_settings (user_id, data) VALUES (%s, %s)',
                (user_id, json.dumps(settings, ensure_ascii=False)),
            )
            cur.execute('SELECT updated_at FROM user_settings WHERE user_id=%s', (user_id,))
            row = cur.fetchone()
    finally:
        conn.close()
    return {'updatedAt': _iso(row['updated_at']) if row else None}


# ============ 长期记忆（跨设备同步） ============
# 冲突消解：以记忆记录自带的 updatedAt(ms) 为权威时间戳，遵循「最新写入胜出」。
# 服务端时间戳不比请求新时直接跳过 → 重复上传幂等（离线补传 / 断线重放安全）。
# 删除走**墓碑**(deleted=1)，客户端据此清理本地副本，避免离线删除后被重新拉回。
MEMORY_MAX_BATCH = 500          # 单次批量上传上限
MEMORY_TOMBSTONE_KEEP_DAYS = 90  # 墓碑保留期，超期清理（长期未上线的设备可能复活旧记忆，可接受）

def _memory_updated_at(record):
    """取记录内嵌的客户端时间戳（毫秒）；缺失时返回 0（会被已有记录击败）。"""
    try:
        v = record.get('updatedAt')
        return int(v) if v is not None else 0
    except (TypeError, ValueError):
        return 0


def _memory_row(row):
    """DB 行 → 客户端记忆记录（内嵌 _serverUpdatedAt）。"""
    record = _parse_json(row['data'])
    if not isinstance(record, dict):
        record = {}
    record['_serverUpdatedAt'] = _iso(row['updated_at'])
    return record


@app.get('/api/memories')
def list_memories(user_id: int = Depends(get_current_user_id)):
    """返回该用户的全部记忆记录，`deleted: true` 的为删除墓碑。"""
    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT id, chat_id, data, deleted, updated_at FROM memories WHERE user_id=%s',
                (user_id,),
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    memories = []
    tombstones = []
    for r in rows:
        if r['deleted']:
            tombstones.append({
                'id': r['id'],
                'updatedAt': _memory_updated_at(_parse_json(r['data']) or {}),
                'deletedAt': _iso(r['updated_at']),
            })
        else:
            memories.append(_memory_row(r))
    return {'memories': memories, 'tombstones': tombstones}


@app.put('/api/memories')
async def upsert_memories(request: Request, user_id: int = Depends(get_current_user_id)):
    """批量 upsert（写穿目标）。请求体 `{memories: [...]}`，返回各条结果的统计。"""
    body = await request.json()
    if not isinstance(body, dict) or not isinstance(body.get('memories'), list):
        raise HTTPException(status_code=400, detail='请求体需为 {memories: [...]}')
    records = body['memories']
    if len(records) > MEMORY_MAX_BATCH:
        raise HTTPException(status_code=400, detail=f'单次最多上传 {MEMORY_MAX_BATCH} 条')

    accepted, skipped, ids = 0, 0, []
    for rec in records:
        if not isinstance(rec, dict) or not rec.get('id'):
            continue
        ids.append(str(rec['id']))

    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            # 先取已有记录的 updatedAt，做「最新胜出」比较（避免被旧数据覆盖）
            existing = {}
            if ids:
                placeholders = ','.join(['%s'] * len(ids))
                cur.execute(
                    f'SELECT id, data, deleted FROM memories WHERE user_id=%s AND id IN ({placeholders})',
                    (user_id, *ids),
                )
                for r in cur.fetchall():
                    existing[r['id']] = (_memory_updated_at(_parse_json(r['data']) or {}), bool(r['deleted']))

            for rec in records:
                if not isinstance(rec, dict) or not rec.get('id'):
                    continue
                mid = str(rec['id'])
                incoming = _memory_updated_at(rec)
                prev = existing.get(mid)
                if prev is not None:
                    prev_ts, prev_deleted = prev
                    # 库里的墓碑比请求新 → 保持删除态，不接受这条复活写入
                    if prev_deleted and prev_ts >= incoming:
                        skipped += 1
                        continue
                    if prev_ts > incoming:
                        skipped += 1
                        continue
                chat_id = rec.get('chatId')
                chat_id = '' if chat_id is None else str(chat_id)
                cur.execute(
                    'REPLACE INTO memories (id, user_id, chat_id, data, deleted) VALUES (%s, %s, %s, %s, 0)',
                    (mid, user_id, chat_id, json.dumps(rec, ensure_ascii=False)),
                )
                accepted += 1
    finally:
        conn.close()
    return {'accepted': accepted, 'skipped': skipped}


def _mark_memories_deleted(user_id, memory_ids):
    """把若干记忆标记为删除墓碑（幂等）。返回处理条数。"""
    now_ms = int(time.time() * 1000)
    count = 0
    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            for mid in memory_ids:
                mid = str(mid)
                cur.execute(
                    'SELECT data, deleted FROM memories WHERE user_id=%s AND id=%s',
                    (user_id, mid),
                )
                row = cur.fetchone()
                if row:
                    data = _parse_json(row['data']) or {}
                    data['updatedAt'] = now_ms      # 墓碑时间戳须最新，才能击败其它设备的旧副本
                    cur.execute(
                        'UPDATE memories SET deleted=1, data=%s WHERE user_id=%s AND id=%s',
                        (json.dumps(data, ensure_ascii=False), user_id, mid),
                    )
                else:
                    # 服务端从未见过这条记忆（纯本地新建就被删）→ 也留墓碑，
                    # 否则离线设备上线后仍会上传并「复活」它
                    data = {'id': mid, 'updatedAt': now_ms, 'deleted': True}
                    cur.execute(
                        'REPLACE INTO memories (id, user_id, chat_id, data, deleted) VALUES (%s, %s, %s, %s, 1)',
                        (mid, user_id, '', json.dumps(data, ensure_ascii=False)),
                    )
                count += 1
    finally:
        conn.close()
    return {'deleted': count}


@app.delete('/api/memories')
def delete_memories_bulk(ids: str = '', user_id: int = Depends(get_current_user_id)):
    """批量删除：`?ids=a,b,c`（写墓碑）。"""
    id_list = [x.strip() for x in (ids or '').split(',') if x.strip()]
    if not id_list:
        raise HTTPException(status_code=400, detail='请通过 ?ids= 指定要删除的记忆 id')
    return _mark_memories_deleted(user_id, id_list)


@app.delete('/api/memories/{memory_id}')
def delete_memory(memory_id: str, user_id: int = Depends(get_current_user_id)):
    """删除单条记忆（写墓碑；不存在也返回成功，保证幂等）。"""
    return _mark_memories_deleted(user_id, [memory_id])


@app.delete('/api/memories/by-chat/{chat_id}')
def delete_memories_by_chat(chat_id: str, user_id: int = Depends(get_current_user_id)):
    """按角色域删除该对话的全部记忆（删除对话时级联）。写墓碑而非物理删除。"""
    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT id, data FROM memories WHERE user_id=%s AND chat_id=%s AND deleted=0',
                (user_id, str(chat_id)),
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    if not rows:
        return {'deleted': 0}
    return _mark_memories_deleted(user_id, [r['id'] for r in rows])


@app.delete('/api/memories-cleanup')
def cleanup_memory_tombstones(user_id: int = Depends(get_current_user_id)):
    """清理超过保留期的墓碑（可选维护接口）。"""
    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'DELETE FROM memories WHERE user_id=%s AND deleted=1 '
                'AND updated_at < DATE_SUB(NOW(3), INTERVAL %s DAY)',
                (user_id, MEMORY_TOMBSTONE_KEEP_DAYS),
            )
            removed = cur.rowcount
    finally:
        conn.close()
    return {'removed': removed}


if __name__ == '__main__':
    uvicorn.run(app, host='0.0.0.0', port=PORT)
