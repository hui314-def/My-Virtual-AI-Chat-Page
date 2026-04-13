import glob
import torch
import soundfile as sf
from qwen_tts import Qwen3TTSModel
import pickle
import hashlib
import io
from flask import Flask, request, send_file, jsonify
import os
from flask_cors import CORS


VOICE_LIBRARY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "音色库")
os.makedirs(VOICE_LIBRARY_DIR, exist_ok=True)

AUDIO_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "音频缓存")
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

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

def load_all_voice_prompts():
    prompts = {}
    for pkl_file in glob.glob(os.path.join(VOICE_LIBRARY_DIR, "*.pkl")):
        name = os.path.splitext(os.path.basename(pkl_file))[0]
        with open(pkl_file, 'rb') as f:
            prompts[name] = pickle.load(f)
    return prompts

# 初始化时加载
VOICE_PROMPT_MAP = load_all_voice_prompts()


@app.route('/voices', methods=['GET'])
def get_voices():
    """返回可用的音色名称列表"""
    voices = list(VOICE_PROMPT_MAP.keys())
    return jsonify({"voices": voices})

@app.route('/tts', methods=['POST'])
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
        
        buffer = io.BytesIO()
        sf.write(buffer, audio_data, sr, format='wav')
        buffer.seek(0)
        return send_file(buffer, mimetype='audio/wav', as_attachment=False)
    except Exception as e:
        print(f"TTS 生成失败: {e}")
        return jsonify({"error": str(e)}), 500

import tempfile

@app.route('/clone_voice', methods=['POST'])
def clone_voice():
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
    
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)