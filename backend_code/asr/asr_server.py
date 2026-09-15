"""
SenseVoice 语音识别 (ASR) 后端服务
=====================================
使用阿里 FunASR + SenseVoiceSmall 本地模型做语音转文字，替代浏览器内置识别
（360 安全浏览器等在国内网络下无法连接浏览器内置的云端语音服务，本地模型不受影响）。

接口：
    GET  /health         健康检查（含模型就绪状态）
    POST /asr            上传音频（multipart 字段 file，建议 16kHz 单声道 WAV），返回 {text}

运行（复用 voxcpm2 conda 环境，该环境已装 funasr/modelscope/torch）：
    D:\\Miniconda3\\envs\\voxcpm2\\python.exe asr_server.py

首次运行会自动从 ModelScope 下载约 1GB 的 SenseVoiceSmall 模型（国内网络可下载，
缓存目录由环境变量 MODELSCOPE_CACHE 决定，本机为 D:\\modelscope）。

环境变量（可选）：
    SENSEVOICE_MODEL  模型 ID，默认 iic/SenseVoiceSmall
    ASR_HOST          监听地址，默认 0.0.0.0
    ASR_PORT          端口，默认 5002
    ASR_API_KEY       若设置则启用鉴权（请求头 X-API-Key），默认无鉴权（开发环境）
"""
import asyncio
import os
import re
import threading
import time
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# ========== 配置 ==========
ASR_MODEL = os.environ.get("SENSEVOICE_MODEL", "iic/SenseVoiceSmall")
ASR_HOST = os.environ.get("ASR_HOST", "0.0.0.0")
ASR_PORT = int(os.environ.get("ASR_PORT", "5002"))
API_KEY = os.environ.get("ASR_API_KEY", "")
REQUIRE_AUTH = bool(API_KEY)          # 若密钥非空则启用鉴权
MAX_UPLOAD_BYTES = 20 * 1024 * 1024   # 单次上传上限 20MB

# SenseVoice 输出会带 <|zh|><|NEUTRAL|><|Speech|> 等标记，需要剔除
_TAG_RE = re.compile(r"<\|[^|]*\|>")


async def require_api_key(request: Request):
    """依赖注入：要求请求头中包含正确的 X-API-Key"""
    if REQUIRE_AUTH:
        auth_header = request.headers.get("X-API-Key")
        if not auth_header or auth_header != API_KEY:
            raise HTTPException(status_code=401, detail="未授权访问，请提供有效的 API Key")


app = FastAPI(title="SenseVoice ASR API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ========== 模型（懒加载：首次请求时才加载，启动秒开） ==========
_model = None
_model_lock = threading.Lock()


def _device():
    try:
        import torch
        return "cuda:0" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _ensure_model():
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        from funasr import AutoModel
        dev = _device()
        print(f"[ASR] 正在加载模型 {ASR_MODEL} (device={dev})，首次运行需下载约 1GB ...", flush=True)
        t0 = time.time()
        # trust_remote_code=True：SenseVoiceSmall 为 ModelScope 自定义 pipeline
        # check_latest=False：已缓存时跳过联网检查，启动更快
        _model = AutoModel(
            model=ASR_MODEL,
            trust_remote_code=True,
            device=dev,
            disable_update=True,
            check_latest=False,
        )
        print(f"[ASR] 模型加载完成，耗时 {time.time() - t0:.1f}s", flush=True)
        return _model


def _clean_text(raw: str) -> str:
    if not raw:
        return ""
    return _TAG_RE.sub("", raw).strip()


def _recognize_sync(audio_path: str) -> dict:
    model = _ensure_model()
    # language=auto 自动识别中/英/日/韩等；use_itn 数字格式化；ban_emo_unk 关闭表情/未知
    res = model.generate(
        input=audio_path,
        cache={},
        language="auto",
        use_itn=True,
        ban_emo_unk=True,
    )
    raw = ""
    if res and isinstance(res, list) and isinstance(res[0], dict):
        raw = res[0].get("text") or ""
    return {"text": _clean_text(raw), "raw": raw}


# ========== 接口 ==========
@app.on_event("startup")
def _startup_eager_load():
    """启动后在后台线程预加载模型（首次运行会先下载约 1GB），避免首个请求长时间等待。"""
    threading.Thread(target=_ensure_model, daemon=True, name="sensevoice-loader").start()


@app.get("/health")
async def health():
    return {"status": "ok", "ready": _model is not None, "device": _device()}


@app.post("/asr")
async def recognize(file: UploadFile = File(...), _=Depends(require_api_key)):
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="空音频文件")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="音频文件过大（上限 20MB）")

    # 保留原始扩展名写入临时文件（wav 可直接被 funasr 读取）
    suffix = Path(file.filename or "audio.wav").suffix.lower()
    if suffix not in (".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac", ".webm"):
        suffix = ".wav"
    import tempfile

    fd, tmp_name = tempfile.mkstemp(suffix=suffix)
    os.close(fd)  # 先释放句柄，避免 Windows 文件占用
    tmp_path = Path(tmp_name)
    try:
        tmp_path.write_bytes(content)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _recognize_sync, str(tmp_path))
    except Exception as exc:  # noqa: BLE001 — 模型/解码异常统一转 HTTP 500
        print(f"[ASR] 识别失败: {exc}", flush=True)
        raise HTTPException(status_code=500, detail=f"识别失败：{exc}") from exc
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    print(f"[ASR] SenseVoice ASR 服务启动: http://{ASR_HOST}:{ASR_PORT}  (device={_device()})", flush=True)
    uvicorn.run(app, host=ASR_HOST, port=ASR_PORT)
