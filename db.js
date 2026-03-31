const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'cat_whisperer.db');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const CONFIG_PATH = path.join(__dirname, 'data', 'ai_config.json');

// 确保目录存在
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

let db = null;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables(db);
  }
  return db;
}

function initTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      original_name TEXT,
      duration_ms INTEGER,
      sample_rate INTEGER DEFAULT 16000,
      file_size INTEGER,
      trigger_type TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id TEXT NOT NULL,
      label_type TEXT NOT NULL,
      category TEXT,
      emotion TEXT,
      confidence REAL DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (recording_id) REFERENCES recordings(id)
    );

    CREATE TABLE IF NOT EXISTS interpretations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id TEXT NOT NULL,
      translation TEXT NOT NULL,
      emotion TEXT,
      confidence REAL DEFAULT 0,
      suggestion TEXT,
      context TEXT,
      model TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (recording_id) REFERENCES recordings(id)
    );

    CREATE TABLE IF NOT EXISTS frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id TEXT NOT NULL,
      frame_index INTEGER NOT NULL,
      filename TEXT NOT NULL,
      captured_at TEXT,
      FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id TEXT NOT NULL,
      behavior TEXT,
      emotion TEXT,
      translation TEXT,
      spectrum_tags TEXT,
      visual_cues TEXT,
      confidence REAL,
      is_verified INTEGER DEFAULT 0,
      verified_behavior TEXT,
      model TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
    );
  `);

  // 列迁移：recordings 新增字段
  try { db.exec(`ALTER TABLE recordings ADD COLUMN spectrogram_path TEXT`); } catch {}
  try { db.exec(`ALTER TABLE recordings ADD COLUMN features_json TEXT`); } catch {}

  // 索引：frames 和 annotations 表按 recording_id 查询频繁
  db.exec('CREATE INDEX IF NOT EXISTS idx_frames_recording ON frames(recording_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_annotations_recording ON annotations(recording_id)');

  // 迁移：给 labels 和 interpretations 加 ON DELETE CASCADE
  migrateCascade(db);
}

// 迁移：给 labels 和 interpretations 加 ON DELETE CASCADE
function migrateCascade(db) {
  const fkInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='labels'").get();
  if (fkInfo && !fkInfo.sql.includes('ON DELETE CASCADE')) {
    db.exec('PRAGMA foreign_keys=off');
    db.exec(`
      CREATE TABLE labels_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id TEXT NOT NULL,
        label_type TEXT NOT NULL,
        category TEXT,
        emotion TEXT,
        confidence REAL DEFAULT 0,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
      );
      INSERT INTO labels_new SELECT * FROM labels;
      DROP TABLE labels;
      ALTER TABLE labels_new RENAME TO labels;
    `);
    db.exec(`
      CREATE TABLE interpretations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id TEXT NOT NULL,
        translation TEXT NOT NULL,
        emotion TEXT,
        confidence REAL DEFAULT 0,
        suggestion TEXT,
        context TEXT,
        model TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
      );
      INSERT INTO interpretations_new SELECT * FROM interpretations;
      DROP TABLE interpretations;
      ALTER TABLE interpretations_new RENAME TO interpretations;
    `);
    db.exec('PRAGMA foreign_keys=on');
    console.log('[DB] 外键 CASCADE 迁移完成');
  }
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

process.on('SIGTERM', closeDb);
process.on('SIGINT', closeDb);

function loadAiConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {}
  return {
    api_base: process.env.AI_API_BASE || '',
    api_key: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || ''
  };
}

function saveAiConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

module.exports = { getDb, closeDb, UPLOADS_DIR, loadAiConfig, saveAiConfig };
