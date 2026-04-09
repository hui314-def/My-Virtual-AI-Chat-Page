import os
import tempfile
import dashscope
from flask import Flask, request, send_file, jsonify, Response
from flask_cors import CORS
from dashscope.audio.tts_v2 import SpeechSynthesizer

app = Flask(__name__)
CORS(app)  # 允许跨域访问

dashscope.api_key = os.getenv('DASHSCOPE_API_KEY')

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

        # 直接返回二进制数据，设置正确的 MIME 类型
        return Response(audio_data, mimetype='audio/mpeg', headers={
            'Content-Disposition': 'inline; filename=speech.mp3'
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)