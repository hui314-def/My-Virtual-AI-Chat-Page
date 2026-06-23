import glob
import torch
import soundfile as sf
from qwen_tts import Qwen3TTSModel
import pickle
import hashlib
import io
import shutil
import time
import threading
import tempfile
from flask import Flask, request, send_file, jsonify
import os
from flask_cors import CORS
from functools import wraps
from dotenv import load_dotenv


VOICE_LIBRARY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "音色库")
os.makedirs(VOICE_LIBRARY_DIR, exist_ok=True)

AUDIO_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "音频缓存")
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)


# ========== API Key 配置 ==========
# 从环境变量获取密钥，若未设置则允许无鉴权（开发环境），生产环境务必设置
load_dotenv()
API_KEY = os.environ.get("TTS_API_KEY", "")
REQUIRE_AUTH = bool(API_KEY)   # 若密钥非空则启用鉴权

def require_api_key(f):
    """装饰器：要求请求头中包含正确的 X-API-Key"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if REQUIRE_AUTH:
            auth_header = request.headers.get("X-API-Key")
            if not auth_header or auth_header != API_KEY:
                return jsonify({"error": "未授权访问，请提供有效的 API Key"}), 401
        return f(*args, **kwargs)
    return decorated_function


# ========== 缓存清理配置 ==========
MAX_CACHE_SIZE_GB = 5            # 最大缓存大小（GB）
MAX_CACHE_FILES = 1000           # 最大文件数量
MAX_CACHE_AGE_DAYS = 7           # 最大留存天数（0表示不限制）
CACHE_CLEANUP_INTERVAL_SEC = 3600  # 清理检查最小间隔（秒），避免频繁扫描

_last_cleanup_time = 0
_cleanup_lock = threading.Lock()

def cleanup_audio_cache(force=False):
    """清理音频缓存，根据大小、文件数量和留存天数"""
    global _last_cleanup_time

    # 限频：距离上次清理不足间隔则跳过（除非强制）
    now = time.time()
    if not force and (now - _last_cleanup_time) < CACHE_CLEANUP_INTERVAL_SEC:
        return

    with _cleanup_lock:
        # 双重检查
        if not force and (now - _last_cleanup_time) < CACHE_CLEANUP_INTERVAL_SEC:
            return
        _last_cleanup_time = now

        if not os.path.exists(AUDIO_CACHE_DIR):
            return

        # 获取所有缓存文件信息 (路径, 大小, atime)
        files = []
        total_size = 0
        for fname in os.listdir(AUDIO_CACHE_DIR):
            fpath = os.path.join(AUDIO_CACHE_DIR, fname)
            if not os.path.isfile(fpath):
                continue
            try:
                stat = os.stat(fpath)
                files.append((fpath, stat.st_size, stat.st_atime))
                total_size += stat.st_size
            except OSError:
                continue

        # 按最后访问时间排序（旧的在前面）
        files.sort(key=lambda x: x[2])

        # 1. 删除超过留存天数的文件
        if MAX_CACHE_AGE_DAYS > 0:
            cutoff = now - MAX_CACHE_AGE_DAYS * 86400
            remaining = []
            for fpath, size, atime in files:
                if atime < cutoff:
                    try:
                        os.remove(fpath)
                        total_size -= size
                        print(f"[Cache] Deleted old file: {fpath}")
                    except Exception as e:
                        print(f"[Cache] Failed to delete {fpath}: {e}")
                else:
                    remaining.append((fpath, size, atime))
            files = remaining

        # 2. 如果仍然超过数量限制，删除最旧的
        max_files = MAX_CACHE_FILES
        if max_files > 0 and len(files) > max_files:
            to_delete = len(files) - max_files
            for i in range(to_delete):
                fpath, size, _ = files[i]
                try:
                    os.remove(fpath)
                    total_size -= size
                    print(f"[Cache] Deleted by count limit: {fpath}")
                except Exception as e:
                    print(f"[Cache] Failed to delete {fpath}: {e}")
            files = files[to_delete:]

        # 3. 如果仍然超过大小限制，继续删除最旧的
        max_size_bytes = MAX_CACHE_SIZE_GB * 1024 ** 3
        if max_size_bytes > 0:
            idx = 0
            while total_size > max_size_bytes and idx < len(files):
                fpath, size, _ = files[idx]
                try:
                    os.remove(fpath)
                    total_size -= size
                    print(f"[Cache] Deleted by size limit: {fpath}")
                except Exception as e:
                    print(f"[Cache] Failed to delete {fpath}: {e}")
                idx += 1

app = Flask(__name__)
CORS(app)  # 允许跨域请求

# 全局加载模型（启动时加载一次，避免重复加载）
print("正在加载 Qwen3TTS 模型...")
model = Qwen3TTSModel.from_pretrained(
    "D:\code4\Qwen3-TTS-12Hz-1.7B-Base",
    device_map="cuda:0",
    dtype=torch.bfloat16,
    attn_implementation="flash_attention_2",
)
print("模型加载完成。")

def is_valid_voice_prompt(obj):
    """加载后的语音提示的基本结构验证，使用 __dict__ 接受常见的容器类型或对象。"""
    if obj is None:
        return False
    if isinstance(obj, (dict, list, tuple, str, bytes, int, float)):
        return True
    if hasattr(obj, '__dict__'):
        return True
    return False

def load_all_voice_prompts():
    prompts = {}
    bad_dir = os.path.join(VOICE_LIBRARY_DIR, "_corrupt")
    os.makedirs(bad_dir, exist_ok=True)

    for pkl_file in glob.glob(os.path.join(VOICE_LIBRARY_DIR, "*.pkl")):
        name = os.path.splitext(os.path.basename(pkl_file))[0]
        try:
            with open(pkl_file, 'rb') as f:
                obj = pickle.load(f)

            if not is_valid_voice_prompt(obj):
                # 文件结构不符合预期，隔离到 quarantine
                shutil.move(pkl_file, os.path.join(bad_dir, os.path.basename(pkl_file)))
                print(f"Quarantined invalid prompt file: {pkl_file}")
                continue

            prompts[name] = obj
        except (pickle.UnpicklingError, EOFError) as e:
            # 无法反序列化，疑似损坏，移动到隔离目录
            try:
                shutil.move(pkl_file, os.path.join(bad_dir, os.path.basename(pkl_file)))
                print(f"Quarantined corrupt prompt file: {pkl_file} ({e})")
            except Exception:
                print(f"Failed to quarantine corrupt file: {pkl_file} ({e})")
        except Exception as e:
            # 记录但继续处理其余文件
            print(f"Skipping prompt file {pkl_file}: {e}")
    return prompts

# 初始化时加载
VOICE_PROMPT_MAP = load_all_voice_prompts()

@app.route('/voices', methods=['GET'])
def get_voices():
    """返回可用的音色名称列表"""
    voices = list(VOICE_PROMPT_MAP.keys())
    return jsonify({"voices": voices})

@app.route('/tts', methods=['POST'])
@require_api_key
def tts_synthesis():
    data = request.get_json()
    text = data.get('text', '')
    voice = data.get('voice', 'default')

    if not text:
        return jsonify({"error": "text 参数不能为空"}), 400
    
    # 生成缓存文件名（基于文本和音色的哈希）
    cache_key = hashlib.md5(f"{text}_{voice}".encode('utf-8')).hexdigest()
    cache_path = os.path.join(AUDIO_CACHE_DIR, f"{cache_key}.wav")

    # 若缓存存在，直接返回文件
    if os.path.exists(cache_path):
        # 更新访问时间
        os.utime(cache_path, None)
        return send_file(cache_path, mimetype='audio/wav')

    try:
        # 1. 从内存映射获取
        prompt = VOICE_PROMPT_MAP.get(voice)

        # 2. 如果不存在，尝试从音色库文件夹加载
        if prompt is None:
            pkl_path = os.path.join(VOICE_LIBRARY_DIR, f"{voice}.pkl")
            if os.path.exists(pkl_path):
                with open(pkl_path, 'rb') as f:
                    prompt = pickle.load(f)
                    VOICE_PROMPT_MAP[voice] = prompt

        # 3. 如果仍然没有，尝试使用 default 音色
        if prompt is None:
            if "default" in VOICE_PROMPT_MAP:
                prompt = VOICE_PROMPT_MAP["default"]
            else:
                default_path = os.path.join(VOICE_LIBRARY_DIR, "default.pkl")
                if os.path.exists(default_path):
                    with open(default_path, 'rb') as f:
                        prompt = pickle.load(f)
                        VOICE_PROMPT_MAP["default"] = prompt
                else:
                    return jsonify({"error": f"未找到音色 '{voice}'，且没有默认音色可用"}), 400

        # 生成语音
        wavs, sr = model.generate_voice_clone(
            text=text,
            language="Chinese",
            voice_clone_prompt=prompt,
        )
        audio_data = wavs[0]
        # 保存到缓存文件
        sf.write(cache_path, audio_data, sr)
        # 触发异步清理
        threading.Thread(target=cleanup_audio_cache, daemon=True).start()
        buffer = io.BytesIO()
        sf.write(buffer, audio_data, sr, format='wav')
        buffer.seek(0)
        return send_file(buffer, mimetype='audio/wav')
    except Exception as e:
        print(f"TTS 生成失败: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/clone_voice', methods=['POST'])
def clone_voice():
    tmp_path = None
    try:
        voice_name = request.form.get('voice_name')
        if not voice_name:
            return jsonify({"error": "缺少音色名称"}), 400
        
        # 检查文件名合法性（防止路径遍历）
        safe_name = "".join(c for c in voice_name if c.isalnum() or c in "._-")
        if safe_name != voice_name:
            return jsonify({"error": "音色名称只能包含字母、数字、下划线、点、横线"}), 400
        
        audio_file = request.files.get('audio')
        if not audio_file:
            return jsonify({"error": "缺少音频文件"}), 400
        
        ref_text = request.form.get('ref_text')
        if not ref_text:
            return jsonify({"error": "缺少音频文本内容"}), 400
        
        # 保存临时音频文件
        with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(audio_file.filename)[1]) as tmp:
            audio_file.save(tmp.name)
            tmp_path = tmp.name
        
        # 调用模型生成克隆提示
        voice_clone_prompt = model.create_voice_clone_prompt(
            ref_audio=tmp_path,
            ref_text=ref_text,
        )
        
        # 保存到音色库文件夹
        pkl_path = os.path.join(VOICE_LIBRARY_DIR, f"{safe_name}.pkl")
        with open(pkl_path, 'wb') as f:
            pickle.dump(voice_clone_prompt, f)
        
        # 更新内存中的映射
        VOICE_PROMPT_MAP[safe_name] = voice_clone_prompt
        
        # 清理临时文件
        os.unlink(tmp_path)
        
        return jsonify({"message": "音色克隆成功", "voice_name": safe_name})
    except Exception as e:
        print("克隆错误:", e)
        return jsonify({"error": str(e)}), 500
    finally:
        # 无论成功或失败，只要临时文件存在就删除
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception as cleanup_error:
                print(f"清理临时文件失败: {cleanup_error}")
    
if __name__ == '__main__':
    cleanup_audio_cache(force=True)
    app.run(host='0.0.0.0', port=5000, debug=True)