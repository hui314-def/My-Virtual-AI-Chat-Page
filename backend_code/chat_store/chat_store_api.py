# -*- coding: utf-8 -*-
"""聊天存储服务：健康检查 + 注册/登录/JWT + 聊天记录与设置数据 API。"""
import json
import os
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


if __name__ == '__main__':
    uvicorn.run(app, host='0.0.0.0', port=PORT)
