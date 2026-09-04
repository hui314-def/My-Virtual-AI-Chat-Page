import glob
from torch import bfloat16
import soundfile as sf
from qwen_tts import Qwen3TTSModel
import pickle
import hashlib
import io
import shutil
import time
import threading
import tempfile
from fastapi import FastAPI, Request, HTTPException, Depends, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import os
from dotenv import load_dotenv
import uvicorn


VOICE_LIBRARY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "音色库")
os.makedirs(VOICE_LIBRARY_DIR, exist_ok=True)

AUDIO_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "音频缓存")
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

load_dotenv()
MODEL_DIR = os.environ.get("QWEN_TTS_MODEL_PATH", "")

# ========== API Key 配置 ==========
# 从环境变量获取密钥，若未设置则允许无鉴权（开发环境），生产环境务必设置
API_KEY = os.environ.get("TTS_API_KEY", "")
REQUIRE_AUTH = bool(API_KEY)   # 若密钥非空则启用鉴权

async def require_api_key(request: Request):
    """依赖注入：要求请求头中包含正确的 X-API-Key"""
    if REQUIRE_AUTH:
        auth_header = request.headers.get("X-API-Key")
        if not auth_header or auth_header != API_KEY:
            raise HTTPException(status_code=401, detail="未授权访问，请提供有效的 API Key")


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

app = FastAPI(title="TTS API", version="1.0.0")

# 允许跨域请求
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 全局加载模型（启动时加载一次，避免重复加载）
print("正在加载 Qwen3TTS 模型...")
model = Qwen3TTSModel.from_pretrained(
    MODEL_DIR,
    device_map="cuda:0",
    dtype=bfloat16,
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


@app.get('/voices')
def get_voices():
    """返回可用的音色名称列表"""
    voices = list(VOICE_PROMPT_MAP.keys())
    return {"voices": voices}


@app.delete('/voices/{voice_name}')
async def delete_voice(voice_name: str, _credentials=Depends(require_api_key)):
    """删除音色库中的音色（*.pkl）。default 为默认音色，不可删除。"""
    if not voice_name or voice_name == 'default':
        raise HTTPException(status_code=400, detail="default 为默认音色，不可删除")
    if '/' in voice_name or '\\' in voice_name or voice_name in ('.', '..') or voice_name.startswith('.'):
        raise HTTPException(status_code=400, detail="非法的音色名称")

    pkl_path = os.path.join(VOICE_LIBRARY_DIR, f"{voice_name}.pkl")
    if not os.path.exists(pkl_path):
        raise HTTPException(status_code=404, detail=f"未找到音色 '{voice_name}'")

    try:
        os.remove(pkl_path)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"删除失败: {e}")
    VOICE_PROMPT_MAP.pop(voice_name, None)
    return {"message": f"音色 '{voice_name}' 已删除"}


@app.post('/tts')
async def tts_synthesis(request: Request, _credentials=Depends(require_api_key)):
    data = await request.json()
    text = data.get('text', '')
    voiceId = data.get('voiceId', 'default')

    if not text:
        raise HTTPException(status_code=400, detail="text 参数不能为空")

    # 生成缓存文件名（基于文本和音色的哈希）
    cache_key = hashlib.md5(f"{text}_{voiceId}".encode('utf-8')).hexdigest()
    cache_path = os.path.join(AUDIO_CACHE_DIR, f"{cache_key}.wav")

    # 若缓存存在，直接返回文件
    if os.path.exists(cache_path):
        # 更新访问时间
        os.utime(cache_path, None)
        def iterfile():
            with open(cache_path, 'rb') as f:
                yield from f
        return StreamingResponse(iterfile(), media_type='audio/wav')

    try:
        # 1. 从内存映射获取
        prompt = VOICE_PROMPT_MAP.get(voiceId)

        # 2. 如果不存在，尝试从音色库文件夹加载
        if prompt is None:
            pkl_path = os.path.join(VOICE_LIBRARY_DIR, f"{voiceId}.pkl")
            if os.path.exists(pkl_path):
                with open(pkl_path, 'rb') as f:
                    prompt = pickle.load(f)
                    VOICE_PROMPT_MAP[voiceId] = prompt

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
                    raise HTTPException(status_code=400, detail=f"未找到音色 '{voiceId}'，且没有默认音色可用")

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
        return StreamingResponse(buffer, media_type='audio/wav')
    except HTTPException:
        raise
    except Exception as e:
        print(f"TTS 生成失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post('/clone_voice')
async def clone_voice(
    voice_name: str = Form(...),
    audio: UploadFile = File(...),
    ref_text: str = Form(...),
):
    tmp_path = None
    try:
        if not voice_name:
            raise HTTPException(status_code=400, detail="缺少音色名称")

        # 检查文件名合法性（防止路径遍历）
        safe_name = "".join(c for c in voice_name if c.isalnum() or c in "._-")
        if safe_name != voice_name:
            raise HTTPException(status_code=400, detail="音色名称只能包含字母、数字、下划线、点、横线")

        if not audio:
            raise HTTPException(status_code=400, detail="缺少音频文件")

        if not ref_text:
            raise HTTPException(status_code=400, detail="缺少音频文本内容")

        # 保存临时音频文件
        suffix = os.path.splitext(audio.filename)[1] if audio.filename else ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await audio.read()
            tmp.write(content)
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

        return {"message": "音色克隆成功", "voice_name": safe_name}
    except HTTPException:
        raise
    except Exception as e:
        print("克隆错误:", e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # 无论成功或失败，只要临时文件存在就删除
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception as cleanup_error:
                print(f"清理临时文件失败: {cleanup_error}")


if __name__ == '__main__':
    cleanup_audio_cache(force=True)
    uvicorn.run(app, host='0.0.0.0', port=5000)
