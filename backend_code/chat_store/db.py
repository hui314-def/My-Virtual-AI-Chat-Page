"""MySQL 连接助手 + 建库建表（幂等）。"""
import os
import pymysql
from dotenv import load_dotenv

load_dotenv()  # 读取项目根目录 .env

DB_HOST = os.getenv('DB_HOST', '127.0.0.1')
DB_PORT = int(os.getenv('DB_PORT', '3306'))
DB_USER = os.getenv('DB_USER', 'root')
DB_PASSWORD = os.getenv('DB_PASSWORD', '')
DB_NAME = os.getenv('DB_NAME', 'ai_chat_sync')

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS chats (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  chat_id    VARCHAR(64)     NOT NULL,
  data       JSON            NOT NULL,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
             ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_chat (user_id, chat_id),
  KEY idx_user_updated (user_id, updated_at),
  CONSTRAINT fk_chats_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_settings (
  user_id    BIGINT UNSIGNED PRIMARY KEY,
  data       JSON     NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
             ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_settings_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"""


def get_conn():
    """打开一个 MySQL 连接（每请求短开，局域网小规模足够）。"""
    return pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME,
        charset='utf8mb4',
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=True,
    )


def init_schema():
    """创建数据库与三张表（幂等，可重复执行）。"""
    # 1) 先连到服务器（不选库），确保数据库存在
    conn = pymysql.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD,
        charset='utf8mb4', autocommit=True,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                "CREATE DATABASE IF NOT EXISTS `{}` "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci".format(DB_NAME)
            )
    finally:
        conn.close()

    # 2) 连到库，逐条建表
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            for stmt in SCHEMA_SQL.split(';'):
                s = stmt.strip()
                if s:
                    cur.execute(s)
    finally:
        conn.close()
