# 关于AI聊天网页 “虚拟AI·暗夜对话·灵境投影”

**开发者**：来自广州大学的2024级学生

**开发时间**：从2026年3月31日到今日

**开发语言**：前端：HTML, CSS, JavaScript, 后端：Python3.12

---

## 使用方法

- 直接用浏览器打开index.html文件就行，手机和电脑端都支持访问
- 网页端默认支持调用ollama模型提供商的模型，以及其他openai兼容的格式。若使用ollama模型，请注意需要添加环境变量然后重启ollama服务，否则无法调用模型

```bash
set OLLAMA_ORIGINS=*
```

- 如果需要用语音合成功能，则安装requirements.txt依赖项运行app.py。本人使用的是qwen-tts语音合成接口，配置教程请参考链接：[https://modelscope.cn/models/Qwen/Qwen3-TTS-12Hz-1.7B-Base/summary](https://modelscope.cn/models/Qwen/Qwen3-TTS-12Hz-1.7B-Base/summary)
- 以防不知道，双击消息可以打开操作栏进行删除消息等操作
- 对话导入功能只支持从左侧智能体列表导出的会话文件，不支持话题管理的对话导出文件

## 注意事项

- 本项目仅供学习和交流使用，请勿用于商业用途。
- 网站内容和功能均由AI自动生成，开发者未直接参与代码编写。
- 如有侵权或不当之处，请及时联系删除。

## 联系方式

- qq邮箱：[2083180893@qq.com](mailto:2083180893@qq.com)

感谢您的关注与支持！
