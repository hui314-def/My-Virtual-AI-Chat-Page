"""清理未被数据库引用的孤儿资源文件（维护工具，可定期执行）。
用法：python backend_code/chat_store/cleanup_assets.py
说明：新上传已按内容 sha256 去重；旧随机文件名在会话重新同步后会被替换为哈希名，
     本脚本负责把不再被引用的旧文件删除。"""
import pymysql, os, re, json
from dotenv import load_dotenv
import assets
load_dotenv()

refs = set()
conn = pymysql.connect(host=os.getenv('DB_HOST','127.0.0.1'), port=int(os.getenv('DB_PORT','3306')),
                       user=os.getenv('DB_USER','root'), password=os.getenv('DB_PASSWORD',''),
                       database=os.getenv('DB_NAME','ai_chat_sync'), charset='utf8mb4',
                       cursorclass=pymysql.cursors.DictCursor)
with conn.cursor() as cur:
    cur.execute("SELECT data FROM chats")
    rows = cur.fetchall()
conn.close()
for r in rows:
    txt = json.dumps(r['data'], ensure_ascii=False)
    for m in re.findall(r'asset://([0-9a-f]{32,64}\.[A-Za-z0-9]{1,5})', txt):
        refs.add(m)

if not os.path.isdir(assets.ASSET_DIR):
    print('assets 目录不存在')
else:
    files = os.listdir(assets.ASSET_DIR)
    before = sum(os.path.getsize(os.path.join(assets.ASSET_DIR, f)) for f in files if os.path.isfile(os.path.join(assets.ASSET_DIR, f)))
    removed = 0
    for f in files:
        if f not in refs:
            try:
                os.remove(os.path.join(assets.ASSET_DIR, f))
                removed += 1
            except Exception:
                pass
    after_files = [f for f in os.listdir(assets.ASSET_DIR) if os.path.isfile(os.path.join(assets.ASSET_DIR, f))]
    after = sum(os.path.getsize(os.path.join(assets.ASSET_DIR, f)) for f in after_files)
    print(f'引用 {len(refs)} 个，清理孤儿 {removed} 个')
    print(f'清理前 {len(files)} 个 / {before/1024/1024:.2f} MB → 清理后 {len(after_files)} 个 / {after/1024/1024:.2f} MB')
