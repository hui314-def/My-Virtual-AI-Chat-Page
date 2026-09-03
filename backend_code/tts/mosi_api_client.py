"""
MOSI (Moss) API 客户端
======================
对 Moss 开放平台 (https://platform.mosi.cn) /v1 音频接口的完整 Python 封装。

覆盖能力:
  - 单人语音生成 (TTS) — 同步 / 异步 / 流式 (SSE + 原始 PCM)
  - 多人对话语音生成 (TTSD)
  - 音频转写（普通 + 多说话人分离）— 同步 / 异步 / 流式 SSE
  - 音色管理 — 查询列表 / 创建克隆 / 音色生成
  - 文件管理 — 上传 / 列表 / 详情 / 删除
  - 任务查询 — 通用音频任务 & 转写任务

使用方式:
    from mosi_api_client import MossClient

    client = MossClient(api_key="your-api-key")

    # 单人 TTS
    audio_bytes = client.speech("你好世界", voice_id="xxx")

    # 异步 TTS + 轮询
    task = client.speech_async("长文本...", voice_id="xxx")
    result = client.wait_for_task(task["task_id"])

    # 流式 TTS (SSE)
    for event in client.speech_stream("实时语音", voice_id="xxx"):
        print(event)

    # 多说话人
    client.speakers_speech(
        speakers=[{"id": "A", "voice_id": "v1"}, {"id": "B", "voice_id": "v2"}],
        segments=[{"speaker": "A", "text": "你好"}, {"speaker": "B", "text": "你好呀"}],
    )

    # 转写
    result = client.transcribe(file_id="xxx")
    result = client.transcribe_diarize(file_id="xxx")  # 多说话人

依赖: requests, sseclient-py (可选，流式场景建议安装)
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import time
import wave
from typing import Any, BinaryIO, Dict, Generator, Iterator, List, Literal, Optional, Tuple, Union

import requests

logger = logging.getLogger("mosi_api")


# ═══════════════════════════════════════════════════════════════════════════
# 常量
# ═══════════════════════════════════════════════════════════════════════════

BASE_URL = "https://api.mosi.cn"
DEFAULT_POLL_INTERVAL = 3       # 秒
DEFAULT_MAX_WAIT = 300          # 最大等待秒数


# ═══════════════════════════════════════════════════════════════════════════
# 自定义异常
# ═══════════════════════════════════════════════════════════════════════════

class MossError(Exception):
    """基础异常"""
    pass


class MossAPIError(MossError):
    """API 返回的错误（同步）"""

    def __init__(self, status_code: int, error_type: str, message: str,
                 code: Optional[str] = None, param: Optional[str] = None):
        self.status_code = status_code
        self.error_type = error_type
        self.message = message
        self.code = code
        self.param = param
        super().__init__(f"[{status_code}] {error_type}: {message}" + (f" (code={code})" if code else ""))


class MossAsyncError(MossError):
    """异步任务失败"""

    def __init__(self, task_id: str, error_code: int, error_msg: str,
                 internal_error_code: Optional[int] = None,
                 internal_error_msg: Optional[str] = None):
        self.task_id = task_id
        self.error_code = error_code
        self.error_msg = error_msg
        self.internal_error_code = internal_error_code
        self.internal_error_msg = internal_error_msg
        super().__init__(f"Task {task_id} failed: [{error_code}] {error_msg}")


class MossTimeoutError(MossError):
    """轮询超时"""
    pass


# ═══════════════════════════════════════════════════════════════════════════
# SSE 事件解析
# ═══════════════════════════════════════════════════════════════════════════

def _parse_sse_stream(response: requests.Response) -> Generator[Dict[str, Any], None, None]:
    """解析 SSE (Server-Sent Events) 流，逐帧生成 dict。

    支持:
      - TTS 流式 (speech.created / speech.audio.delta / speech.audio.done / error)
      - 转写流式 (task.created / transcript.text.delta / transcript.segment.done / ...)
    """
    for line in response.iter_lines(decode_unicode=True):
        if not line:
            continue
        if line.startswith("data: "):
            payload = line[6:]  # 去掉 "data: " 前缀
            if payload == "[DONE]":
                break
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                logger.warning(f"SSE 解析失败: {payload[:200]}")
                continue


def _pcm_to_wav_bytes(pcm_data: bytes, sample_rate: int = 24000,
                      channels: int = 1, bit_depth: int = 16) -> bytes:
    """将原始 PCM 数据封装为 WAV 格式。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(bit_depth // 8)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return buf.getvalue()


# ═══════════════════════════════════════════════════════════════════════════
# 主客户端
# ═══════════════════════════════════════════════════════════════════════════

class MossClient:
    """Moss 开放平台 API 客户端。

    Args:
        api_key: API 密钥，从控制台「API 密钥」页获取。
                 若不传，会尝试读取环境变量 MOSS_API_KEY。
        base_url: API 基础地址，默认 https://api.mosi.cn。
        timeout: HTTP 请求超时秒数。
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = BASE_URL,
        timeout: int = 60,
    ):
        self.api_key = api_key or os.environ.get("MOSS_API_KEY", "")
        if not self.api_key:
            raise MossError("API Key 不能为空，请传入或设置 MOSS_API_KEY 环境变量")

        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {self.api_key}",
        })

    # ── 内部工具 ──────────────────────────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[Dict] = None,
        data: Optional[Dict] = None,
        files: Optional[Dict] = None,
        params: Optional[Dict] = None,
        stream: bool = False,
        raw_response: bool = False,
        timeout: Optional[int] = None,
    ) -> Union[Dict, bytes, requests.Response]:
        """发送请求并处理通用错误。"""
        url = f"{self.base_url}{path}"

        _timeout = timeout if timeout is not None else self.timeout
        kwargs: Dict[str, Any] = {"timeout": _timeout, "stream": stream}
        if json_body is not None:
            kwargs["json"] = json_body
        if data is not None:
            kwargs["data"] = data
        if files is not None:
            kwargs["files"] = files
        if params is not None:
            kwargs["params"] = params

        resp = self._session.request(method, url, **kwargs)

        if raw_response:
            return resp

        # 流式响应直接返回 Response 对象
        if stream:
            resp.raise_for_status()
            return resp

        # 非流式：解析 JSON 或二进制
        content_type = resp.headers.get("Content-Type", "")

        if "application/json" in content_type:
            body = resp.json()

            if not resp.ok:
                error_info = body.get("error", {})
                raise MossAPIError(
                    status_code=resp.status_code,
                    error_type=error_info.get("type", "unknown_error"),
                    message=error_info.get("message", "Unknown error"),
                    code=error_info.get("code"),
                    param=error_info.get("param"),
                )
            return body

        # 非 JSON 响应（如音频二进制）
        resp.raise_for_status()
        return resp.content

    # ── 模型 ──────────────────────────────────────────────────────────────

    def list_models(self) -> List[Dict]:
        """查询可用模型列表。GET /v1/models"""
        resp = self._request("GET", "/v1/models")
        # 返回格式取决于服务端，包装为统一形式
        return resp if isinstance(resp, list) else resp.get("data", resp.get("models", []))

    # ── 文件管理 ──────────────────────────────────────────────────────────

    def upload_file(
        self,
        file_path: Optional[str] = None,
        file_data: Optional[bytes] = None,
        filename: Optional[str] = None,
        purpose: Optional[str] = None,
    ) -> Dict:
        """上传文件。POST /v1/files

        可通过 file_path 指定本地文件路径，或通过 file_data + filename 传入内存数据。
        """
        if file_path:
            filename = filename or os.path.basename(file_path)
            with open(file_path, "rb") as f:
                file_data = f.read()

        if not file_data or not filename:
            raise MossError("必须提供 file_path 或 file_data+filename")

        files = {"file": (filename, io.BytesIO(file_data))}
        data = {}
        if purpose:
            data["purpose"] = purpose

        return self._request("POST", "/v1/files", data=data, files=files)

    def list_files(self) -> List[Dict]:
        """查询文件列表。GET /v1/files"""
        resp = self._request("GET", "/v1/files")
        return resp if isinstance(resp, list) else resp.get("data", resp.get("files", []))

    def get_file(self, file_id: str) -> Dict:
        """查询文件详情。GET /v1/files/{file_id}"""
        return self._request("GET", f"/v1/files/{file_id}")

    def delete_file(self, file_id: str) -> Dict:
        """删除文件。DELETE /v1/files/{file_id}"""
        return self._request("DELETE", f"/v1/files/{file_id}")

    # ── 单人语音生成 (TTS) ────────────────────────────────────────────────

    def speech(
        self,
        input_text: str,
        voice_id: str,
        model: str = "moss-tts",
        version: Optional[str] = None,
        response_format: Literal["mp3", "wav", "pcm"] = "mp3",
        delivery_method: Literal["audio", "url"] = "audio",
    ) -> Union[bytes, Dict]:
        """单人文本转语音（同步）。POST /v1/audio/speech

        Args:
            input_text: 待合成文本。
            voice_id: 音色 ID（必须，不支持 URL/文件/base64）。
            model: 模型名称，默认 moss-tts。
            version: 模型版本，不传使用默认。
            response_format: 音频格式，mp3/wav/pcm。
            delivery_method:
                - "audio": 直接返回音频二进制 bytes
                - "url": 返回 dict，含 url/download_url 字段

        Returns:
            delivery_method=audio → bytes
            delivery_method=url → dict
        """
        body = {
            "model": model,
            "input": input_text,
            "voice_id": voice_id,
            "response_format": response_format,
            "delivery_method": delivery_method,
        }
        if version:
            body["version"] = version

        if delivery_method == "audio":
            return self._request("POST", "/v1/audio/speech", json_body=body)
        else:
            return self._request("POST", "/v1/audio/speech", json_body=body)

    def speech_async(
        self,
        input_text: str,
        voice_id: str,
        model: str = "moss-tts",
        version: Optional[str] = None,
        response_format: Literal["mp3", "wav", "pcm"] = "mp3",
        webhook_url: Optional[str] = None,
    ) -> Dict:
        """单人 TTS（异步）。返回含 task_id 的任务对象。POST /v1/audio/speech"""
        body = {
            "model": model,
            "input": input_text,
            "voice_id": voice_id,
            "response_format": response_format,
            "async": True,
        }
        if version:
            body["version"] = version
        if webhook_url:
            body["webhook_url"] = webhook_url

        return self._request("POST", "/v1/audio/speech", json_body=body)

    def speech_stream(
        self,
        input_text: str,
        voice_id: str,
        stream_format: Literal["sse", "audio"] = "sse",
        language: Optional[str] = None,
        speed: float = 1.0,
        expected_duration_sec: Optional[float] = None,
    ) -> Generator[Dict[str, Any], None, None]:
        """流式 TTS (TTS 1.5 Flash)。POST /v1/audio/speech (stream=true)

        必须使用 version=flash-20260626 和 response_format=pcm。

        Args:
            input_text: 待合成文本。
            voice_id: 音色 ID。
            stream_format:
                - "sse": 返回 SSE 事件生成器，每帧为 dict
                - "audio": 返回原始 PCM 流（生成器 yield bytes）
            language: 语言提示，如 "zh"。
            speed: 语速 0.25~4，默认 1。
            expected_duration_sec: 期望时长（秒）。

        Yields:
            stream_format=sse → dict (type=speech.created/audio.delta/audio.done/error)
            stream_format=audio → bytes (原始 PCM 分片)
        """
        body: Dict[str, Any] = {
            "model": "moss-tts",
            "version": "flash-20260626",
            "input": input_text,
            "voice_id": voice_id,
            "stream": True,
            "response_format": "pcm",
        }
        if stream_format == "sse":
            body["stream_format"] = "sse"
        # 省略 stream_format 或传 "audio" 时返回原始 PCM
        if language:
            body["language"] = language
        if speed is not None:
            body["speed"] = speed
        if expected_duration_sec is not None:
            body["expected_duration_sec"] = expected_duration_sec

        # 流式请求使用较长超时（服务端生成间隙可能较大）
        resp = self._request("POST", "/v1/audio/speech", json_body=body,
                             stream=True, raw_response=True, timeout=300)
        resp.raise_for_status()

        if stream_format == "sse":
            yield from _parse_sse_stream(resp)
        else:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk

    # ── 多人对话语音生成 (TTSD) ───────────────────────────────────────────

    def speakers_speech(
        self,
        speakers: List[Dict[str, str]],
        segments: List[Dict[str, str]],
        model: str = "moss-ttsd",
        version: Optional[str] = None,
        response_format: Literal["mp3", "wav"] = "mp3",
        delivery_method: Literal["audio", "url"] = "audio",
    ) -> Union[bytes, Dict]:
        """多人对话语音生成（同步）。POST /v1/audio/speech/speakers

        Args:
            speakers: [{"id": "A", "voice_id": "xxx"}, {"id": "B", "voice_id": "yyy"}]
            segments: [{"speaker": "A", "text": "你好"}, {"speaker": "B", "text": "你好呀"}]
            model: moss-ttsd。
            delivery_method: "audio" 返回 bytes，"url" 返回 dict。
        """
        body = {
            "model": model,
            "speakers": speakers,
            "segments": segments,
            "response_format": response_format,
            "delivery_method": delivery_method,
        }
        if version:
            body["version"] = version

        return self._request("POST", "/v1/audio/speech/speakers", json_body=body)

    def speakers_speech_async(
        self,
        speakers: List[Dict[str, str]],
        segments: List[Dict[str, str]],
        model: str = "moss-ttsd",
        version: Optional[str] = None,
        response_format: Literal["mp3", "wav"] = "mp3",
        webhook_url: Optional[str] = None,
    ) -> Dict:
        """多人对话（异步）。"""
        body = {
            "model": model,
            "speakers": speakers,
            "segments": segments,
            "response_format": response_format,
            "async": True,
        }
        if version:
            body["version"] = version
        if webhook_url:
            body["webhook_url"] = webhook_url

        return self._request("POST", "/v1/audio/speech/speakers", json_body=body)

    # ── 音频转写 ──────────────────────────────────────────────────────────

    def _build_transcribe_body(
        self,
        model: str,
        version: Optional[str] = None,
        file: Optional[str] = None,
        file_id: Optional[str] = None,
        url: Optional[str] = None,
        audio_url: Optional[str] = None,
        diarize: Optional[bool] = None,
        stream: Optional[bool] = None,
        response_format: Literal["json", "text"] = "json",
        async_mode: bool = False,
        webhook_url: Optional[str] = None,
    ) -> Tuple[Dict, bool]:
        """构建转写请求体，返回 (body, use_multipart)。"""
        # 输入源校验：四选一
        sources = [file, file_id, url, audio_url]
        provided = sum(1 for s in sources if s is not None)
        if provided != 1:
            raise MossError("必须且只能提供 file / file_id / url / audio_url 中的一个")

        use_multipart = file is not None

        body: Dict[str, Any] = {"model": model}
        if version:
            body["version"] = version
        if file_id:
            body["file_id"] = file_id
        if url:
            body["url"] = url
        if audio_url:
            body["audio_url"] = audio_url
        if diarize is not None:
            body["diarize"] = diarize
        if stream is not None:
            body["stream"] = stream
        if response_format != "json":
            body["response_format"] = response_format
        if async_mode:
            body["async"] = True
        if webhook_url:
            body["webhook_url"] = webhook_url

        return body, use_multipart

    def transcribe(
        self,
        *,
        file: Optional[str] = None,
        file_id: Optional[str] = None,
        url: Optional[str] = None,
        audio_url: Optional[str] = None,
        version: Optional[str] = None,
        response_format: Literal["json", "text"] = "json",
    ) -> Union[Dict, str]:
        """普通音频转写（同步）。POST /v1/audio/transcriptions

        使用 moss-transcribe 模型。输入源四选一。响应含 text 字段。
        """
        body, use_multipart = self._build_transcribe_body(
            model="moss-transcribe",
            version=version,
            file=file,
            file_id=file_id,
            url=url,
            audio_url=audio_url,
            response_format=response_format,
        )

        if use_multipart:
            with open(file, "rb") as f:  # type: ignore[arg-type]
                files_data = {"file": (os.path.basename(file), f)}  # type: ignore[arg-type]
                return self._request("POST", "/v1/audio/transcriptions",
                                     data=body, files=files_data)
        else:
            return self._request("POST", "/v1/audio/transcriptions", json_body=body)

    def transcribe_diarize(
        self,
        *,
        file: Optional[str] = None,
        file_id: Optional[str] = None,
        url: Optional[str] = None,
        audio_url: Optional[str] = None,
        version: str = "moss-transcribe-diarize-20260325",
        response_format: Literal["json", "text"] = "json",
    ) -> Union[Dict, str]:
        """多说话人转写（同步、非流式）。POST /v1/audio/transcriptions

        使用 moss-transcribe-diarize 模型，返回含 segments 的结构化结果。
        """
        body, use_multipart = self._build_transcribe_body(
            model="moss-transcribe-diarize",
            version=version,
            file=file,
            file_id=file_id,
            url=url,
            audio_url=audio_url,
            diarize=True,
            response_format=response_format,
        )

        if use_multipart:
            with open(file, "rb") as f:  # type: ignore[arg-type]
                files_data = {"file": (os.path.basename(file), f)}  # type: ignore[arg-type]
                return self._request("POST", "/v1/audio/transcriptions",
                                     data=body, files=files_data)
        else:
            return self._request("POST", "/v1/audio/transcriptions", json_body=body)

    def transcribe_diarize_stream(
        self,
        *,
        file: Optional[str] = None,
        file_id: Optional[str] = None,
        url: Optional[str] = None,
        audio_url: Optional[str] = None,
    ) -> Generator[Dict[str, Any], None, None]:
        """多说话人转写（流式 SSE）。POST /v1/audio/transcriptions

        使用 moss-transcribe-diarize + stream=true，返回 SSE 事件流。
        """
        body, use_multipart = self._build_transcribe_body(
            model="moss-transcribe-diarize",
            version="v20260410-streamparam-20260703",
            file=file,
            file_id=file_id,
            url=url,
            audio_url=audio_url,
            stream=True,
            response_format="json",
        )

        if use_multipart:
            with open(file, "rb") as f:  # type: ignore[arg-type]
                files_data = {"file": (os.path.basename(file), f)}  # type: ignore[arg-type]
                resp = self._request("POST", "/v1/audio/transcriptions",
                                     data=body, files=files_data,
                                     stream=True, raw_response=True, timeout=300)
        else:
            resp = self._request("POST", "/v1/audio/transcriptions",
                                 json_body=body, stream=True, raw_response=True, timeout=300)
        resp.raise_for_status()
        yield from _parse_sse_stream(resp)

    def transcribe_async(
        self,
        *,
        file: Optional[str] = None,
        file_id: Optional[str] = None,
        url: Optional[str] = None,
        audio_url: Optional[str] = None,
        model: Literal["moss-transcribe", "moss-transcribe-diarize"] = "moss-transcribe",
        version: Optional[str] = None,
        diarize: bool = False,
        webhook_url: Optional[str] = None,
    ) -> Dict:
        """音频转写（异步）。POST /v1/audio/transcriptions (async=true)"""
        body, use_multipart = self._build_transcribe_body(
            model=model,
            version=version,
            file=file,
            file_id=file_id,
            url=url,
            audio_url=audio_url,
            diarize=diarize if model == "moss-transcribe-diarize" else None,
            async_mode=True,
            webhook_url=webhook_url,
        )

        if use_multipart:
            with open(file, "rb") as f:  # type: ignore[arg-type]
                files_data = {"file": (os.path.basename(file), f)}  # type: ignore[arg-type]
                return self._request("POST", "/v1/audio/transcriptions",
                                     data=body, files=files_data)
        else:
            return self._request("POST", "/v1/audio/transcriptions", json_body=body)

    # ── 音色管理 ──────────────────────────────────────────────────────────

    def list_voices(self) -> List[Dict]:
        """查询音色列表。GET /v1/audio/voices"""
        resp = self._request("GET", "/v1/audio/voices")
        return resp if isinstance(resp, list) else resp.get("data", resp.get("voices", []))

    def create_voice(
        self,
        audio_sample_path: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
    ) -> Dict:
        """克隆/创建音色。POST /v1/audio/voices

        使用参考音频文件创建新音色，返回 voice id。
        """
        with open(audio_sample_path, "rb") as f:
            files = {"audio_sample": (os.path.basename(audio_sample_path), f)}
            data = {}
            if name:
                data["name"] = name
            if description:
                data["description"] = description
            return self._request("POST", "/v1/audio/voices", data=data, files=files)

    def generate_voice(
        self,
        *,
        instruction: Optional[str] = None,
        text: Optional[str] = None,
        reference_voice_id: Optional[str] = None,
        model: str = "moss-voice-generator-1.0",
        delivery_method: Literal["audio", "url"] = "url",
        response_format: Optional[str] = None,
        async_mode: bool = False,
        webhook_url: Optional[str] = None,
    ) -> Dict:
        """音色/语音生成。POST /v1/audio/voice/generations

        音色设计（voice design）场景：
          model       = moss-voice-generator-1.0
          instruction = 自然语言描述目标声音风格（如"温柔、略带微笑感的年轻女声"）
          input       = 待合成文本
        delivery_method="audio" 时返回音频二进制（配合 response_format="wav" 拿 WAV）。
        """
        body: Dict[str, Any] = {
            "model": model,
            "delivery_method": delivery_method,
        }
        if instruction:
            body["instruction"] = instruction
        if text:
            body["input"] = text
        if reference_voice_id:
            body["reference_voice_id"] = reference_voice_id
        if response_format:
            body["response_format"] = response_format
        if async_mode:
            body["async"] = True
        if webhook_url:
            body["webhook_url"] = webhook_url

        return self._request("POST", "/v1/audio/voice/generations", json_body=body)

    # ── 任务查询 ──────────────────────────────────────────────────────────

    def get_task(self, task_id: str) -> Dict:
        """查询通用音频任务。GET /v1/audio/tasks/{task_id}"""
        return self._request("GET", f"/v1/audio/tasks/{task_id}")

    def get_transcription_task(self, task_id: str) -> Dict:
        """查询转写任务。GET /v1/audio/transcriptions/{task_id}"""
        return self._request("GET", f"/v1/audio/transcriptions/{task_id}")

    def wait_for_task(
        self,
        task_id: str,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        max_wait: float = DEFAULT_MAX_WAIT,
        on_progress: Optional[callable] = None,
    ) -> Dict:
        """轮询等待异步任务完成。

        Args:
            task_id: 任务 ID。
            poll_interval: 轮询间隔（秒），建议从 retry_after 起步。
            max_wait: 最大等待时间（秒）。
            on_progress: 可选回调，签名为 (status: str, elapsed: float) -> None。

        Returns:
            任务完成后展开的结果 dict。

        Raises:
            MossTimeoutError: 超时未完成。
            MossAsyncError: 任务失败。
        """
        start = time.time()
        while True:
            elapsed = time.time() - start
            if elapsed > max_wait:
                raise MossTimeoutError(f"任务 {task_id} 在 {max_wait}s 内未完成")

            task = self.get_task(task_id)
            status = task.get("status", "")

            if on_progress:
                on_progress(status, elapsed)

            if status == "SUCCESS":
                return task
            elif status == "FAILED":
                err = task.get("error", {})
                raise MossAsyncError(
                    task_id=task_id,
                    error_code=err.get("error_code", 0),
                    error_msg=err.get("error_msg", "Unknown"),
                    internal_error_code=err.get("internal_error_code"),
                    internal_error_msg=err.get("internal_error_msg"),
                )
            elif status in ("PENDING", "PROCESSING"):
                retry = task.get("retry_after", poll_interval)
                time.sleep(retry)
            else:
                logger.warning(f"未知任务状态: {status}, 继续轮询…")
                time.sleep(poll_interval)

    def download_result(self, url: str, output_path: str) -> str:
        """下载任务结果的音频文件到本地。

        Returns:
            保存的文件路径。
        """
        resp = requests.get(url, timeout=self.timeout)
        resp.raise_for_status()
        with open(output_path, "wb") as f:
            f.write(resp.content)
        return output_path

    # ── 便捷: 流式 TTS → 完整音频 ───────────────────────────────────────

    def speech_stream_to_wav(
        self,
        input_text: str,
        voice_id: str,
        output_path: Optional[str] = None,
        speed: float = 1.0,
        language: Optional[str] = None,
    ) -> bytes:
        """流式 TTS 合成并汇集成完整 WAV 文件/bytes。

        从 SSE 事件的 speech.audio.delta 分片中收集 PCM 数据，
        利用 speech.created 中的 format 参数组装 WAV。

        Args:
            input_text: 待合成文本。
            voice_id: 音色 ID。
            output_path: 可选，保存到本地文件。
            speed: 语速。
            language: 语言提示。

        Returns:
            WAV 格式的音频 bytes。
        """
        pcm_chunks: List[bytes] = []
        sample_rate = 24000
        channels = 1
        bit_depth = 16

        for event in self.speech_stream(
            input_text=input_text,
            voice_id=voice_id,
            stream_format="sse",
            speed=speed,
            language=language,
        ):
            etype = event.get("type", "")

            if etype == "speech.created":
                fmt = event.get("format", "pcm")
                if fmt != "pcm":
                    raise MossError(f"不支持的流式格式: {fmt}")
                sample_rate = event.get("sample_rate", sample_rate)
                channels = event.get("channels", channels)
                bit_depth = event.get("bit_depth", bit_depth)

            elif etype == "speech.audio.delta":
                audio_b64 = event.get("audio", "")
                if audio_b64:
                    pcm_chunks.append(base64.b64decode(audio_b64))

            elif etype == "speech.audio.done":
                break

            elif etype == "error":
                err = event.get("error", {})
                raise MossError(f"流式 TTS 错误: {err.get('message', str(err))}")

        pcm_data = b"".join(pcm_chunks)
        wav_bytes = _pcm_to_wav_bytes(pcm_data, sample_rate, channels, bit_depth)

        if output_path:
            with open(output_path, "wb") as f:
                f.write(wav_bytes)

        return wav_bytes

    # ── 上下文管理器 ──────────────────────────────────────────────────────

    def close(self):
        """关闭会话。"""
        self._session.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


# ═══════════════════════════════════════════════════════════════════════════
# 使用示例
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    # 需要设置 MOSS_API_KEY 环境变量或直接传入
    import sys

    if not os.environ.get("MOSS_API_KEY"):
        print("请设置 MOSS_API_KEY 环境变量后运行此示例")
        print("  export MOSS_API_KEY=your-key-here")
        sys.exit(1)

    client = MossClient()  # 从环境变量 MOSS_API_KEY 读取

    # ---- 1. 查询可用模型 ----
    print("=== 可用模型 ===")
    models = client.list_models()
    print(json.dumps(models, indent=2, ensure_ascii=False))

    # ---- 2. 查询音色列表 ----
    print("\n=== 音色列表 ===")
    voices = client.list_voices()
    print(f"共有 {len(voices)} 个音色")

    # ---- 3. 同步 TTS（返回 URL）- 适合短文本 ----
    print("\n=== 同步 TTS (URL 模式) ===")
    if voices:
        result = client.speech(
            input_text="你好，欢迎使用 Moss 开放平台。",
            voice_id=voices[0].get("id", ""),
            delivery_method="url",
            response_format="mp3",
        )
        print(json.dumps(result, indent=2, ensure_ascii=False))
        # 下载结果音频
        # client.download_result(result["url"], "output.mp3")

    # ---- 4. 流式 TTS - 适合低延迟场景 ----
    print("\n=== 流式 TTS ===")
    for event in client.speech_stream("实时语音合成测试", voice_id=voices[0].get("id", "")):
        print(f"  [{event.get('type')}]")

    # ---- 5. 上传文件 + 转写 ----
    # file_resp = client.upload_file(file_path="audio.mp3")
    # result = client.transcribe(file_id=file_resp["id"])
    # print(result["text"])

    # ---- 6. 异步 TTS + 轮询 ----
    # task = client.speech_async("这是一段较长的文本...", voice_id=voices[0]["id"])
    # result = client.wait_for_task(task["task_id"])
    # client.download_result(result["url"], "long_output.mp3")

    client.close()
    print("\n完成!")
