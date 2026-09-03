"""图片/二进制资源落盘存储：把 base64 data URL 存成文件，DB 里只留短引用。
文件目录默认在 backend_code/chat_store/assets（可用环境变量 ASSET_DIR 覆盖，如 D:\\ai_chat_assets）。"""
import os
import re
import base64
import hashlib
import mimetypes
from fastapi import HTTPException
from fastapi.responses import FileResponse
from dotenv import load_dotenv

load_dotenv()

ASSET_DIR = os.getenv('ASSET_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets')

MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
}

# 兼容旧 32 位 uuid 文件名 + 新 64 位 sha256 文件名
_SAFE_ID = re.compile(r'^[0-9a-f]{32,64}\.[A-Za-z0-9]{1,5}$')


def ensure_dir():
    os.makedirs(ASSET_DIR, exist_ok=True)


def _asset_id_for(data: bytes, ext: str) -> str:
    """内容寻址：同一份内容永远得到同一个文件名（sha256），避免重复文件。"""
    return hashlib.sha256(data).hexdigest() + '.' + ext


def save_data_url(data_url: str) -> str:
    """解析 data URL 并落盘（内容去重），返回 asset_id（含扩展名）。"""
    if not isinstance(data_url, str) or not data_url.startswith('data:'):
        raise HTTPException(status_code=400, detail='仅支持 data URL')
    m = re.match(r'^data:([^;,]*)?(;base64)?,(.*)$', data_url, re.S)
    if not m:
        raise HTTPException(status_code=400, detail='无效的 data URL')
    mime = (m.group(1) or 'application/octet-stream').split(';')[0].lower() or 'application/octet-stream'
    is_b64 = m.group(2) is not None
    payload = m.group(3)

    ext = MIME_EXT.get(mime, 'bin')
    if is_b64:
        try:
            data = base64.b64decode(payload)
        except Exception:
            raise HTTPException(status_code=400, detail='base64 解码失败')
    else:
        data = payload.encode('utf-8')

    asset_id = _asset_id_for(data, ext)
    path = os.path.join(ASSET_DIR, asset_id)
    if not os.path.isfile(path):
        ensure_dir()
        with open(path, 'wb') as f:
            f.write(data)
    return asset_id


def save_bytes(data: bytes, ext: str = 'bin') -> str:
    """直接保存原始二进制（大文件：视频/音频），内容去重，返回 asset_id。"""
    if not isinstance(data, (bytes, bytearray)):
        raise HTTPException(status_code=400, detail='请求体需为二进制')
    data = bytes(data)
    asset_id = _asset_id_for(data, ext)
    path = os.path.join(ASSET_DIR, asset_id)
    if not os.path.isfile(path):
        ensure_dir()
        with open(path, 'wb') as f:
            f.write(data)
    return asset_id


def get_asset_path(asset_id: str) -> str:
    """校验 asset_id（防目录穿越）并返回磁盘路径。"""
    if not isinstance(asset_id, str) or not _SAFE_ID.match(asset_id):
        raise HTTPException(status_code=400, detail='非法资源 id')
    path = os.path.join(ASSET_DIR, asset_id)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail='资源不存在')
    return path


def asset_file_response(asset_id: str) -> FileResponse:
    path = get_asset_path(asset_id)
    media_type = mimetypes.guess_type(path)[0] or 'application/octet-stream'
    return FileResponse(path, media_type=media_type)
