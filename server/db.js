// SQLite storage using Node's built-in driver (no native build needed).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'klquiz.db'));
// synchronous=NORMAL is the recommended setting with WAL: commits no longer wait for a disk flush (every answer
// save used to block the single JS thread on fsync). The database cannot be corrupted; only an OS crash or power
// cut could lose the last moments of saves, which the exam page retries anyway.
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS exam_templates (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  departments TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'ONLINE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS template_sections (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES exam_templates(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  question_count INTEGER NOT NULL,
  syllabus TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY,
  template_id INTEGER REFERENCES exam_templates(id) ON DELETE SET NULL,
  exam_code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL,
  marks_correct REAL NOT NULL DEFAULT 1,
  marks_wrong REAL NOT NULL DEFAULT 0,
  start_at TEXT,
  end_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  passkey_hash TEXT,
  passkey_enc TEXT,
  max_violations INTEGER NOT NULL DEFAULT 3,
  shuffle_questions INTEGER NOT NULL DEFAULT 1,
  shuffle_options INTEGER NOT NULL DEFAULT 1,
  show_result INTEGER NOT NULL DEFAULT 1,
  instructions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS test_sections (
  id INTEGER PRIMARY KEY,
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  question_count INTEGER NOT NULL,
  syllabus TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  subject TEXT NOT NULL,
  exam_code TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  text TEXT NOT NULL,
  options TEXT NOT NULL,
  correct_index INTEGER NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_q_subject ON questions(exam_code, subject, status);

CREATE TABLE IF NOT EXISTS test_questions (
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  section_id INTEGER NOT NULL REFERENCES test_sections(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  sort INTEGER NOT NULL,
  PRIMARY KEY (test_id, question_id)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  address TEXT NOT NULL,
  email TEXT NOT NULL,
  mobile TEXT NOT NULL,
  parent_mobile TEXT NOT NULL,
  session_id TEXT,
  reg_ip TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (test_id, email)
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY,
  student_id INTEGER UNIQUE NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  submitted_at TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  question_order TEXT NOT NULL,
  option_maps TEXT NOT NULL DEFAULT '{}',
  answers TEXT NOT NULL DEFAULT '{}',
  marked TEXT NOT NULL DEFAULT '[]',
  visited TEXT NOT NULL DEFAULT '[]',
  score REAL,
  correct INTEGER,
  wrong INTEGER,
  unanswered INTEGER,
  section_scores TEXT,
  violations INTEGER NOT NULL DEFAULT 0,
  violation_log TEXT NOT NULL DEFAULT '[]',
  submit_reason TEXT,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempt_test ON attempts(test_id, status);
`);

// Columns added after the first release.
const qCols = db.prepare('PRAGMA table_info(questions)').all().map((c) => c.name);
if (!qCols.includes('diagram')) db.exec('ALTER TABLE questions ADD COLUMN diagram TEXT');
if (!qCols.includes('options_format')) db.exec("ALTER TABLE questions ADD COLUMN options_format TEXT NOT NULL DEFAULT 'text'");
db.exec('CREATE INDEX IF NOT EXISTS idx_q_difficulty ON questions(exam_code, subject, status, difficulty)');

// Paper moderation: difficulty mix (percent) and whether every student gets their own random set.
const tCols = db.prepare('PRAGMA table_info(tests)').all().map((c) => c.name);
if (!tCols.includes('mix_easy')) {
  db.exec(`ALTER TABLE tests ADD COLUMN mix_easy INTEGER NOT NULL DEFAULT 30;
           ALTER TABLE tests ADD COLUMN mix_medium INTEGER NOT NULL DEFAULT 50;
           ALTER TABLE tests ADD COLUMN mix_hard INTEGER NOT NULL DEFAULT 20;
           ALTER TABLE tests ADD COLUMN selection_mode TEXT NOT NULL DEFAULT 'random';`);
}

// Registration form per test: 'full' (name, address, email, mobiles) or 'name_only' (trial/practice sessions).
if (!db.prepare('PRAGMA table_info(tests)').all().some((c) => c.name === 'registration_mode')) {
  db.exec("ALTER TABLE tests ADD COLUMN registration_mode TEXT NOT NULL DEFAULT 'full'");
}

// Questions served to each attempt (needed when every student gets a different random set).
db.exec(`CREATE TABLE IF NOT EXISTS attempt_questions (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  PRIMARY KEY (attempt_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_aq_question ON attempt_questions(question_id);`);

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, all, get, run, tx };
