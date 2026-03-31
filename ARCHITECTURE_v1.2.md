# 猫语翻译器 v1.2 — 多模态标注系统

## 核心理念

**大模型无法直接听懂猫叫**，但它能"看懂"画面和频谱图。
v1.2 的核心转变：从"猜"到"看"。

```
v1.0: 录音 → 文件大小+时间 → AI 猜一个翻译（纯骗人）
v1.2: 录音+录像 → 频谱图+视频帧 → AI 看画面标注行为 → 积累数据集 → 模式匹配
```

## 数据流

```
┌─────────────────────────────────────────────────────────┐
│  浏览器                                                  │
│  getUserMedia(audio + video)                             │
│  MediaRecorder → 音频 blob                               │
│  video 元素 → canvas 截帧 → 图片 blob                    │
└──────────────┬──────────────────────────┬────────────────┘
               │ 音频                     │ 视频帧
               ▼                          ▼
┌──────────────────────┐    ┌──────────────────────┐
│  后端                 │    │                      │
│  1. 存储音频文件       │    │  2. 存储视频帧图片    │
│  2. 生成频谱图 (PNG)  │    │                      │
│  3. 提取数值特征       │    │                      │
└──────────┬───────────┘    └──────────┬───────────┘
           │                           │
           ▼                           ▼
┌──────────────────────────────────────────────────────┐
│  AI 多模态分析                                        │
│                                                       │
│  输入：                                               │
│  - 频谱图 (image)                                     │
│  - 视频帧 (image)                                     │
│  - 数值特征 (text): 时长/频率分布/能量/节奏             │
│  - 上下文 (text): 时间/触发类型                        │
│                                                       │
│  System Prompt:                                       │
│  "你是猫行为学专家。根据频谱图和视频帧分析猫的行为和意图。  │
│   频谱图显示声音的频率和强度分布。                        │
│   视频帧显示猫的姿态和环境。                             │
│   给出行为分类、情绪判断、解读文字。"                     │
│                                                       │
│  输出：                                               │
│  { behavior, emotion, translation, suggestion,        │
│    spectrum_tags: [...], visual_cues: [...] }          │
└──────────────────────────────────────────────────────┘
```

## 技术方案

### 1. 音频频谱分析

**服务端生成频谱图（推荐）**：

用 Node.js + `fft.js` 做 FFT，再用 `sharp` 或 `canvas` 渲染 PNG。

```
音频文件 → Web Audio API decode → FFT → 频率矩阵 → PNG 频谱图
```

**数值特征提取**（比 v1.0 的"文件大小"靠谱 100 倍）：

| 特征 | 说明 |
|------|------|
| `dominant_freq` | 主频率 Hz（猫叫通常 200-6000 Hz） |
| `freq_range` | 频率范围（低频→高频） |
| `duration_ms` | 实际时长（从前端传） |
| `energy_db` | 平均能量 dB |
| `peak_count` | 波峰数量（叫声次数） |
| `tempo` | 节奏（规律性叫声 vs 一声） |
| `spectral_centroid` | 频谱重心（声音"亮"还是"暗"） |
| `zero_crossing_rate` | 过零率（区分清浊音） |

**实现选型**：

```bash
npm install fft.js node-canvas
```

- `fft.js`：纯 JS FFT 实现，无需编译
- `node-canvas`：服务端渲染 PNG（频谱图、波形图）
- 不用 `sharp`（需要 libvips 编译），node-canvas 更通用

### 2. 视频帧捕获

**前端实现**：

```js
// 录音同时开启摄像头
async function startRecordingWithVideo() {
  const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const videoStream = await navigator.mediaDevices.getUserMedia({ 
    video: { facingMode: 'environment', width: 640 } 
  });
  
  // 录音用 MediaRecorder
  mediaRecorder = new MediaRecorder(audioStream);
  
  // 预览用 video 元素
  const videoEl = document.getElementById('previewVideo');
  videoEl.srcObject = videoStream;
  videoEl.play();
  
  // 停止时截帧
  // 在录音结束时 canvas.drawImage(videoEl) 截取当前帧
}

function captureFrame() {
  const canvas = document.getElementById('frameCanvas');
  const video = document.getElementById('previewVideo');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas.toBlob('image/jpeg', 0.8); // 返回 JPEG blob
}
```

**截帧策略**：
- 录音开始时截 1 帧
- 录音结束时截 1 帧
- 如果录音 > 3 秒，中间再截 1 帧
- 最多 3 帧，上传时一起发

### 3. 后端改造

**新增依赖**：
```json
{
  "fft.js": "^1.1.0",
  "canvas": "^2.11.2"
}
```

**新增模块 `spectrogram.js`**：
```js
// 生成频谱图 PNG
async function generateSpectrogram(audioPath) {
  // 1. 读取音频文件，用 Web Audio API (node) 或 ffmpeg 解码 PCM
  // 2. 分帧 + FFT
  // 3. 计算功率谱密度
  // 4. 用 canvas 渲染频谱图（X轴时间, Y轴频率, 颜色强度）
  // 5. 返回 PNG buffer + 数值特征
}
```

**新增路由**：
```js
// 上传音频+视频帧+触发AI多模态分析
POST /api/recordings/upload
  - audio: 音频文件
  - frames: 视频帧图片（最多3张）
  - duration_ms: 实际时长
  - trigger_type: 触发类型

// 获取频谱图
GET /api/recordings/:id/spectrogram → PNG

// 获取视频帧
GET /api/recordings/:id/frames/:index → JPEG
```

**数据库扩展**：
```sql
ALTER TABLE recordings ADD COLUMN spectrogram_path TEXT;
ALTER TABLE recordings ADD COLUMN features_json TEXT;  -- 数值特征 JSON

CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id TEXT NOT NULL,
  frame_index INTEGER NOT NULL,
  filename TEXT NOT NULL,
  captured_at TEXT,  -- 录音后第几秒截的
  FOREIGN KEY (recording_id) REFERENCES recordings(id)
);
```

### 4. AI 多模态 Prompt 设计

```js
const SYSTEM_PROMPT = `你是猫行为学专家。根据以下信息分析猫的行为和意图：

1. 频谱图：显示猫叫声的频率分布（Y轴）随时间（X轴）的变化。颜色越亮表示该频率能量越强。
2. 视频帧：猫当前的姿态和所处环境。
3. 数值特征：频谱分析提取的关键数据。

常见猫叫声频谱特征：
- 短促高频 (>2000Hz, <200ms): 问候/打招呼
- 长低频拖音 (200-800Hz, >500ms): 抱怨/不满
- 快速重复 (3-5次/秒): 求食/兴奋
- 低沉咕噜 (100-300Hz, 持续): 满足/放松
- 高频嘶嘶 (>4000Hz): 警告/恐惧
- 颤音 (频率快速波动): 发情/社交

请返回 JSON：
{
  "behavior": "行为分类",
  "emotion": "情绪",
  "translation": "拟人化翻译",
  "suggestion": "主人建议",
  "spectrum_tags": ["频谱观察标签"],
  "visual_cues": ["画面观察标签"],
  "confidence": 0.8
}`;

// 调用时传入图片
const messages = [
  { role: 'system', content: SYSTEM_PROMPT },
  { 
    role: 'user', 
    content: [
      { type: 'text', text: `请分析以下猫叫录音：\n数值特征：${JSON.stringify(features)}` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${spectrogramBase64}` } },
      ...frames.map(f => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f}` } }))
    ]
  }
];
```

### 5. 数据集积累

每次 AI 标注后，自动保存到 `annotations` 表：

```sql
CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id TEXT NOT NULL,
  behavior TEXT,          -- AI 标注的行为
  emotion TEXT,           -- AI 标注的情绪
  translation TEXT,       -- AI 翻译
  spectrum_tags TEXT,     -- 频谱标签 JSON
  visual_cues TEXT,       -- 视觉标签 JSON
  confidence REAL,        -- AI 置信度
  is_verified INTEGER DEFAULT 0,  -- 用户是否确认
  verified_behavior TEXT, -- 用户修正的行为
  model TEXT,             -- 使用的模型
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (recording_id) REFERENCES recordings(id)
);
```

**用户确认/修正机制**：
- 前端显示 AI 标注结果
- 用户可以点"确认"或"修正"
- 修正后的数据标记为 verified，权重更高
- 积累足够数据后可用于训练

### 6. 前端 UI 改造

**录音区**：
- 新增视频预览小窗（右下角 160x120 浮窗）
- 录音按钮旁边加"录像模式"开关

**结果展示**：
- 频谱图：结果卡片中展示频谱图缩略图，可点击放大
- 视频帧：以缩略图展示截帧
- spectrum_tags 和 visual_cues 以标签形式展示
- 新增"确认"和"修正"按钮

**历史记录**：
- 每条记录显示频谱图缩略图
- 标注状态指示（已确认/待确认）

## 与 v1.1 的兼容性

- v1.1 的手动录音流程完全保留
- 新增"录像模式"为可选功能
- 没有摄像头的设备降级为纯音频模式（用频谱图分析，无视频帧）
- AI 未配置时仍然返回 mock 数据
- 频谱图生成失败时不阻塞上传流程

## 实现优先级

### P0（必须有）
1. 频谱图生成 + 数值特征提取
2. 前端视频捕获 + 截帧
3. 后端接收音频+图片
4. AI 多模态分析 prompt
5. 结果展示（频谱图+视频帧+标签）

### P1（应该有）
6. 数据标注存储 + 确认/修正机制
7. 历史记录频谱图缩略图
8. 纯音频降级模式

### P2（有了更好）
9. 数据集导出
10. 相似频谱检索
11. 统计分析（行为分布、情绪趋势）

## 技术风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| node-canvas 编译依赖 (Cairo) | 安装复杂 | 提供 Dockerfile 或用 SVG 替代 |
| FFT 精度不够 | 频谱图质量差 | 可用 ffmpeg 生成频谱图作为 fallback |
| 视频帧质量差（光线/角度） | AI 看不清 | 引导用户调整角度，支持多帧 |
| Vision API 成本高 | 费用 | 控制帧数(最多3张)，可配置是否启用 |
| 大模型不认识猫的姿态 | 标注不准 | 通过用户修正逐步校准 prompt |
