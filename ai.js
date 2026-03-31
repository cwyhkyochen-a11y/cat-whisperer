const { getDb } = require('./db');
const { analyzeAudio } = require('./analyzer');
const path = require('path');

// 从 .env 读取 AI 配置
const AI_API_BASE = process.env.AI_API_BASE;
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL;

const SYSTEM_PROMPT = '你是猫行为学专家，根据音频特征和上下文分析猫叫的含义。请用中文回复。请严格以 JSON 格式返回结果，格式为：{"translation": "翻译结果", "emotion": "情绪", "confidence": 0.8, "suggestion": "建议"}';

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
    { translation: '喵~ 我饿了，快给我吃的！', emotion: 'seeking', confidence: 0.6 },
    { translation: '咕噜咕噜~ 我很满足，继续摸我~', emotion: 'happy', confidence: 0.7 },
    { translation: '嘶！离我远点！', emotion: 'warning', confidence: 0.5 },
    { translation: '喵呜~ 有人在家吗？好无聊啊...', emotion: 'anxious', confidence: 0.6 },
    { translation: '咕噜~ 今天阳光真好，别打扰我睡觉', emotion: 'neutral', confidence: 0.5 },
  ];

  // 根据时间段选择不同倾向的 mock
  const periodEmotionMap = {
    '清晨': 'seeking',
    '上午': 'happy',
    '下午': 'neutral',
    '傍晚': 'seeking',
    '深夜': 'anxious'
  };

  const preferred = mockTranslations.find(t => t.emotion === periodEmotionMap[features.day_period])
    || mockTranslations[0];

  return {
    translation: preferred.translation,
    emotion: preferred.emotion,
    confidence: preferred.confidence,
    suggestion: '（AI 未配置，这是模拟数据。请在 .env 中配置 AI_API_BASE 和 AI_API_KEY）',
    _warning: 'mock_data - AI service not configured'
  };
}

/**
 * 调用 OpenAI 兼容 API 进行猫叫解读
 * @param {object} features - 音频特征
 * @param {object} context - 录音上下文（时间、标签等）
 * @returns {object} 解读结果
 */
async function callAi(features, context) {
  if (!AI_API_BASE || !AI_API_KEY || !AI_MODEL) {
    console.log('[AI] 未配置 AI 服务，使用 mock 数据');
    return getMockInterpretation(features);
  }

  const userPrompt = `请分析以下猫叫声录音的特征并解读含义：

音频特征：
${JSON.stringify(features, null, 2)}

录音上下文：
${JSON.stringify(context, null, 2)}

请严格以 JSON 格式返回，不要包含其他文字。`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let response;
    try {
      response = await fetch(`${AI_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_API_KEY}`
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 500
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
    const content = data.choices?.[0]?.message?.content || '';

    const parsed = extractJson(content);
    if (!parsed || !parsed.translation) {
      console.warn('[AI] 无法解析 AI 返回的 JSON，使用 mock 数据');
      const mock = getMockInterpretation(features);
      mock._warning = 'ai_parse_failed';
      return mock;
    }

    return {
      translation: parsed.translation,
      emotion: parsed.emotion || 'neutral',
      confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence) || 0.5)),
      suggestion: parsed.suggestion || '无法生成建议'
    };
  } catch (err) {
    console.error('[AI] 调用失败:', err.message);
    const mock = getMockInterpretation(features);
    mock._warning = `ai_call_failed: ${err.message}`;
    return mock;
  }
}

/**
 * 解读指定录音 — 主入口
 * @param {object} db - 数据库实例
 * @param {string} recordingId - 录音 ID
 * @returns {object} interpretation 记录
 */
async function interpretRecording(db, recordingId) {
  // 查询录音信息
  const recording = db.prepare('SELECT * FROM recordings WHERE id = ?').get(recordingId);
  if (!recording) {
    throw new Error('录音不存在');
  }

  // 分析音频特征
  const { UPLOADS_DIR } = require('./db');
  const filePath = path.join(UPLOADS_DIR, recording.filename);
  const features = analyzeAudio(filePath);

  // 查询已有标签作为上下文
  const labels = db.prepare('SELECT * FROM labels WHERE recording_id = ?').all(recordingId);

  const context = {
    trigger_type: recording.trigger_type,
    created_at: recording.created_at,
    original_name: recording.original_name,
    labels: labels.map(l => ({ category: l.category, emotion: l.emotion, type: l.label_type }))
  };

  // 调用 AI
  const result = await callAi(features, context);

  // 写入 interpretations 表
  const insert = db.prepare(`
    INSERT INTO interpretations (recording_id, translation, emotion, confidence, suggestion, context, model)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const info = insert.run(
    recordingId,
    result.translation,
    result.emotion,
    result.confidence,
    result.suggestion,
    JSON.stringify({ features, context }),
    AI_MODEL || 'mock'
  );

  // 同时写入一条 auto label
  const labelInsert = db.prepare(`
    INSERT INTO labels (recording_id, label_type, category, emotion, confidence, notes)
    VALUES (?, 'ai', ?, ?, ?, ?)
  `);
  labelInsert.run(recordingId, null, result.emotion, result.confidence, result.translation);

  return {
    id: info.lastInsertRowid,
    recording_id: recordingId,
    translation: result.translation,
    emotion: result.emotion,
    confidence: result.confidence,
    suggestion: result.suggestion,
    model: AI_MODEL || 'mock',
    _warning: result._warning || null
  };
}

module.exports = { interpretRecording };
