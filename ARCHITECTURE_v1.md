# 猫语翻译器 v1.0 技术架构

## 定位
MVP 版本，验证"录音 → 分析 → AI 翻译"核心链路。
手动触发录音，PC 浏览器作为采集端。

## 技术栈
- **后端**: Express + better-sqlite3 + multer + uuid
- **前端**: 原生 HTML/CSS/JS（无框架，跟 Todo Board 风格一致）
- **AI**: OpenClaw API（通过 HTTP 调用本地 OpenClaw gateway）
- **音频处理**: 后端用 Node.js 做基础分析（不做 FFT，v1.0 简化）

## 目录结构
```
projects/cat-whisperer/
├── server.js              # Express 主服务（路由+启动）
├── db.js                  # SQLite 初始化 + Schema
├── analyzer.js            # 音频特征提取（基础版）
├── ai.js                  # OpenClaw AI 解读模块
├── package.json           # 已有
├── public/
│   ├── index.html         # 主界面
│   ├── css/
│   │   └── style.css      # 样式
│   └── js/
│       └── app.js         # 前端逻辑
└── uploads/               # 音频文件存储（gitignore）
```

## 数据库 Schema (db.js)

### recordings 表
```sql
CREATE TABLE recordings (
  id TEXT PRIMARY KEY,           -- uuid
  filename TEXT NOT NULL,        -- 存储文件名
  original_name TEXT,            -- 原始文件名
  duration_ms INTEGER,           -- 时长（毫秒）
  sample_rate INTEGER DEFAULT 16000,
  file_size INTEGER,             -- 文件大小（字节）
  trigger_type TEXT DEFAULT 'manual',  -- manual/auto/timed
  created_at TEXT DEFAULT (datetime('now'))
);
```

### labels 表
```sql
CREATE TABLE labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id TEXT NOT NULL,    -- 关联 recording
  label_type TEXT NOT NULL,      -- 'auto' / 'ai' / 'manual'
  category TEXT,                 -- 叫声类型: meow/purr/hiss/yowl/chirp/other
  emotion TEXT,                  -- 情绪: happy/anxious/seeking/warning/pain/neutral
  confidence REAL DEFAULT 0,     -- 置信度 0-1
  notes TEXT,                    -- 补充说明
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (recording_id) REFERENCES recordings(id)
);
```

### interpretations 表
```sql
CREATE TABLE interpretations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id TEXT NOT NULL,
  translation TEXT NOT NULL,     -- "翻译"结果
  emotion TEXT,                  -- 综合情绪判断
  confidence REAL DEFAULT 0,
  suggestion TEXT,               -- 给主人的建议
  context TEXT,                  -- AI 分析上下文（JSON）
  model TEXT,                    -- 使用的模型
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (recording_id) REFERENCES recordings(id)
);
```

## API 路由 (server.js)

### 音频管理
- `POST /api/recordings/upload` — 上传音频（multipart/form-data）
- `GET /api/recordings` — 录音列表（分页）
- `GET /api/recordings/:id` — 录音详情（含标签+解读）
- `GET /api/recordings/:id/audio` — 获取音频文件（用于播放）
- `DELETE /api/recordings/:id` — 删除录音

### 标签
- `POST /api/recordings/:id/labels` — 添加人工标签
- `PUT /api/labels/:id` — 修改标签

### 解读
- `POST /api/recordings/:id/interpret` — 触发 AI 解读
- `GET /api/recordings/:id/interpretation` — 获取解读结果

### 统计
- `GET /api/stats` — 总体统计（总数、类型分布、今日数量）

## 前端界面 (index.html)

### 布局
暗色主题，跟 kyo 的项目风格统一。

**顶部栏**: 标题 + 录音状态指示器
**主区域**: 
  - 录音控制面板（大按钮：开始/停止录音 + 录音时长计时器）
  - 最新结果卡片（上传后自动解读，显示翻译结果+情绪）
**下方**: 
  - 历史记录列表（时间+翻译摘要+情绪标签+播放按钮）
  - 统计概览（今日X条 / 总计X条）

### 录音流程
1. 用户点击"开始录音" → getUserMedia 获取麦克风
2. MediaRecorder 录制 → 用户点击"停止"
3. 前端将音频 blob → POST /api/recordings/upload
4. 上传成功 → 自动调用 POST /api/recordings/:id/interpret
5. 解读完成 → 展示结果卡片 + 刷新历史列表

## OpenClaw AI 调用 (ai.js)

通过 HTTP 调用本地 OpenClaw gateway：
```
POST http://localhost:3007/api/chat
```

Prompt 设计：
- System: 猫行为学专家，根据音频特征分析猫的意图
- User: 音频特征 JSON + 录音上下文
- Output: JSON {translation, emotion, confidence, suggestion}

## v1.0 简化的特征提取 (analyzer.js)

不做复杂 DSP，只提取：
1. 文件大小 → 粗略估计时长
2. 从 WebM/OGG 容器解析基本元数据
3. 触发方式（手动=manual）
4. 时间标签（时间段：清晨/上午/下午/傍晚/深夜）

复杂特征（FFT/VAD）留给 v2.0。
