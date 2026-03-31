# 🐱 Cat Whisperer — 猫语翻译器

AI 驱动的猫叫声分析工具。录下猫叫，AI 帮你翻译。

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## 它能做什么

- 🎤 **录音** — 浏览器直接录音，无需安装任何软件
- 🔍 **分析** — 自动提取音频特征（时间段、时长等）
- 🧠 **AI 翻译** — 调用大语言模型解读猫叫声含义
- 📋 **历史记录** — 查看所有录音，播放回放，展开详情
- 🎨 **暗色 UI** — 紫色 accent 主题，好看好用

## 快速开始

```bash
# 克隆
git clone https://github.com/cwyhkyochen-a11y/cat-whisperer.git
cd cat-whisperer

# 安装依赖
npm install

# 配置 AI（可选，不配也能用 mock 数据）
cp .env.example .env
# 编辑 .env，填入你的 API key

# 启动
npm start
# 打开 http://localhost:3010
```

## AI 配置

在 `.env` 中配置任意 OpenAI 兼容 API：

```env
AI_API_BASE=https://openrouter.ai/api/v1
AI_API_KEY=sk-or-v1-xxxxxxxxxxxx
AI_MODEL=google/gemini-2.0-flash-001
PORT=3010
```

支持的提供商：OpenRouter、OpenAI、任何兼容 OpenAI Chat Completions API 的服务。

未配置 API key 时，系统会返回 mock 数据，方便开发测试。

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/recordings/upload` | 上传音频文件 |
| `GET` | `/api/recordings` | 录音列表（分页） |
| `GET` | `/api/recordings/:id` | 录音详情 |
| `GET` | `/api/recordings/:id/audio` | 音频文件流 |
| `POST` | `/api/recordings/:id/interpret` | 触发 AI 解读 |
| `DELETE` | `/api/recordings/:id` | 删除录音 |
| `GET` | `/api/stats` | 统计数据 |

## 技术栈

**后端**
- Express — Web 服务
- better-sqlite3 — 数据库
- multer — 文件上传

**前端**
- 纯 HTML/CSS/JS，零框架依赖
- MediaRecorder API — 浏览器录音

**AI**
- OpenAI 兼容 API（OpenRouter / OpenAI / 自定义）

## 项目结构

```
cat-whisperer/
├── server.js           # Express 主服务
├── db.js               # SQLite 数据库初始化
├── analyzer.js         # 音频特征提取
├── ai.js               # AI 解读模块
├── public/
│   ├── index.html      # 主页面
│   ├── css/style.css   # 样式
│   └── js/app.js       # 前端逻辑
├── uploads/            # 音频文件存储（gitignore）
└── data/               # 数据库文件（gitignore）
```

## 路线图

- [x] v1.0 — 手动录音 + AI 翻译 + 历史记录
- [ ] v1.1 — VAD 自动检测猫叫、自动触发采集
- [ ] v1.2 — 音频频谱分析、叫声分类模型
- [ ] v2.0 — 硬件端（树莓派/ESP32）、OpenClaw Skill 封装

## 贡献

欢迎 PR！这个项目还在早期，有很多可以改进的地方。

## License

[MIT](LICENSE)
