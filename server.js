require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { getDb, UPLOADS_DIR, loadAiConfig, saveAiConfig } = require('./db');
const { analyzeAudio } = require('./analyzer');
const { interpretRecording, reloadAiConfig, testAiConnection } = require('./ai');

// Canvas 检测（用于频谱图格式判断）
let Canvas;
try { Canvas = require('canvas'); Canvas.createCanvas(1, 1); } catch { Canvas = null; }

const app = express();
const PORT = process.env.PORT || 3010;
const isDev = process.env.NODE_ENV !== 'production';

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// multer 配置
const ALLOWED_EXTENSIONS = new Set(['.webm', '.ogg', '.wav', '.mp3', '.m4a']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.webm';
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的音频格式: ${ext}，允许: ${[...ALLOWED_EXTENSIONS].join(', ')}`));
    }
  }
});

const ALLOWED_IMAGE_TYPES = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const mixedUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (file.fieldname === 'audio') {
        cb(null, UPLOADS_DIR);
      } else {
        const framesDir = path.join(UPLOADS_DIR, 'frames');
        fs.mkdirSync(framesDir, { recursive: true });
        cb(null, framesDir);
      }
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${uuidv4()}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === 'audio') {
      cb(null, ALLOWED_EXTENSIONS.has(ext));
    } else if (file.fieldname === 'frame') {
      cb(null, ALLOWED_IMAGE_TYPES.has(ext));
    } else {
      cb(null, false);
    }
  }
});

// MIME 类型映射
const MIME_MAP = {
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4'
};

// ======== API 路由 ========

// 上传录音（支持音频 + 视频帧）
app.post('/api/recordings/upload', mixedUpload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'frames', maxCount: 3 }
]), async (req, res) => {
  try {
    const audioFile = req.files?.audio?.[0];
    if (!audioFile) {
      return res.status(400).json({ error: '缺少音频文件' });
    }

    const db = getDb();
    const id = uuidv4();
    const actualDuration = req.body.duration_ms ? parseInt(req.body.duration_ms) : null;
    const triggerType = req.body.trigger_type || 'manual';

    // 生成频谱图 + 特征提取
    const { generateSpectrogram } = require('./spectrogram');
    const specResult = await generateSpectrogram(audioFile.path);

    // 保存频谱图
    let spectrogramPath = null;
    if (specResult.spectrogramBuffer) {
      const ext = Canvas ? '.png' : '.svg';
      spectrogramPath = `spec_${id}${ext}`;
      fs.writeFileSync(
        path.join(UPLOADS_DIR, spectrogramPath),
        specResult.spectrogramBuffer
      );
    }

    // 合并实际时长和频谱分析时长
    const features = {
      ...specResult.features,
      duration_ms: actualDuration || specResult.features.duration_ms,
      file_size: audioFile.size
    };

    // 插入录音记录
    db.prepare(`
      INSERT INTO recordings (id, filename, original_name, duration_ms, file_size, trigger_type, spectrogram_path, features_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, audioFile.filename, audioFile.originalname,
      features.duration_ms, audioFile.size, triggerType,
      spectrogramPath, JSON.stringify(features)
    );

    // 保存视频帧
    const frameFiles = req.files?.frames || [];
    for (let i = 0; i < frameFiles.length; i++) {
      db.prepare(`
        INSERT INTO frames (recording_id, frame_index, filename, captured_at)
        VALUES (?, ?, ?, ?)
      `).run(id, i, frameFiles[i].filename,
        i === 0 ? 'start' : (i === frameFiles.length - 1 ? 'end' : 'middle')
      );
    }

    // 创建默认标签
    db.prepare(`
      INSERT INTO labels (recording_id, label_type, category, emotion)
      VALUES (?, 'auto', ?, ?)
    `).run(id, 'cat_meow', 'neutral');

    res.json({ id, features, spectrogram: spectrogramPath, frameCount: frameFiles.length });
  } catch (err) {
    console.error('上传失败:', err);
    res.status(500).json({ error: isDev ? err.message : '上传失败' });
  }
});

// 录音列表（分页）
app.get('/api/recordings', (req, res) => {
  try {
    const db = getDb();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const total = db.prepare('SELECT COUNT(*) as count FROM recordings').get().count;

    const recordings = db.prepare(`
      SELECT r.*,
        (SELECT json_group_array(json_object('frame_index', f.frame_index, 'filename', f.filename))
         FROM frames f WHERE f.recording_id = r.id) as frames_json,
        i.id as interp_id, i.translation, i.emotion as interp_emotion,
        i.confidence as interp_confidence, i.suggestion, i.model, i.created_at as interp_at
      FROM recordings r
      LEFT JOIN interpretations i ON i.recording_id = r.id
        AND i.id = (SELECT MAX(id) FROM interpretations WHERE recording_id = r.id)
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    // 附带标签（批量查询，避免 N+1）
    const recordingIds = recordings.map(r => r.id);
    let labelsByRecording = {};
    if (recordingIds.length > 0) {
      const placeholders = recordingIds.map(() => '?').join(',');
      const allLabels = db.prepare(
        `SELECT * FROM labels WHERE recording_id IN (${placeholders})`
      ).all(...recordingIds);
      allLabels.forEach(l => {
        if (!labelsByRecording[l.recording_id]) labelsByRecording[l.recording_id] = [];
        labelsByRecording[l.recording_id].push(l);
      });
    }

    const result = recordings.map(r => {
      const labels = labelsByRecording[r.id] || [];
      const interpretation = r.interp_id ? {
        id: r.interp_id,
        translation: r.translation,
        emotion: r.interp_emotion,
        confidence: r.interp_confidence,
        suggestion: r.suggestion,
        model: r.model,
        created_at: r.interp_at
      } : null;
      // 解析 features
      let features = null;
      try { features = r.features_json ? JSON.parse(r.features_json) : null; } catch {}
      // 解析 frames
      let frames = [];
      try { frames = r.frames_json ? JSON.parse(r.frames_json).filter(f => f.frame_index !== null) : []; } catch {}
      // 清理临时字段
      delete r.interp_id; delete r.translation; delete r.interp_emotion;
      delete r.interp_confidence; delete r.suggestion; delete r.model; delete r.interp_at;
      delete r.features_json; delete r.frames_json;
      return { ...r, labels, interpretation, features, frames };
    });

    res.json({ data: result, page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[List] 错误:', err);
    res.status(500).json({ error: isDev ? err.message : '服务器内部错误' });
  }
});

// 录音详情
app.get('/api/recordings/:id', (req, res) => {
  try {
    const db = getDb();
    const recording = db.prepare('SELECT * FROM recordings WHERE id = ?').get(req.params.id);
    if (!recording) return res.status(404).json({ error: '录音不存在' });

    const labels = db.prepare('SELECT * FROM labels WHERE recording_id = ? ORDER BY created_at DESC').all(req.params.id);
    const interpretation = db.prepare('SELECT * FROM interpretations WHERE recording_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.id);
    const frames = db.prepare('SELECT frame_index, filename, captured_at FROM frames WHERE recording_id = ? ORDER BY frame_index').all(req.params.id);

    let features = null;
    try { features = recording.features_json ? JSON.parse(recording.features_json) : null; } catch {}
    delete recording.features_json;

    res.json({ ...recording, labels, interpretation: interpretation || null, features, frames });
  } catch (err) {
    console.error('[Detail] 错误:', err);
    res.status(500).json({ error: isDev ? err.message : '服务器内部错误' });
  }
});

// 获取音频文件
app.get('/api/recordings/:id/audio', (req, res) => {
  try {
    const db = getDb();
    const recording = db.prepare('SELECT filename FROM recordings WHERE id = ?').get(req.params.id);
    if (!recording) return res.status(404).json({ error: '录音不存在' });

    const filePath = path.join(UPLOADS_DIR, recording.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '音频文件不存在' });

    const ext = path.extname(recording.filename).toLowerCase();
    res.set('Content-Type', MIME_MAP[ext] || 'audio/webm');
    res.sendFile(filePath);
  } catch (err) {
    console.error('[Audio] 错误:', err);
    res.status(500).json({ error: isDev ? err.message : '服务器内部错误' });
  }
});

// 获取频谱图
app.get('/api/recordings/:id/spectrogram', (req, res) => {
  const db = getDb();
  const rec = db.prepare('SELECT spectrogram_path FROM recordings WHERE id = ?').get(req.params.id);
  if (!rec?.spectrogram_path) {
    return res.status(404).json({ error: '无频谱图' });
  }
  const filePath = path.join(UPLOADS_DIR, rec.spectrogram_path);
  const ext = path.extname(rec.spectrogram_path).toLowerCase();
  res.set('Content-Type', ext === '.svg' ? 'image/svg+xml' : 'image/png');
  res.sendFile(filePath);
});

// 获取视频帧
app.get('/api/recordings/:id/frames/:index', (req, res) => {
  const db = getDb();
  const frame = db.prepare('SELECT filename FROM frames WHERE recording_id = ? AND frame_index = ?')
    .get(req.params.id, parseInt(req.params.index));
  if (!frame) {
    return res.status(404).json({ error: '无此帧' });
  }
  res.sendFile(path.join(UPLOADS_DIR, 'frames', frame.filename));
});

// 触发 AI 解读
app.post('/api/recordings/:id/interpret', async (req, res) => {
  try {
    const db = getDb();
    const result = await interpretRecording(db, req.params.id);
    res.json(result);
  } catch (err) {
    console.error('[Interpret] 错误:', err);
    res.status(500).json({ error: isDev ? err.message : '服务器内部错误' });
  }
});

// 删除录音
app.delete('/api/recordings/:id', (req, res) => {
  try {
    const db = getDb();
    const recording = db.prepare('SELECT filename, spectrogram_path FROM recordings WHERE id = ?').get(req.params.id);
    if (!recording) return res.status(404).json({ error: '录音不存在' });

    // 删除关联数据（事务包裹，保证原子性）
    const specPath = recording.spectrogram_path;
    const deleteAll = db.transaction((id) => {
      db.prepare('DELETE FROM labels WHERE recording_id = ?').run(id);
      db.prepare('DELETE FROM interpretations WHERE recording_id = ?').run(id);
      db.prepare('DELETE FROM frames WHERE recording_id = ?').run(id);
      db.prepare('DELETE FROM annotations WHERE recording_id = ?').run(id);
      db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
    });
    deleteAll.run(req.params.id);

    // 删除音频文件
    const filePath = path.join(UPLOADS_DIR, recording.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    // 删除频谱图文件
    if (specPath) {
      const fullSpecPath = path.join(UPLOADS_DIR, specPath);
      if (fs.existsSync(fullSpecPath)) fs.unlinkSync(fullSpecPath);
    }

    res.json({ success: true, message: '已删除' });
  } catch (err) {
    console.error('[Delete] 错误:', err);
    res.status(500).json({ error: isDev ? err.message : '服务器内部错误' });
  }
});

// 统计信息
app.get('/api/stats', (req, res) => {
  try {
    const db = getDb();

    const total = db.prepare('SELECT COUNT(*) as count FROM recordings').get().count;
    const today = db.prepare("SELECT COUNT(*) as count FROM recordings WHERE date(created_at) = date('now')").get().count;

    // 按类别分布（从 labels 取最新）
    const byCategory = db.prepare(`
      SELECT category, COUNT(*) as count
      FROM labels
      WHERE category IS NOT NULL AND category != ''
      GROUP BY category
      ORDER BY count DESC
    `).all();

    // 按情绪分布
    const byEmotion = db.prepare(`
      SELECT emotion, COUNT(*) as count
      FROM interpretations
      WHERE emotion IS NOT NULL AND emotion != ''
      GROUP BY emotion
      ORDER BY count DESC
    `).all();

    res.json({ total, today, byCategory, byEmotion });
  } catch (err) {
    console.error('[Stats] 错误:', err);
    res.status(500).json({ error: isDev ? err.message : '服务器内部错误' });
  }
});

// ===== AI 配置 API =====

function maskApiKey(key) {
  if (!key || key.length < 8) return '';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

// 获取 AI 配置（key 脱敏）
app.get('/api/config/ai', (req, res) => {
  const config = loadAiConfig();
  res.json({
    api_base: config.api_base || '',
    api_key_masked: maskApiKey(config.api_key || ''),
    model: config.model || '',
    configured: !!(config.api_base && config.api_key && config.model)
  });
});

// 更新 AI 配置
app.put('/api/config/ai', (req, res) => {
  const { api_base, api_key, model } = req.body;
  if (!api_base || !api_key || !model) {
    return res.status(400).json({ error: '三个字段都必填' });
  }
  saveAiConfig({ api_base, api_key, model });
  // 热更新 ai.js 的配置
  reloadAiConfig({ api_base, api_key, model });
  res.json({ success: true, message: '配置已保存，即时生效' });
});

// 测试 AI 连接
app.post('/api/config/ai/test', async (req, res) => {
  try {
    const result = await testAiConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 确认标注
app.post('/api/recordings/:id/annotation/confirm', (req, res) => {
  const db = getDb();
  const annotation = db.prepare(
    'SELECT id FROM annotations WHERE recording_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(req.params.id);

  if (!annotation) {
    return res.status(404).json({ error: '无标注记录' });
  }

  db.prepare('UPDATE annotations SET is_verified = 1 WHERE id = ?').run(annotation.id);
  res.json({ success: true });
});

// 修正标注
app.put('/api/recordings/:id/annotation', (req, res) => {
  const { behavior, emotion, translation } = req.body;
  const db = getDb();
  const annotation = db.prepare(
    'SELECT id FROM annotations WHERE recording_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(req.params.id);

  if (!annotation) {
    return res.status(404).json({ error: '无标注记录' });
  }

  const updates = [];
  const params = [];
  if (behavior) { updates.push('verified_behavior = ?'); params.push(behavior); }
  if (emotion) { updates.push('emotion = ?'); params.push(emotion); }
  if (translation) { updates.push('translation = ?'); params.push(translation); }
  updates.push('is_verified = 1');
  params.push(annotation.id);

  db.prepare(`UPDATE annotations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// 全局错误处理（multer 等）
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '文件太大，最大 50MB' });
    }
    return res.status(400).json({ error: `上传错误: ${err.message}` });
  }
  if (err) {
    return res.status(500).json({ error: isDev ? err.message : '服务器内部错误' });
  }
  next();
});

// 启动
app.listen(PORT, () => {
  console.log(`🐱 猫语翻译器后端已启动: http://localhost:${PORT}`);
  console.log(`📁 上传目录: ${UPLOADS_DIR}`);
});

module.exports = app;
