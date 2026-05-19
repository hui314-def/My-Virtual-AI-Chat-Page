from flask import Flask, request, jsonify
from flask_cors import CORS
from functools import wraps
import json, random, base64, requests, time, os
from dotenv import load_dotenv


app = Flask(__name__)
CORS(app)

COMFYUI_SERVER =  "127.0.0.1:8188"  # ComfyUI 地址
WORKFLOW_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "image_gen_workflow.json")  # 你的工作流文件

# ========== API Key 配置 ==========
# 从环境变量获取密钥，若未设置则允许无鉴权（开发环境），生产环境务必设置
load_dotenv()
API_KEY = os.environ.get("IMG_API_KEY", "")
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


def load_workflow():
    with open(WORKFLOW_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def set_workflow_params(workflow, prompt, negative, size, count, model):
    """
    根据前端参数动态修改工作流节点，并对输入进行校验。
    - size 格式应为 WIDTHxHEIGHT，例如 1024x768
    - count 转为整数并限制在 1-8
    - 对负面提示使用逗号分隔，不重复累加默认负面词
    """
    # 1. 正面提示词（节点 id: 2）
    workflow["2"]["inputs"]["text"] = prompt

    # 2. 负面提示词（节点 id: 3）
    if negative:
        neg_text = str(negative).strip()
        if neg_text:
            base_neg = workflow["3"]["inputs"].get("text", "") or ""
            if base_neg and not base_neg.endswith((",", ", ")):
                base_neg = base_neg.rstrip() + ", "
            workflow["3"]["inputs"]["text"] = base_neg + neg_text

    # 3. 分辨率与数量（节点 id: 15 EmptyLatentImage）
    import re
    m = re.match(r'^\s*(\d+)\s*[xX]\s*(\d+)\s*$', str(size))
    if not m:
        raise ValueError("size 参数错误，应为 WIDTHxHEIGHT，例如 1024x768")
    width = int(m.group(1))
    height = int(m.group(2))

    # 限定合理范围以避免 oom 或不支持的分辨率
    if not (64 <= width <= 4096 and 64 <= height <= 4096):
        raise ValueError("宽高超出支持范围 (64-4096)")

    workflow["15"]["inputs"]["width"] = width
    workflow["15"]["inputs"]["height"] = height

    # batch_size 校验与限制
    try:
        count_int = int(count)
    except Exception:
        raise ValueError("count 必须为整数")
    if count_int < 1 or count_int > 8:
        raise ValueError("count 必须在 1-8 之间")

    # 限制一次性 batch 大小以避免资源暴涨（这里取 min(count,4) 作为 safeguard）
    workflow["15"]["inputs"]["batch_size"] = min(count_int, 4)

    # 4. 随机种子（节点 id: 4 KSampler）
    workflow["4"]["inputs"]["seed"] = random.randint(0, 2**32 - 1)

    # 5. 可选：根据 model 参数切换 Checkpoint
    #    这里仅示意，如果你有多个模型名称，可在此映射
    #    例如：flux → "fluxDev1_v10.safetensors"
    #    if model == "flux":
    #        workflow["46"]["inputs"]["ckpt_name"] = "flux_dev.safetensors"
    #    elif model == "sd3":
    #        workflow["46"]["inputs"]["ckpt_name"] = "sd3_medium.safetensors"
    #    # 否则保持默认 HighResolution2DLarge_v10.safetensors

    return workflow

def queue_prompt(workflow):
    """提交工作流到 ComfyUI，返回 prompt_id"""
    url = f"http://{COMFYUI_SERVER}/prompt"
    response = requests.post(url, json={"prompt": workflow})
    if response.status_code != 200:
        raise Exception(f"Failed to queue prompt: {response.text}")
    return response.json()["prompt_id"]

def wait_for_images(prompt_id, timeout=120, poll_interval=1.0):
    """
    轮询 ComfyUI history 直到获取到生成的图片，返回图片列表 (bytes)
    """
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
                if images:  # 已经有图片了，返回
                    return images
        # 否则等待后重试
        time.sleep(poll_interval)

    raise TimeoutError(f"Timed out waiting for images for prompt {prompt_id}")

@app.route('/generate_image', methods=['POST'])
@require_api_key
def generate_image():
    data = request.get_json()
    prompt = data.get('prompt', '')
    negative = data.get('negative', '')
    size = data.get('size', '1024x1024')
    count = data.get('count', 1)
    model = data.get('model', 'flux')  # 预留，暂未使用

    if not prompt:
        return jsonify({"error": "请输入图片描述"}), 400

    try:
        workflow = load_workflow()
        workflow = set_workflow_params(workflow, prompt, negative, size, count, model)

        prompt_id = queue_prompt(workflow)
        print(f"Prompt queued: {prompt_id}")
        images = wait_for_images(prompt_id)

        # 转 base64
        images_b64 = []
        for img_bytes in images:
            b64 = base64.b64encode(img_bytes).decode()
            images_b64.append(b64)

        return jsonify({"images": images_b64})
    except ValueError as e:
        # 输入参数校验失败，返回 400
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5050, debug=True)