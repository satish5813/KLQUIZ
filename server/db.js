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

// Registration form per test: 'full' (name, address, email, mobiles), 'contact' (name, email, mobile),
// 'application' (name and application number) or
// 'name_only' (trial/practice sessions).
if (!db.prepare('PRAGMA table_info(tests)').all().some((c) => c.name === 'registration_mode')) {
  db.exec("ALTER TABLE tests ADD COLUMN registration_mode TEXT NOT NULL DEFAULT 'full'");
}

// Exam mode per test: 'offline' (exam hall with invigilators) or 'ai' (online from home with AI video proctoring).
if (!db.prepare('PRAGMA table_info(tests)').all().some((c) => c.name === 'proctor_mode')) {
  db.exec("ALTER TABLE tests ADD COLUMN proctor_mode TEXT NOT NULL DEFAULT 'offline'");
}
// Lab session: the exam is written in a computer lab, so other students, invigilators, monitors and room noise in the
// background are normal and proctoring looks at the candidate only.
if (!db.prepare('PRAGMA table_info(tests)').all().some((c) => c.name === 'proctor_lab')) {
  db.exec('ALTER TABLE tests ADD COLUMN proctor_lab INTEGER NOT NULL DEFAULT 0');
}
// AI proctoring totals per attempt (Gemini calls, tokens and their cost) and the number of flagged incidents.
if (!db.prepare('PRAGMA table_info(attempts)').all().some((c) => c.name === 'ai_calls')) {
  db.exec(`ALTER TABLE attempts ADD COLUMN ai_calls INTEGER NOT NULL DEFAULT 0;
           ALTER TABLE attempts ADD COLUMN ai_tokens_in INTEGER NOT NULL DEFAULT 0;
           ALTER TABLE attempts ADD COLUMN ai_tokens_out INTEGER NOT NULL DEFAULT 0;
           ALTER TABLE attempts ADD COLUMN ai_cost_usd REAL NOT NULL DEFAULT 0;
           ALTER TABLE attempts ADD COLUMN proctor_flags INTEGER NOT NULL DEFAULT 0;
           ALTER TABLE attempts ADD COLUMN proctor_high INTEGER NOT NULL DEFAULT 0;`);
}
// Proctoring timeline: what the browser detected, what Gemini saw, with the evidence file (snapshot/audio) if any.
// severity: 1 = low, 2 = medium, 3 = high.
db.exec(`CREATE TABLE IF NOT EXISTS proctor_events (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 1,
  detail TEXT NOT NULL DEFAULT '',
  file TEXT
);
CREATE INDEX IF NOT EXISTS idx_pe_attempt ON proctor_events(attempt_id, id);`);

// AI usage ledger: one row per Gemini proctoring call. No foreign keys on purpose: the record of what was spent
// stays even if a student or attempt is deleted later.
db.exec(`CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  test_id INTEGER NOT NULL,
  attempt_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  student_name TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  reason TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_test ON ai_usage(test_id, attempt_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_at ON ai_usage(at);`);

// Questions served to each attempt (needed when every student gets a different random set).
db.exec(`CREATE TABLE IF NOT EXISTS attempt_questions (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  PRIMARY KEY (attempt_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_aq_question ON attempt_questions(question_id);`);

// Edmission CRM integration. A test with registration_mode 'crm' admits only candidates the CRM pushed through the
// partner API (paid applicants), until the registration cut-off. public_code is the exam code the CRM uses;
// crm_taxonomies maps CRM course names to this test (one per line); results_published_at marks when marks were
// released to the CRM; face_match compares a live webcam photo with the CRM photo before the exam starts.
const tCols2 = db.prepare('PRAGMA table_info(tests)').all().map((c) => c.name);
for (const [col, def] of [
  ['public_code', 'TEXT'], ['crm_taxonomies', "TEXT NOT NULL DEFAULT ''"], ['reg_close_at', 'TEXT'],
  ['results_published_at', 'TEXT'], ['face_match', 'INTEGER NOT NULL DEFAULT 1'],
]) if (!tCols2.includes(col)) db.exec(`ALTER TABLE tests ADD COLUMN ${col} ${def}`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tests_public_code ON tests(public_code) WHERE public_code IS NOT NULL');

const sCols = db.prepare('PRAGMA table_info(students)').all().map((c) => c.name);
for (const [col, def] of [
  ['crm_id', 'TEXT'], ['application_no', 'TEXT'], ['first_name', 'TEXT'], ['last_name', 'TEXT'], ['taxonomy', 'TEXT'],
  ['payment_at', 'TEXT'], ['app_submitted_at', 'TEXT'], ['photo_file', 'TEXT'], ['link_token', 'TEXT'],
  ['revoked', 'INTEGER NOT NULL DEFAULT 0'], ['face_status', "TEXT NOT NULL DEFAULT 'pending'"], ['face_tries', 'INTEGER NOT NULL DEFAULT 0'],
  ['face_checked_at', 'TEXT'], ['face_file', 'TEXT'], ['otp_hash', 'TEXT'], ['otp_expires', 'TEXT'], ['otp_tries', 'INTEGER NOT NULL DEFAULT 0'],
  ['otp_sent_at', 'TEXT'], ['otp_lock_until', 'TEXT'], ['crm_updated_at', 'TEXT'],
]) if (!sCols.includes(col)) db.exec(`ALTER TABLE students ADD COLUMN ${col} ${def}`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_students_crm ON students(crm_id) WHERE crm_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_link ON students(link_token) WHERE link_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_students_mobile ON students(test_id, mobile);`);

// Webhook outbox: events waiting to be delivered to the CRM (retried with back-off for 24 hours).
db.exec(`CREATE TABLE IF NOT EXISTS crm_outbox (
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL,
  crm_id TEXT NOT NULL,
  test_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  next_at TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  failed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON crm_outbox(sent_at, failed, next_at);
CREATE TABLE IF NOT EXISTS crm_idempotency (
  key TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crm_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  ip TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_crm_log_at ON crm_log(at);`);

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
