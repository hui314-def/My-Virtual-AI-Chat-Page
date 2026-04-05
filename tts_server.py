
import tempfile
import dashscope
from flask import Flask, request, send_file, jsonify
from flask_cors import CORS
from dashscope.audio.tts_v2 import SpeechSynthesizer

app = Flask(__name__)
CORS(app)  # 允许跨域访问

# 从环境变量或直接配置 API Key（建议使用环境变量）
# 生产环境请勿硬编码，可使用 os.getenv('DASHSCOPE_API_KEY')
dashscope.api_key = 'sk-21f6f3be097f49cea346f8390dd81faf'  # 可替换为环境变量

MODEL = "cosyvoice-v1"  # 默认模型

@app.route('/tts', methods=['POST'])
def tts():
    """语音合成接口"""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Invalid request, JSON expected'}), 400

    text = data.get('text', '').strip()
    voice = data.get('voice', 'longhao')  # 默认音色

    if not text:
        return jsonify({'error': 'Text is required'}), 400

    try:
        synthesizer = SpeechSynthesizer(model=MODEL, voice=voice)
        audio_data = synthesizer.call(text)

        if audio_data is None:
            return jsonify({'error': 'TTS synthesis failed'}), 500

        # 使用临时文件保存音频
        with tempfile.NamedTemporaryFile(delete=False, suffix='.mp3') as tmp_file:
            tmp_file.write(audio_data)
            tmp_path = tmp_file.name

        # 返回音频文件
        return send_file(tmp_path, mimetype='audio/mpeg', as_attachment=False, download_name='speech.mp3')

    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)