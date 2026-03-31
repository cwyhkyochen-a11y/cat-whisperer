require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { getDb, UPLOADS_DIR } = require('./db');
const { analyzeAudio } = require('./analyzer');
const { interpretRecording } = require('./ai');

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

// MIME 类型映射
const MIME_MAP = {
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4'
};

// ======== API 路由 ========

// 上传录音
app.post('/api/recordings/upload', upload.single('audio'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '未上传音频文件，字段名应为 "audio"' });
    }

    const db = getDb();
    const id = uuidv4();
    const filePath = path.join(UPLOADS_DIR, req.file.filename);
    const actualDuration = req.body.duration_ms ? parseInt(req.body.duration_ms) : null;
    const triggerType = req.body.trigger_type || 'manual';
    const features = analyzeAudio(filePath, actualDuration);

    // 插入 recording
    db.prepare(`
      INSERT INTO recordings (id, filename, original_name, duration_ms, file_size, trigger_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.file.filename, req.file.originalname, features.duration_estimate, features.file_size, triggerType);

    // 自动创建一条 auto label（基于时间段）
    db.prepare(`
      INSERT INTO labels (recording_id, label_type, category, emotion, confidence, notes)
      VALUES (?, 'auto', 'other', ?, 0.3, ?)
    `).run(id, 'neutral', `录制于${features.day_period} ${features.time_of_day}`);

    const recording = db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
    recording.features = features;

    res.json(recording);
  } catch (err) {
    console.error('[Upload] 错误:', err);
    res.status(500).json({ error: isDev ? err.message : '服务器内部错误' });
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
      // 清理临时字段
      delete r.interp_id; delete r.translation; delete r.interp_emotion;
      delete r.interp_confidence; delete r.suggestion; delete r.model; delete r.interp_at;
      return { ...r, labels, interpretation };
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

    res.json({ ...recording, labels, interpretation: interpretation || null });
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
    const recording = db.prepare('SELECT filename FROM recordings WHERE id = ?').get(req.params.id);
    if (!recording) return res.status(404).json({ error: '录音不存在' });

    // 删除关联数据（事务包裹，保证原子性）
    const deleteAll = db.transaction((id) => {
      db.prepare('DELETE FROM labels WHERE recording_id = ?').run(id);
      db.prepare('DELETE FROM interpretations WHERE recording_id = ?').run(id);
      db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
    });
    deleteAll.run(req.params.id);

    // 删除音频文件
    const filePath = path.join(UPLOADS_DIR, recording.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

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
