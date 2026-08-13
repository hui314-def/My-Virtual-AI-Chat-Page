"""
MOSI 云端 TTS FastAPI 服务
==========================
替换原有的 Flask 本地 TTS 服务 (tts_api.py)，调用 MOSI 云端 API。
默认使用流式 SSE 推送，前端 Web Audio API 边收边播，大幅降低首帧延迟。

启动: uvicorn moss_tts_server:app --host 0.0.0.0 --port 5000
"""

import asyncio
import base64
import hashlib
import json
import logging
import os
import tempfile
import threading
import time
from io import BytesIO
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

# 导入 MOSI 客户端（同一目录下）
from mosi_api_client import MossClient, MossAPIError, MossError, MossTimeoutError, _pcm_to_wav_bytes

# ── 日志 ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("moss_tts_server")

# ── 配置 ──────────────────────────────────────────────────────────────────
load_dotenv()

SCRIPT_DIR = Path(__file__).parent
VOICE_LIBRARY_DIR = SCRIPT_DIR / "音色库"
VOICE_LIBRARY_DIR.mkdir(exist_ok=True)

VOICE_MAP_PATH = SCRIPT_DIR / "voice_map.json"
AUDIO_CACHE_DIR = SCRIPT_DIR / "音频缓存"
AUDIO_CACHE_DIR.mkdir(exist_ok=True)

# 本地鉴权
TTS_API_KEY = os.environ.get("TTS_API_KEY", "")
REQUIRE_AUTH = bool(TTS_API_KEY)

# MOSI 云端
MOSS_API_KEY = os.environ.get("MOSS_API_KEY", "")
if not MOSS_API_KEY:
    raise RuntimeError("请在 .env 中设置 MOSS_API_KEY")

TTS_HOST = os.environ.get("TTS_HOST", "0.0.0.0")
TTS_PORT = int(os.environ.get("TTS_PORT", "5000"))

# ── 音频缓存配置 ─────────────────────────────────────────────────────────
MAX_CACHE_SIZE_GB = 5
MAX_CACHE_FILES = 1000
MAX_CACHE_AGE_DAYS = 7
CACHE_CLEANUP_INTERVAL_SEC = 3600

_last_cleanup_time = 0
_cleanup_lock = threading.Lock()


def cleanup_audio_cache(force: bool = False) -> None:
    """清理过期/超量音频缓存。线程安全，限频执行。"""
    global _last_cleanup_time
    now = time.time()
    if not force and (now - _last_cleanup_time) < CACHE_CLEANUP_INTERVAL_SEC:
        return
    with _cleanup_lock:
        if not force and (now - _last_cleanup_time) < CACHE_CLEANUP_INTERVAL_SEC:
            return
        _last_cleanup_time = now
        if not AUDIO_CACHE_DIR.exists():
            return

        files = []
        total_size = 0
        for fpath in AUDIO_CACHE_DIR.iterdir():
            if not fpath.is_file():
                continue
            try:
                stat = fpath.stat()
                files.append((fpath, stat.st_size, stat.st_atime))
                total_size += stat.st_size
            except OSError:
                continue

        files.sort(key=lambda x: x[2])

        # 1. 按留存天数删除
        if MAX_CACHE_AGE_DAYS > 0:
            cutoff = now - MAX_CACHE_AGE_DAYS * 86400
            remaining = []
            for fp, size, atime in files:
                if atime < cutoff:
                    try:
                        fp.unlink()
                        total_size -= size
                    except Exception:
                        pass
                else:
                    remaining.append((fp, size, atime))
            files = remaining

        # 2. 按文件数限制
        if MAX_CACHE_FILES > 0 and len(files) > MAX_CACHE_FILES:
            for i in range(len(files) - MAX_CACHE_FILES):
                fp, size, _ = files[i]
                try:
                    fp.unlink()
                    total_size -= size
                except Exception:
                    pass
            files = files[len(files) - MAX_CACHE_FILES:]

        # 3. 按总大小限制
        max_bytes = MAX_CACHE_SIZE_GB * 1024 ** 3
        idx = 0
        while total_size > max_bytes and idx < len(files):
            fp, size, _ = files[idx]
            try:
                fp.unlink()
                total_size -= size
            except Exception:
                pass
            idx += 1


# ── 音色映射管理 ─────────────────────────────────────────────────────────
_voice_map: dict = {}
_voice_map_lock = threading.Lock()


def load_voice_map() -> dict:
    """加载音色名 → MOSI UUID 映射。首次启动时尝试从 MOSI 云端同步。"""
    global _voice_map
    if VOICE_MAP_PATH.exists():
        try:
            _voice_map = json.loads(VOICE_MAP_PATH.read_text(encoding="utf-8"))
            logger.info(f"已加载 {len(_voice_map)} 个音色映射")
        except (json.JSONDecodeError, OSError):
            logger.warning("voice_map.json 损坏，从云端重新同步")
            _voice_map = {}
    else:
        _voice_map = {}


def save_voice_map() -> None:
    """原子写入 voice_map.json。"""
    tmp = str(VOICE_MAP_PATH) + ".tmp"
    Path(tmp).write_text(json.dumps(_voice_map, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, str(VOICE_MAP_PATH))


async def sync_voices_from_mosi(client: MossClient) -> None:
    """从 MOSI 云端拉取音色列表，补全本地映射中缺失的。"""
    try:
        remote = await asyncio.to_thread(client.list_voices)
        with _voice_map_lock:
            updated = False
            for v in remote:
                vid = v.get("id", "")
                vname = v.get("name", "").strip()
                # 优先用 name，如果为空或冲突则用 id 前缀
                key = vname if vname else vid[:8]
                if key not in _voice_map:
                    _voice_map[key] = vid
                    updated = True
                    logger.info(f"新增云音色: {key} → {vid[:16]}...")
            if updated:
                save_voice_map()
    except Exception as e:
        logger.warning(f"同步云音色失败: {e}")


# ── MOSI 客户端（全局复用）────────────────────────────────────────────────
_mosi_client: Optional[MossClient] = None


def get_mosi_client() -> MossClient:
    """获取全局 MOSI 客户端实例。"""
    global _mosi_client
    if _mosi_client is None:
        _mosi_client = MossClient(api_key=MOSS_API_KEY, timeout=10)
    return _mosi_client


# ── FastAPI App ───────────────────────────────────────────────────────────

app = FastAPI(title="MOSI TTS Service", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    load_voice_map()
    cleanup_audio_cache(force=True)
    client = get_mosi_client()
    await sync_voices_from_mosi(client)
    logger.info(f"MOSI TTS 服务启动: {TTS_HOST}:{TTS_PORT}")


# ── 鉴权依赖 ─────────────────────────────────────────────────────────────

async def check_auth(x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    """FastAPI 鉴权依赖。TTS_API_KEY 为空则跳过鉴权。"""
    if REQUIRE_AUTH and (not x_api_key or x_api_key != TTS_API_KEY):
        raise HTTPException(status_code=401, detail={"error": "未授权访问，请提供有效的 API Key"})


# ── GET /voices ───────────────────────────────────────────────────────────

@app.get("/voices")
async def get_voices():
    """返回可用音色名称列表。"""
    with _voice_map_lock:
        names = list(_voice_map.keys())
    return {"voices": names}


# ── POST /tts ─────────────────────────────────────────────────────────────

@app.post("/tts")
async def tts_synthesis(
    request: Request,
    _: None = None,  # auth handled manually for compat
):
    """单人语音合成（非流式，返回完整 WAV）。

    向后兼容：前端 fallback 时使用此端点。
    内部使用 MOSI 流式 API 收集 PCM 后拼成 WAV 返回。
    """
    # 鉴权（手动读取 header）
    if REQUIRE_AUTH:
        key = request.headers.get("X-API-Key", "")
        if key != TTS_API_KEY:
            return JSONResponse({"error": "未授权访问，请提供有效的 API Key"}, status_code=401)

    body = await request.json()
    text = body.get("text", "").strip()
    voice_name = body.get("voiceId", "default")

    if not text:
        return JSONResponse({"error": "text 参数不能为空"}, status_code=400)

    with _voice_map_lock:
        voice_id = _voice_map.get(voice_name) or _voice_map.get("default")
    if not voice_id:
        return JSONResponse(
            {"error": f"未找到音色 '{voice_name}'，且没有默认音色可用"}, status_code=400
        )

    # 缓存检查
    cache_key = hashlib.md5(f"{text}_{voice_name}".encode("utf-8")).hexdigest()
    cache_path = AUDIO_CACHE_DIR / f"{cache_key}.wav"
    if cache_path.exists():
        os.utime(cache_path, None)
        return FileResponse(cache_path, media_type="audio/wav")

    # 叫 MOSI 流式生成，然后拼完整 WAV
    try:
        client = get_mosi_client()
        wav_bytes = await asyncio.to_thread(
            client.speech_stream_to_wav,
            input_text=text,
            voice_id=voice_id,
            speed=1.0,
        )
    except (MossAPIError, MossError, MossTimeoutError) as e:
        logger.error(f"MOSI TTS 失败: {e}")
        return JSONResponse({"error": f"语音合成失败: {e}"}, status_code=502)
    except Exception as e:
        logger.exception("TTS 未知错误")
        return JSONResponse({"error": "内部服务错误"}, status_code=500)

    # 写缓存
    try:
        cache_path.write_bytes(wav_bytes)
    except Exception:
        pass
    asyncio.create_task(asyncio.to_thread(cleanup_audio_cache))

    return Response(content=wav_bytes, media_type="audio/wav")


# ── POST /tts/stream ──────────────────────────────────────────────────────

async def _generate_sse_stream(text: str, voice_id: str, cache_key: str):
    """SSE 流式生成器：通过 asyncio.Queue 桥接同步 MOSI 流到 async。

    流式传输过程中同时收集 PCM 分片，流结束后异步写入缓存。
    """
    queue: asyncio.Queue = asyncio.Queue()
    pcm_chunks = []
    sample_rate = 48000  # MOSI flash-20260626 默认 48000Hz（会被 speech.created 覆盖）
    channels = 1
    bit_depth = 16

    # MOSI 流式 chunk 可能在任意字节边界切断 16-bit 样本，
    # 导致单个 chunk 的 PCM 字节数为奇数。前端 Int16Array 要求
    # 字节数是 2 的倍数，因此必须在服务端缓冲半采样并拼接。
    _pcm_leftover = b""

    def _run_stream():
        """在线程中运行的同步流式逻辑，结果推入 queue。"""
        try:
            client = get_mosi_client()
            stream = client.speech_stream(
                input_text=text,
                voice_id=voice_id,
                stream_format="sse",
                speed=1.0,
            )
            for event in stream:
                queue.put_nowait(event)
            queue.put_nowait(None)  # sentinel: 正常结束
        except Exception as e:
            queue.put_nowait({"__error__": str(e)})

    # 在线程池中启动同步流
    loop = asyncio.get_event_loop()
    task = loop.run_in_executor(None, _run_stream)

    started = False

    try:
        while True:
            # 从队列取事件（带超时，避免永久阻塞）
            try:
                event = await asyncio.wait_for(queue.get(), timeout=300)
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'type': 'error', 'message': '流式超时'})}\n\n"
                return

            if event is None:
                # sentinel: 正常结束
                break

            if "__error__" in event:
                yield f"data: {json.dumps({'type': 'error', 'message': event['__error__']})}\n\n"
                return

            etype = event.get("type", "")

            if etype == "speech.created":
                sample_rate = event.get("sample_rate", sample_rate)
                channels = event.get("channels", channels)
                bit_depth = event.get("bit_depth", bit_depth)
                yield f"data: {json.dumps({'type': 'start', 'sampleRate': sample_rate, 'channels': channels, 'bitDepth': bit_depth})}\n\n"
                started = True

            elif etype == "speech.audio.delta":
                audio_b64 = event.get("audio", "")
                if audio_b64:
                    # 解码原始 PCM 字节
                    raw = base64.b64decode(audio_b64)
                    # 收集原始字节到缓存（用于最终生成 WAV）
                    pcm_chunks.append(raw)

                    if not started:
                        yield f"data: {json.dumps({'type': 'start', 'sampleRate': sample_rate, 'channels': channels, 'bitDepth': bit_depth})}\n\n"
                        started = True

                    # ── 字节对齐处理 ──────────────────────────────
                    # MOSI 的 PCM chunk 可能在 sample 中间切断（奇数长度），
                    # 导致前端 Int16Array 构造失败 → 跳过 chunk →
                    # 后续 chunk 全部字节错位 1 字节 → 刺耳噪声。
                    # 这里缓冲半采样并拼接，确保每个 SSE chunk 都是完整样本。
                    if _pcm_leftover:
                        raw = _pcm_leftover + raw
                    if len(raw) % 2 != 0:
                        _pcm_leftover = raw[-1:]   # 保存半个采样给下一个 chunk
                        raw = raw[:-1]              # 截断到偶数长度
                    else:
                        _pcm_leftover = b""
                    if raw:
                        aligned_b64 = base64.b64encode(raw).decode("ascii")
                        yield f"data: {json.dumps({'type': 'audio', 'data': aligned_b64})}\n\n"

            elif etype == "speech.audio.done":
                # 防御：如果还有残留半个采样（理论上不应该），丢弃
                if _pcm_leftover:
                    logger.warning(f"流结束时残留 {len(_pcm_leftover)} 字节未对齐，已丢弃")
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                break

            elif etype == "error":
                err = event.get("error", {})
                msg = err.get("message", "Unknown streaming error")
                yield f"data: {json.dumps({'type': 'error', 'message': msg})}\n\n"
                return

    except Exception as e:
        logger.exception("流式 SSE 推送异常")
        yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        return
    finally:
        # 确保线程任务完成
        try:
            await asyncio.wait_for(task, timeout=10)
        except (asyncio.TimeoutError, Exception):
            pass

    # 流成功结束 → 后台写缓存
    if pcm_chunks:
        pcm_data = b"".join(pcm_chunks)
        try:
            wav_bytes = _pcm_to_wav_bytes(pcm_data, sample_rate, channels, bit_depth)
            cache_path = AUDIO_CACHE_DIR / f"{cache_key}.wav"
            cache_path.write_bytes(wav_bytes)
            asyncio.create_task(asyncio.to_thread(cleanup_audio_cache))
        except Exception as e:
            logger.warning(f"写缓存失败: {e}")


@app.post("/tts/stream")
async def tts_stream(
    request: Request,
    _: None = None,
):
    """流式语音合成（SSE）。前端边收 PCM 边用 Web Audio API 播放。

    SSE 事件:
      data: {"type":"start","sampleRate":48000,"channels":1,"bitDepth":16}
      data: {"type":"audio","data":"<base64 pcm>"}
      ...
      data: {"type":"done"}
    """
    if REQUIRE_AUTH:
        key = request.headers.get("X-API-Key", "")
        if key != TTS_API_KEY:
            return JSONResponse({"error": "未授权访问，请提供有效的 API Key"}, status_code=401)

    body = await request.json()
    text = body.get("text", "").strip()
    voice_name = body.get("voiceId", "default")

    if not text:
        return JSONResponse({"error": "text 参数不能为空"}, status_code=400)

    with _voice_map_lock:
        voice_id = _voice_map.get(voice_name) or _voice_map.get("default")
    if not voice_id:
        return JSONResponse(
            {"error": f"未找到音色 '{voice_name}'，且没有默认音色可用"}, status_code=400
        )

    # 缓存命中 → 直接返回完整 WAV（非流式更快）
    cache_key = hashlib.md5(f"{text}_{voice_name}".encode("utf-8")).hexdigest()
    cache_path = AUDIO_CACHE_DIR / f"{cache_key}.wav"
    if cache_path.exists():
        os.utime(cache_path, None)
        return FileResponse(cache_path, media_type="audio/wav")

    return StreamingResponse(
        _generate_sse_stream(text, voice_id, cache_key),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── POST /clone_voice ─────────────────────────────────────────────────────

@app.post("/clone_voice")
async def clone_voice(
    voice_name: str = Form(...),
    audio: UploadFile = File(...),
    ref_text: str = Form(...),
):
    """克隆/创建新音色。上传参考音频，通过 MOSI API 生成新音色 ID。"""
    # 安全校验
    safe_name = "".join(c for c in voice_name if c.isalnum() or c in "._-")
    if safe_name != voice_name:
        return JSONResponse(
            {"error": "音色名称只能包含字母、数字、下划线、点、横线"}, status_code=400
        )
    if not audio or not audio.filename:
        return JSONResponse({"error": "缺少音频文件"}, status_code=400)

    tmp_path = None
    try:
        # 保存临时音频
        suffix = Path(audio.filename).suffix or ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await audio.read()
            tmp.write(content)
            tmp_path = tmp.name

        # 调用 MOSI 克隆
        client = get_mosi_client()
        result = await asyncio.to_thread(
            client.create_voice,
            audio_sample_path=tmp_path,
            name=safe_name,
            description=ref_text,
        )

        voice_id = result.get("id", "")
        if not voice_id:
            return JSONResponse({"error": "MOSI 未返回音色 ID"}, status_code=502)

        # 更新映射
        with _voice_map_lock:
            _voice_map[safe_name] = voice_id
            save_voice_map()

        logger.info(f"音色克隆成功: {safe_name} → {voice_id[:16]}...")
        return {"message": "音色克隆成功", "voice_name": safe_name}

    except (MossAPIError, MossError) as e:
        logger.error(f"克隆音色失败: {e}")
        return JSONResponse({"error": f"克隆失败: {e}"}, status_code=502)
    except Exception as e:
        logger.exception("克隆音色未知错误")
        return JSONResponse({"error": f"克隆失败: {e}"}, status_code=500)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


# ── 入口 ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=TTS_HOST, port=TTS_PORT)
