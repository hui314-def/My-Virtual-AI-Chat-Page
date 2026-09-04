"""
VoxCPM2 本地 TTS FastAPI 服务
=============================
将 VoxCPM2 语音合成模型封装为项目标准 TTS 接口（与 moss_tts_server.py / tts_api.py 兼容）：

  GET  /voices        可用音色列表（default + 音色库/*.pt 克隆音色 + *.vdesc.json 设计音色）
  POST /tts           非流式完整 WAV（48kHz 16bit PCM，md5 缓存）
  POST /tts/stream    SSE 流式（start/audio/done/error），前端 Web Audio API 边收边播
  POST /clone_voice   克隆音色（上传参考音频 → 提取音色特征 .pt，一次编码永久复用）
  POST /design_voice  音色设计（文本描述生成音色，无需参考音频 → 音色定义 .vdesc.json + 试听音频）

启动: uvicorn voxcpm_tts_server:app --host 0.0.0.0 --port 5000
环境变量:
  VOXCPM_MODEL_PATH  模型路径（默认 D:\\code4\\models\\OpenBMB\\VoxCPM2）
  VOXCPM_DEVICE      cuda / cpu（默认 cuda 可用则 cuda，否则 cpu）
  VOXCPM_STEPS       扩散采样步数（默认 10，越大质量越高越慢）
  VOXCPM_CFG         引导强度（默认 2.0）
  TTS_API_KEY        鉴权 Key，为空则免鉴权
  TTS_HOST / TTS_PORT 监听地址（默认 0.0.0.0:5000）
"""

import asyncio
import base64
import hashlib
import io
import json
import logging
import os
import tempfile
import threading
import time
import wave
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

import numpy as np
import torch

try:
    from voxcpm import VoxCPM
    from voxcpm.model.utils import next_and_close
except ImportError as e:
    raise RuntimeError("缺少 VoxCPM2 依赖，请先安装：pip install voxcpm") from e

# ── 日志 ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("voxcpm_tts_server")

# ── 配置 ──────────────────────────────────────────────────────────────────
load_dotenv()

SCRIPT_DIR = Path(__file__).parent
VOICE_LIBRARY_DIR = SCRIPT_DIR / "音色库"      # 克隆音色特征 *.pt
VOICE_LIBRARY_DIR.mkdir(exist_ok=True)
AUDIO_CACHE_DIR = SCRIPT_DIR / "音频缓存"      # 合成音频 md5 缓存 *.wav
AUDIO_CACHE_DIR.mkdir(exist_ok=True)

TTS_API_KEY = os.environ.get("TTS_API_KEY", "")
REQUIRE_AUTH = bool(TTS_API_KEY)

MODEL_PATH = os.environ.get("VOXCPM_MODEL_PATH", r"D:\code4\models\OpenBMB\VoxCPM2")
DEVICE = os.environ.get("VOXCPM_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
INFERENCE_TIMESTEPS = int(os.environ.get("VOXCPM_STEPS", "10"))
CFG_VALUE = float(os.environ.get("VOXCPM_CFG", "2.0"))

SAMPLE_RATE = 48000  # VoxCPM2 输出固定 48kHz

TTS_HOST = os.environ.get("TTS_HOST", "0.0.0.0")
TTS_PORT = int(os.environ.get("TTS_PORT", "5500"))

# ── 音频缓存配置（与 moss 版一致）─────────────────────────────────────────
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

        if MAX_CACHE_FILES > 0 and len(files) > MAX_CACHE_FILES:
            for i in range(len(files) - MAX_CACHE_FILES):
                fp, size, _ = files[i]
                try:
                    fp.unlink()
                    total_size -= size
                except Exception:
                    pass
            files = files[len(files) - MAX_CACHE_FILES:]

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


# ── 模型（全局单例 + 串行锁：GPU 模型不支持并发生成）───────────────────────
_model: Optional[VoxCPM] = None
_gen_lock = threading.Lock()


def load_model() -> None:
    """加载 VoxCPM2 模型（启动时调用一次）。Windows 不支持 Triton，关闭 torch.compile。"""
    global _model
    if _model is not None:
        return
    logger.info(f"🚀 正在加载 VoxCPM2 模型: {MODEL_PATH} (device={DEVICE})")
    _model = VoxCPM.from_pretrained(MODEL_PATH, device=DEVICE, optimize=False)
    logger.info("✅ VoxCPM2 模型加载完成")


def _as_numpy(wav) -> np.ndarray:
    """把模型输出统一转为 1D float32 numpy（兼容 tensor / (1, n) / (n,)）。"""
    if isinstance(wav, torch.Tensor):
        wav = wav.detach().cpu().numpy()
    wav = np.asarray(wav, dtype=np.float32)
    if wav.ndim > 1:
        wav = wav.squeeze(0)
    return wav


def _pcm_to_wav_bytes(pcm: bytes, sample_rate: int = SAMPLE_RATE, channels: int = 1, bit_depth: int = 16) -> bytes:
    """16bit PCM 裸字节 → WAV 文件字节（标准库 wave）。"""
    bio = io.BytesIO()
    with wave.open(bio, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(bit_depth // 8)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)
    return bio.getvalue()


def _wav_from_float32(wav: np.ndarray) -> bytes:
    """float32 波形 → WAV 字节（裁剪 + 转 int16 + 加 WAV 头）。"""
    int16 = (np.clip(wav, -1.0, 1.0) * 32767).astype(np.int16)
    return _pcm_to_wav_bytes(int16.tobytes())


def _resolve_voice(voice_name: str):
    """解析音色：返回 ('default', None) / ('pt', Path) / ('desc', dict) / None（不存在）。"""
    if not voice_name or voice_name == "default":
        return ("default", None)
    pt = VOICE_LIBRARY_DIR / f"{voice_name}.pt"
    if pt.exists():
        return ("pt", pt)
    vdesc = VOICE_LIBRARY_DIR / f"{voice_name}.vdesc.json"
    if vdesc.exists():
        try:
            return ("desc", json.loads(vdesc.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            return None
    return None


def _synthesize_full(text: str, voice_spec) -> bytes:
    """非流式合成：串行执行，返回完整 WAV 字节。voice_spec 来自 _resolve_voice。"""
    with _gen_lock:
        kind, payload = voice_spec
        if kind == "default":
            wav = _model.generate(text=text)
        elif kind == "pt":
            prompt_cache = torch.load(payload, map_location="cpu", weights_only=False)
            gen = _model.tts_model._generate_with_prompt_cache(
                target_text=text,
                prompt_cache=prompt_cache,
                inference_timesteps=INFERENCE_TIMESTEPS,
                cfg_value=CFG_VALUE,
            )
            wav, _, _ = next_and_close(gen)
        else:  # desc：音色设计（描述内联在文本开头括号内，无需参考音频）
            desc = (payload or {}).get("description", "").strip()
            wav = _model.generate(text=f"({desc}){text}")
    return _wav_from_float32(_as_numpy(wav))


def _extract_profile(ref_audio_path: str, save_path: Path) -> Path:
    """从参考音频提取音色特征并保存 .pt（一次编码，永久复用）。"""
    with _gen_lock:
        prompt_cache = _model.tts_model.build_prompt_cache(reference_wav_path=ref_audio_path)
        profile = {
            "ref_audio_feat": prompt_cache["ref_audio_feat"].clone().cpu(),
            "mode": "reference",
        }
        torch.save(profile, str(save_path))
    return save_path


# ── FastAPI App ───────────────────────────────────────────────────────────

app = FastAPI(title="VoxCPM2 TTS Service", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    load_model()
    cleanup_audio_cache(force=True)
    logger.info(f"VoxCPM2 TTS 服务启动: {TTS_HOST}:{TTS_PORT}")


def _check_auth(request: Request) -> Optional[JSONResponse]:
    """鉴权检查（TTS_API_KEY 为空则跳过）；返回 None 表示通过。"""
    if REQUIRE_AUTH:
        key = request.headers.get("X-API-Key", "")
        if key != TTS_API_KEY:
            return JSONResponse({"error": "未授权访问，请提供有效的 API Key"}, status_code=401)
    return None


# ── GET /voices ───────────────────────────────────────────────────────────

@app.get("/voices")
async def get_voices():
    """返回可用音色名称列表：default + 音色库/*.pt（克隆）+ *.vdesc.json（设计），按文件名。"""
    names = ["default"] + sorted(
        [p.stem for p in VOICE_LIBRARY_DIR.glob("*.pt")]
        + [p.name.removesuffix(".vdesc.json") for p in VOICE_LIBRARY_DIR.glob("*.vdesc.json")]
    )
    return {"voices": names}


# ── DELETE /voices/{voice_name} ────────────────────────────────────────────

def _safe_voice_name(voice_name: str) -> Optional[str]:
    """校验音色名（禁止路径穿越等非法输入），合法返回原名，否则 None。"""
    if not voice_name or voice_name in (".", "..") or voice_name.startswith("."):
        return None
    if "/" in voice_name or "\\" in voice_name:
        return None
    if Path(voice_name).name != voice_name:
        return None
    return voice_name


@app.delete("/voices/{voice_name}")
async def delete_voice(request: Request, voice_name: str):
    """删除音色库中的音色（克隆 .pt / 设计 .vdesc.json）。default 为内置音色，不可删除。"""
    denied = _check_auth(request)
    if denied:
        return denied

    name = _safe_voice_name(voice_name)
    if name is None:
        return JSONResponse({"error": "非法的音色名称"}, status_code=400)
    if name == "default":
        return JSONResponse({"error": "default 为内置默认音色，不可删除"}, status_code=400)

    removed = []
    pt_path = VOICE_LIBRARY_DIR / f"{name}.pt"
    if pt_path.exists():
        try:
            pt_path.unlink()
            removed.append(pt_path.name)
        except OSError as e:
            return JSONResponse({"error": f"删除 {pt_path.name} 失败: {e}"}, status_code=500)

    vdesc_path = VOICE_LIBRARY_DIR / f"{name}.vdesc.json"
    if vdesc_path.exists():
        try:
            vdesc_path.unlink()
            removed.append(vdesc_path.name)
        except OSError as e:
            return JSONResponse({"error": f"删除 {vdesc_path.name} 失败: {e}"}, status_code=500)

    if not removed:
        return JSONResponse({"error": f"未找到音色 '{name}'"}, status_code=404)

    return {"message": f"音色 '{name}' 已删除", "deleted": removed}


# ── POST /tts ─────────────────────────────────────────────────────────────

@app.post("/tts")
async def tts_synthesis(request: Request):
    """非流式语音合成，返回完整 WAV（48kHz 16bit PCM）。缓存命中直接返回。"""
    denied = _check_auth(request)
    if denied:
        return denied

    body = await request.json()
    text = body.get("text", "").strip()
    voice_name = body.get("voiceId", "default")

    if not text:
        return JSONResponse({"error": "text 参数不能为空"}, status_code=400)

    voice_spec = _resolve_voice(voice_name)
    if voice_spec is None:
        return JSONResponse(
            {"error": f"未找到音色 '{voice_name}'，且没有默认音色可用"}, status_code=400
        )

    # 缓存检查（text + voiceId 哈希）
    cache_key = hashlib.md5(f"{text}_{voice_name}".encode("utf-8")).hexdigest()
    cache_path = AUDIO_CACHE_DIR / f"{cache_key}.wav"
    if cache_path.exists():
        os.utime(cache_path, None)
        return FileResponse(cache_path, media_type="audio/wav")

    try:
        wav_bytes = await asyncio.to_thread(_synthesize_full, text, voice_spec)
    except Exception as e:
        logger.exception("TTS 合成失败")
        return JSONResponse({"error": f"语音合成失败: {e}"}, status_code=500)

    try:
        cache_path.write_bytes(wav_bytes)
    except Exception:
        pass
    asyncio.create_task(asyncio.to_thread(cleanup_audio_cache))

    return Response(content=wav_bytes, media_type="audio/wav")


# ── POST /tts/stream ──────────────────────────────────────────────────────

async def _generate_sse_stream(text: str, voice_spec, cache_key: str):
    """SSE 流式生成器：同步生成线程 → asyncio.Queue → SSE 事件。

    事件格式（与 moss 版一致）:
      data: {"type":"start","sampleRate":48000,"channels":1,"bitDepth":16}
      data: {"type":"audio","data":"<base64 int16 PCM 分片>"}
      ...
      data: {"type":"done"}
    流结束后把收集到的 PCM 拼 WAV 写入缓存。
    """
    queue: asyncio.Queue = asyncio.Queue()
    pcm_chunks = []

    def _run_stream():
        try:
            with _gen_lock:
                kind, payload = voice_spec
                if kind == "default":
                    # 默认音色：优先原生流式；失败则整段生成后一次性推入（前端行为不变）
                    try:
                        for wav in _model.generate_streaming(text=text):
                            queue.put_nowait(("chunk", _as_numpy(wav)))
                    except Exception as e:
                        logger.warning(f"默认音色流式失败，回退整段合成: {e}")
                        queue.put_nowait(("chunk", _as_numpy(_model.generate(text=text))))
                elif kind == "pt":
                    prompt_cache = torch.load(payload, map_location="cpu", weights_only=False)
                    gen = _model.tts_model._generate_with_prompt_cache(
                        target_text=text,
                        prompt_cache=prompt_cache,
                        inference_timesteps=INFERENCE_TIMESTEPS,
                        cfg_value=CFG_VALUE,
                        streaming=True,
                    )
                    for wav, _, _ in gen:
                        queue.put_nowait(("chunk", _as_numpy(wav)))
                else:  # desc：音色设计（描述内联，流式失败回退整段）
                    desc = (payload or {}).get("description", "").strip()
                    full_text = f"({desc}){text}"
                    try:
                        for wav in _model.generate_streaming(text=full_text):
                            queue.put_nowait(("chunk", _as_numpy(wav)))
                    except Exception as e:
                        logger.warning(f"设计音色流式失败，回退整段合成: {e}")
                        queue.put_nowait(("chunk", _as_numpy(_model.generate(text=full_text))))
            queue.put_nowait(None)  # sentinel: 正常结束
        except Exception as e:
            queue.put_nowait(("error", str(e)))

    task = asyncio.get_event_loop().run_in_executor(None, _run_stream)
    started = False

    try:
        while True:
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=300)
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'type': 'error', 'message': '流式超时'})}\n\n"
                return

            if msg is None:
                # sentinel: 正常结束 → 通知前端流结束（协议约定必须有 done 事件）
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                break

            kind, payload = msg
            if kind == "error":
                yield f"data: {json.dumps({'type': 'error', 'message': payload})}\n\n"
                return

            # payload: float32 numpy chunk
            if not started:
                yield f"data: {json.dumps({'type': 'start', 'sampleRate': SAMPLE_RATE, 'channels': 1, 'bitDepth': 16})}\n\n"
                started = True

            int16 = (np.clip(payload, -1.0, 1.0) * 32767).astype(np.int16)
            raw = int16.tobytes()  # int16 → 字节数必为偶数，无需对齐处理
            pcm_chunks.append(raw)
            yield f"data: {json.dumps({'type': 'audio', 'data': base64.b64encode(raw).decode('ascii')})}\n\n"
    finally:
        try:
            await asyncio.wait_for(task, timeout=10)
        except Exception:
            pass

    # 流正常结束 → 后台写缓存
    if pcm_chunks:
        try:
            wav_bytes = _pcm_to_wav_bytes(b"".join(pcm_chunks))
            cache_path = AUDIO_CACHE_DIR / f"{cache_key}.wav"
            cache_path.write_bytes(wav_bytes)
            asyncio.create_task(asyncio.to_thread(cleanup_audio_cache))
        except Exception as e:
            logger.warning(f"写缓存失败: {e}")


@app.post("/tts/stream")
async def tts_stream(request: Request):
    """流式语音合成（SSE）。缓存命中直接返回完整 WAV（非 SSE）。"""
    denied = _check_auth(request)
    if denied:
        return denied

    body = await request.json()
    text = body.get("text", "").strip()
    voice_name = body.get("voiceId", "default")

    if not text:
        return JSONResponse({"error": "text 参数不能为空"}, status_code=400)

    voice_spec = _resolve_voice(voice_name)
    if voice_spec is None:
        return JSONResponse(
            {"error": f"未找到音色 '{voice_name}'，且没有默认音色可用"}, status_code=400
        )

    cache_key = hashlib.md5(f"{text}_{voice_name}".encode("utf-8")).hexdigest()
    cache_path = AUDIO_CACHE_DIR / f"{cache_key}.wav"
    if cache_path.exists():
        os.utime(cache_path, None)
        return FileResponse(cache_path, media_type="audio/wav")

    return StreamingResponse(
        _generate_sse_stream(text, voice_spec, cache_key),
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
    """克隆/创建新音色：上传参考音频 → 提取音色特征 → 保存到 音色库/{voice_name}.pt。

    参考音频 3~10 秒清晰人声即可；克隆成功后即可通过 /tts 的 voiceId 使用。
    ref_text 字段为前端兼容保留（VoxCPM 特征提取不需要文本对齐）。
    """
    safe_name = "".join(c for c in voice_name if c.isalnum() or c in "._-")
    if safe_name != voice_name:
        return JSONResponse(
            {"error": "音色名称只能包含字母、数字、下划线、点、横线"}, status_code=400
        )
    if not audio or not audio.filename:
        return JSONResponse({"error": "缺少音频文件"}, status_code=400)

    tmp_path = None
    try:
        suffix = Path(audio.filename).suffix or ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await audio.read()
            tmp.write(content)
            tmp_path = tmp.name

        save_path = VOICE_LIBRARY_DIR / f"{safe_name}.pt"
        await asyncio.to_thread(_extract_profile, tmp_path, save_path)

        size_kb = save_path.stat().st_size / 1024
        logger.info(f"音色克隆成功: {safe_name} ({size_kb:.1f} KB)")
        return {"message": "音色克隆成功", "voice_name": safe_name}

    except Exception as e:
        logger.exception("克隆音色失败")
        return JSONResponse({"error": f"克隆失败: {e}"}, status_code=500)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


# ── POST /design_voice ────────────────────────────────────────────────────

DEFAULT_PREVIEW_TEXT = "你好，这是我为你设计的新音色试听。"


@app.post("/design_voice")
async def design_voice(request: Request):
    """音色设计：仅通过自然语言描述生成全新音色（无需参考音频）。

    请求 JSON: {"voice_name": str, "voice_description": str, "preview_text": str?}
    流程：
      1. 校验名称/描述；
      2. 将音色定义写入 音色库/{voice_name}.vdesc.json（描述 + 创建时间）；
      3. 用描述 + 试听文本合成试听音频，以 base64 WAV 返回。
    之后即可通过 /tts 的 voiceId 使用该设计音色（合成时自动拼接描述前缀）。
    注意：VoxCPM2 的 Voice Design 一致性有限，同描述多次生成音色可能有差异。
    """
    denied = _check_auth(request)
    if denied:
        return denied

    body = await request.json()
    voice_name = body.get("voice_name", "").strip()
    description = body.get("voice_description", "").strip()
    preview_text = body.get("preview_text", "").strip() or DEFAULT_PREVIEW_TEXT

    safe_name = "".join(c for c in voice_name if c.isalnum() or c in "._-")
    if not safe_name or safe_name != voice_name:
        return JSONResponse(
            {"error": "音色名称只能包含字母、数字、下划线、点、横线"}, status_code=400
        )
    if not description:
        return JSONResponse({"error": "音色描述不能为空"}, status_code=400)

    # 同名冲突：克隆(.pt) 或设计(.vdesc.json) 已存在 → 409（前端提示换名）
    if (VOICE_LIBRARY_DIR / f"{safe_name}.pt").exists() or (VOICE_LIBRARY_DIR / f"{safe_name}.vdesc.json").exists():
        return JSONResponse(
            {"error": f"音色 '{safe_name}' 已存在，请更换名称"}, status_code=409
        )

    # 写入音色定义文件
    save_path = VOICE_LIBRARY_DIR / f"{safe_name}.vdesc.json"
    save_path.write_text(
        json.dumps({
            "description": description,
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # 合成试听音频（描述内联，与 /tts 的 desc 分支同一路径）
    try:
        wav_bytes = await asyncio.to_thread(
            _synthesize_full, preview_text, ("desc", {"description": description})
        )
    except Exception as e:
        logger.exception("音色设计试听合成失败")
        return JSONResponse({"error": f"试听合成失败: {e}"}, status_code=500)

    preview_b64 = base64.b64encode(wav_bytes).decode("ascii")
    logger.info(f"音色设计成功: {safe_name}")
    return {
        "message": "音色设计成功",
        "voice_name": safe_name,
        "preview_audio": preview_b64,
    }


# ── 入口 ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=TTS_HOST, port=TTS_PORT)
