from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, field_validator
from typing import Optional
import json, random, base64, requests, time, os, re
from dotenv import load_dotenv

app = FastAPI(title="Image & Audio Generation API")

# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

COMFYUI_SERVER = "127.0.0.1:8188"
WORKFLOW_FILE_IMAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "image_gen_workflow.json")
WORKFLOW_FILE_AUDIO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio_stable_audio_example.json")

# ========== API Key 配置 ==========
load_dotenv()
API_KEY = os.environ.get("IMG_API_KEY", "")
REQUIRE_AUTH = bool(API_KEY)


# ---------- 图像生成请求模型 ----------
class GenerateImageRequest(BaseModel):
    prompt: str
    negative: Optional[str] = ""
    size: Optional[str] = "1024x1024"
    count: Optional[int] = 1
    model: Optional[str] = "flux"

    @field_validator("prompt")
    @classmethod
    def prompt_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("请输入图片描述")
        return v

    @field_validator("size")
    @classmethod
    def validate_size(cls, v: str) -> str:
        if not re.match(r'^\s*(\d+)\s*[xX]\s*(\d+)\s*$', v):
            raise ValueError("size 参数错误，应为 WIDTHxHEIGHT，例如 1024x768")
        return v

    @field_validator("count")
    @classmethod
    def validate_count(cls, v: int) -> int:
        if v < 1 or v > 8:
            raise ValueError("count 必须在 1-8 之间")
        return v

# ========== 音频生成请求模型 ==========
class GenerateAudioRequest(BaseModel):
    positive_prompt: str
    negative_prompt: Optional[str] = ""
    duration: Optional[int] = 40
    seed: Optional[int] = None

    @field_validator("positive_prompt")
    @classmethod
    def prompt_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("positive_prompt 不能为空")
        return v

    @field_validator("duration")
    @classmethod
    def validate_duration(cls, v: int) -> int:
        if v < 1 or v > 120:
            raise ValueError("duration 必须在 1~120 秒之间")
        return v

# ---------- 鉴权依赖 ----------
async def verify_api_key(request: Request):
    """从请求头验证 X-API-Key"""
    if REQUIRE_AUTH:
        auth_header = request.headers.get("X-API-Key")
        if not auth_header or auth_header != API_KEY:
            raise HTTPException(status_code=401, detail="未授权访问，请提供有效的 API Key")


# ---------- 工具函数 ----------
def load_workflow(workflow_file):
    with open(workflow_file, 'r', encoding='utf-8') as f:
        return json.load(f)


def set_image_workflow_params(workflow, prompt, negative, size, count):
    # 1. 正面提示词
    workflow["2"]["inputs"]["text"] = prompt

    # 2. 负面提示词
    if negative:
        neg_text = str(negative).strip()
        if neg_text:
            base_neg = workflow["3"]["inputs"].get("text", "") or ""
            if base_neg and not base_neg.endswith((",", ", ")):
                base_neg = base_neg.rstrip() + ", "
            workflow["3"]["inputs"]["text"] = base_neg + neg_text

    # 3. 分辨率与数量
    m = re.match(r'^\s*(\d+)\s*[xX]\s*(\d+)\s*$', str(size))
    width = int(m.group(1))
    height = int(m.group(2))

    if not (64 <= width <= 4096 and 64 <= height <= 4096):
        raise ValueError("宽高超出支持范围 (64-4096)")

    workflow["15"]["inputs"]["width"] = width
    workflow["15"]["inputs"]["height"] = height

    workflow["15"]["inputs"]["batch_size"] = min(count, 4)

    # 4. 随机种子
    workflow["4"]["inputs"]["seed"] = random.randint(0, 2**32 - 1)

    return workflow

def set_audio_workflow_params(workflow, positive, negative, duration):
    workflow["6"]["inputs"]["text"] = positive

    if negative:
        neg_text = str(negative).strip()
        if neg_text:
            base_neg = workflow["7"]["inputs"].get("text", "") or ""
            if base_neg and not base_neg.endswith((",", ", ")):
                base_neg = base_neg.rstrip() + ", "
            workflow["7"]["inputs"]["text"] = base_neg + neg_text

    workflow["11"]["inputs"]["seconds"] = duration

    workflow["3"]["inputs"]["seed"] = random.randint(0, 2**32 - 1)

    return workflow

def queue_prompt(workflow):
    url = f"http://{COMFYUI_SERVER}/prompt"
    response = requests.post(url, json={"prompt": workflow})
    if response.status_code != 200:
        raise Exception(f"Failed to queue prompt: {response.text}")
    return response.json()["prompt_id"]


def wait_for_images(prompt_id, timeout=120, poll_interval=1.0):
    url = f"http://{COMFYUI_SERVER}/history/{prompt_id}"
    start_time = time.time()

    while time.time() - start_time < timeout:
        resp = requests.get(url)
        if resp.status_code != 200:
            raise Exception(f"Failed to get history: {resp.text}")

        history = resp.json()
        if prompt_id in history:
            outputs = history[prompt_id].get("outputs", {})
            if outputs:
                images = []
                for node_id, node_output in outputs.items():
                    if "images" in node_output:
                        for img_info in node_output["images"]:
                            filename = img_info["filename"]
                            subfolder = img_info.get("subfolder", "")
                            img_type = img_info["type"]
                            img_url = f"http://{COMFYUI_SERVER}/view?filename={filename}&subfolder={subfolder}&type={img_type}"
                            img_data = requests.get(img_url).content
                            images.append(img_data)
                if images:
                    return images
        time.sleep(poll_interval)

    raise TimeoutError(f"Timed out waiting for images for prompt {prompt_id}")

def wait_for_audio(prompt_id, timeout=180, poll_interval=1.0):
    url = f"http://{COMFYUI_SERVER}/history/{prompt_id}"
    start_time = time.time()

    while time.time() - start_time < timeout:
        resp = requests.get(url)
        if resp.status_code != 200:
            raise Exception(f"Failed to get history: {resp.text}")

        history = resp.json()
        if prompt_id in history:
            outputs = history[prompt_id].get("outputs", {})
            # 节点 19 是 SaveAudioMP3，其输出可能包含 "audio" 或 "files"
            node_output = outputs.get("19", {})
            audio_list = node_output.get("audio") or node_output.get("files")
            if audio_list and len(audio_list) > 0:
                audio_info = audio_list[0]
                filename = audio_info["filename"]
                subfolder = audio_info.get("subfolder", "")
                img_type = audio_info.get("type", "output")
                file_url = f"http://{COMFYUI_SERVER}/view?filename={filename}&subfolder={subfolder}&type={img_type}"
                audio_resp = requests.get(file_url)
                if audio_resp.status_code == 200:
                    return audio_resp.content
                else:
                    raise Exception(f"Failed to download audio file: {audio_resp.text}")
        time.sleep(poll_interval)

    raise TimeoutError(f"Timed out waiting for audio for prompt {prompt_id}")

# ---------- 路由 ----------
@app.post("/generate_image")
async def generate_image(data: GenerateImageRequest, _=Depends(verify_api_key)):
    """根据提示词生成图片，返回 base64 编码的图片列表"""
    try:
        workflow = load_workflow(WORKFLOW_FILE_IMAGE)
        workflow = set_image_workflow_params(
            workflow, data.prompt, data.negative, data.size, data.count, data.model
        )

        prompt_id = queue_prompt(workflow)
        print(f"Prompt queued: {prompt_id}")
        images = wait_for_images(prompt_id)

        images_b64 = [base64.b64encode(img_bytes).decode() for img_bytes in images]
        return {"images": images_b64}

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------- 全局异常处理 ----------
@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"error": str(exc)})

@app.post("/generate_audio")
async def generate_audio(data: GenerateAudioRequest, _=Depends(verify_api_key)):
    """根据提示词生成音频，返回 MP3 二进制文件"""
    try:
        workflow = load_workflow(WORKFLOW_FILE_AUDIO)
        workflow = set_audio_workflow_params(
            workflow,
            data.positive_prompt,
            data.negative_prompt,
            data.duration
        )

        prompt_id = queue_prompt(workflow)
        print(f"Audio prompt queued: {prompt_id}")
        audio_bytes = wait_for_audio(prompt_id)

        return Response(
            content=audio_bytes,
            media_type="audio/mpeg",
            headers={
                "Content-Disposition": f'attachment; filename="audio_{int(time.time())}.mp3"'
            }
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5050)
