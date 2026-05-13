from flask import Flask, request, jsonify
from flask_cors import CORS
import json, random, base64, requests, time, os

app = Flask(__name__)
CORS(app)

COMFYUI_SERVER =  "127.0.0.1:8188"  # ComfyUI 地址
WORKFLOW_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "image_gen_workflow.json")  # 你的工作流文件

def load_workflow():
    with open(WORKFLOW_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def set_workflow_params(workflow, prompt, negative, size, count, model):
    """
    根据前端参数动态修改工作流节点
    """
    # 1. 正面提示词（节点 id: 2）
    workflow["2"]["inputs"]["text"] = prompt

    # 2. 负面提示词（节点 id: 3）
    if negative:
        workflow["3"]["inputs"]["text"] += negative

    # 3. 分辨率与数量（节点 id: 15 EmptyLatentImage）
    width, height = map(int, size.split('x'))
    workflow["15"]["inputs"]["width"] = width
    workflow["15"]["inputs"]["height"] = height
    workflow["15"]["inputs"]["batch_size"] = count

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
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5050, debug=True)