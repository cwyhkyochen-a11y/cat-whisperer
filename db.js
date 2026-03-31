const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'cat_whisperer.db');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

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
  `);
}

module.exports = { getDb, UPLOADS_DIR };
