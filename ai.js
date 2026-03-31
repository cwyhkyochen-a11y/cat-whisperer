const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { analyzeAudio } = require('./analyzer');

// 模块级配置（初始从 .env 读取）
let aiConfig = {
  api_base: process.env.AI_API_BASE || '',
  api_key: process.env.AI_API_KEY || '',
  model: process.env.AI_MODEL || ''
};

// 初始化时也尝试从文件加载
try {
  const { loadAiConfig } = require('./db');
  const fileConfig = loadAiConfig();
  if (fileConfig.api_base && fileConfig.api_key && fileConfig.model) {
    aiConfig = fileConfig;
  }
} catch {}

// 暴露热更新函数
function reloadAiConfig(newConfig) {
  aiConfig = { ...newConfig };
  console.log('[AI] 配置已热更新');
}

// 暴露测试连接函数
async function testAiConnection() {
  if (!aiConfig.api_base || !aiConfig.api_key || !aiConfig.model) {
    return { success: false, message: 'AI 未配置' };
  }
  try {
    const response = await fetch(`${aiConfig.api_base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiConfig.api_key}`
      },
      body: JSON.stringify({
        model: aiConfig.model,
        messages: [{ role: 'user', content: '说"喵"' }],
        max_tokens: 10
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      return { success: false, message: `API 返回 ${response.status}` };
    }
    return { success: true, message: '连接成功' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

const SYSTEM_PROMPT = `你是猫行为学专家，根据以下信息分析猫的行为和意图：

1. 频谱图：显示猫叫声的频率分布（Y轴，频率Hz）随时间（X轴）的变化。颜色越亮表示该频率能量越强。
2. 视频帧（如有）：猫当前的姿态和所处环境。
3. 数值特征：频谱分析提取的关键数据。

常见猫叫声频谱特征参考：
- 短促高频（>2000Hz，<200ms）：问候/打招呼
- 长低频拖音（200-800Hz，>500ms）：抱怨/不满
- 快速重复（3-5次/秒）：求食/兴奋
- 低沉咕噜（100-300Hz，持续）：满足/放松
- 高频嘶嘶（>4000Hz）：警告/恐惧
- 颤音（频率快速波动）：发情/社交

请严格以 JSON 格式返回，不要包含其他文字：
{
  "behavior": "行为分类（如：求食/问候/警告/放松/不满/恐惧/兴奋/发情/其他）",
  "emotion": "情绪（如：happy/seeking/anxious/warning/pain/neutral）",
  "translation": "拟人化翻译，用第一人称猫的口吻",
  "suggestion": "给主人的建议",
  "spectrum_tags": ["频谱观察标签，如：高频短促、低频持续、快速重复等"],
  "visual_cues": ["画面观察标签，如：站立姿态、靠近食盆、竖耳等，没有视频帧时为空数组"],
  "confidence": 0.8
}`;

/**
 * 从 AI 返回文本中提取 JSON
 * 先尝试直接 parse，失败后用括号计数法找到完整 JSON 块
 */
function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // 用括号计数法找到完整 JSON 块
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }

    return null;
  }
}

/**
 * 生成 mock 数据（AI 未配置时使用）
 */
function getMockInterpretation(features) {
  const mockTranslations = [
    {
      behavior: '求食', emotion: 'seeking',
      translation: '喵~ 我饿了，快给我吃的！',
      spectrum_tags: ['中高频', '短促'],
      visual_cues: [],
      confidence: 0.6
    },
    {
      behavior: '放松', emotion: 'happy',
      translation: '咕噜咕噜~ 我很满足，继续摸我~',
      spectrum_tags: ['低频持续'],
      visual_cues: [],
      confidence: 0.7
    },
    {
      behavior: '警告', emotion: 'warning',
      translation: '嘶！离我远点！',
      spectrum_tags: ['高频嘶嘶'],
      visual_cues: [],
      confidence: 0.5
    },
    {
      behavior: '不满', emotion: 'anxious',
      translation: '喵呜~ 有人在家吗？好无聊啊...',
      spectrum_tags: ['长低频'],
      visual_cues: [],
      confidence: 0.6
    },
    {
      behavior: '放松', emotion: 'neutral',
      translation: '咕噜~ 今天阳光真好，别打扰我睡觉',
      spectrum_tags: ['低频持续'],
      visual_cues: [],
      confidence: 0.5
    },
  ];

  // 用数值特征判断倾向
  let preferred = mockTranslations[0];
  if (features.dominant_freq != null) {
    if (features.dominant_freq > 2000) {
      preferred = (features.peak_count != null && features.peak_count > 2) ? mockTranslations[0] : mockTranslations[2];
    } else if (features.dominant_freq < 800) {
      preferred = mockTranslations[1];
    }
  } else if (features.peak_count != null) {
    // fallback: 用波峰数判断
    preferred = features.peak_count > 3 ? mockTranslations[0] : mockTranslations[4];
  }

  return {
    behavior: preferred.behavior,
    emotion: preferred.emotion,
    translation: preferred.translation,
    suggestion: '（AI 未配置，这是模拟数据。请在设置中配置 AI 模型）',
    spectrum_tags: preferred.spectrum_tags,
    visual_cues: preferred.visual_cues,
    confidence: preferred.confidence,
    _warning: 'mock_data - AI service not configured'
  };
}

/**
 * 多模态 AI 调用（支持频谱图 + 视频帧图片）
 * @param {object} features - 数值特征对象
 * @param {object} context - 上下文（时间、触发类型）
 * @param {string|null} spectrogramBase64 - 频谱图 PNG 的 base64 字符串
 * @param {string[]} frameBase64s - 视频帧 JPEG base64 数组
 * @returns {object} 解读结果
 */
async function callAiMultimodal(features, context, spectrogramBase64, frameBase64s) {
  if (!aiConfig.api_base || !aiConfig.api_key || !aiConfig.model) {
    return getMockInterpretation(features);
  }

  // 构建用户消息
  const content = [];

  // 文本部分
  const textParts = [
    `请分析以下猫叫录音：`,
    ``,
    `数值特征：`,
    JSON.stringify(features, null, 2),
    ``,
    `录音上下文：`,
    JSON.stringify(context, null, 2)
  ];

  // 如果有频谱图
  if (spectrogramBase64) {
    textParts.push('', '以下是该录音的频谱图：');
  }

  content.push({ type: 'text', text: textParts.join('\n') });

  // 频谱图图片
  if (spectrogramBase64) {
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${spectrogramBase64}`,
        detail: 'high'
      }
    });
  }

  // 视频帧图片
  for (let i = 0; i < frameBase64s.length; i++) {
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${frameBase64s[i]}`,
        detail: 'low'
      }
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let response;
    try {
      response = await fetch(`${aiConfig.api_base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${aiConfig.api_key}`
        },
        body: JSON.stringify({
          model: aiConfig.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content }
          ],
          temperature: 0.7,
          max_tokens: 800
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`AI API 返回 ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const replyContent = data.choices?.[0]?.message?.content || '';

    const parsed = extractJson(replyContent);
    if (!parsed || !parsed.translation) {
      console.warn('[AI] 无法解析 AI 返回的 JSON，使用 mock 数据');
      const mock = getMockInterpretation(features);
      mock._warning = 'ai_parse_failed';
      return mock;
    }

    return {
      behavior: parsed.behavior || '其他',
      emotion: parsed.emotion || 'neutral',
      translation: parsed.translation,
      suggestion: parsed.suggestion || '无法生成建议',
      spectrum_tags: Array.isArray(parsed.spectrum_tags) ? parsed.spectrum_tags : [],
      visual_cues: Array.isArray(parsed.visual_cues) ? parsed.visual_cues : [],
      confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence) || 0.5))
    };
  } catch (err) {
    console.error('[AI] 调用失败:', err.message);
    const mock = getMockInterpretation(features);
    mock._warning = `ai_call_failed: ${err.message}`;
    return mock;
  }
}

/**
 * 解读指定录音 — 主入口（支持多模态）
 * @param {object} db - 数据库实例
 * @param {string} recordingId - 录音 ID
 * @returns {object} 解读结果
 */
async function interpretRecording(db, recordingId) {
  // 查询录音信息
  const recording = db.prepare('SELECT * FROM recordings WHERE id = ?').get(recordingId);
  if (!recording) {
    throw new Error('录音不存在');
  }

  // 读取数值特征
  const { UPLOADS_DIR } = require('./db');
  const features = recording.features_json
    ? JSON.parse(recording.features_json)
    : analyzeAudio(path.join(UPLOADS_DIR, recording.filename));

  // 查询已有标签
  const labels = db.prepare('SELECT * FROM labels WHERE recording_id = ?').all(recordingId);

  const context = {
    trigger_type: recording.trigger_type,
    created_at: recording.created_at,
    original_name: recording.original_name,
    labels: labels.map(l => ({ category: l.category, emotion: l.emotion, type: l.label_type }))
  };

  // 读取频谱图 base64
  let spectrogramBase64 = null;
  if (recording.spectrogram_path) {
    const specPath = path.join(UPLOADS_DIR, recording.spectrogram_path);
    if (fs.existsSync(specPath)) {
      spectrogramBase64 = fs.readFileSync(specPath).toString('base64');
    }
  }

  // 读取视频帧 base64
  const frameBase64s = [];
  const frames = db.prepare('SELECT * FROM frames WHERE recording_id = ? ORDER BY frame_index').all(recordingId);
  for (const frame of frames) {
    const framePath = path.join(UPLOADS_DIR, 'frames', frame.filename);
    if (fs.existsSync(framePath)) {
      frameBase64s.push(fs.readFileSync(framePath).toString('base64'));
    }
  }

  // 调用多模态 AI
  const result = await callAiMultimodal(features, context, spectrogramBase64, frameBase64s);

  // 保存解读结果（兼容旧格式）
  db.prepare(`
    INSERT INTO interpretations (recording_id, translation, emotion, confidence, suggestion)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    recordingId,
    result.translation,
    result.emotion,
    result.confidence,
    result.suggestion || ''
  );

  // 保存标注（新格式）
  db.prepare(`
    INSERT INTO annotations (recording_id, behavior, emotion, translation, spectrum_tags, visual_cues, confidence, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    recordingId,
    result.behavior,
    result.emotion,
    result.translation,
    JSON.stringify(result.spectrum_tags || []),
    JSON.stringify(result.visual_cues || []),
    result.confidence,
    aiConfig.model || 'unknown'
  );

  // 更新标签
  db.prepare(`DELETE FROM labels WHERE recording_id = ?`).run(recordingId);
  db.prepare(`
    INSERT INTO labels (recording_id, label_type, category, emotion)
    VALUES (?, 'ai', ?, ?)
  `).run(recordingId, result.behavior, result.emotion);

  return result;
}

module.exports = { interpretRecording, reloadAiConfig, testAiConnection };
