"""注册 / 登录 / JWT 签发与鉴权依赖。"""
import os
import datetime as dt
import bcrypt
import jwt
from fastapi import Header, HTTPException
from dotenv import load_dotenv

load_dotenv()

JWT_SECRET = os.getenv('JWT_SECRET', 'dev-secret-change-me')
JWT_ALGORITHM = 'HS256'
TOKEN_EXPIRE_DAYS = 30


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode('utf-8'), password_hash.encode('utf-8'))
    except Exception:
        return False


def create_token(user_id: int) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    payload = {
        'sub': str(user_id),
        'iat': now,
        'exp': now + dt.timedelta(days=TOKEN_EXPIRE_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _decode_token(token: str) -> int:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return int(payload['sub'])
    except Exception:
        raise HTTPException(status_code=401, detail='无效或过期的登录凭证')


def get_current_user_id(authorization: str = Header(None)) -> int:
    if not authorization or not authorization.lower().startswith('bearer '):
        raise HTTPException(status_code=401, detail='缺少登录凭证')
    token = authorization.split(' ', 1)[1].strip()
    return _decode_token(token)
