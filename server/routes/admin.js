const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { all, get, run, tx } = require('../db');
const {
  fail, encrypt, decrypt, generatePasskey, cookieOpts, sign, requireAdmin, v,
} = require('../security');
const gemini = require('../gemini');
const content = require('../content');
const {
  sectionsWithPaper, finalize, finalizeExpired, rankings, bankStatus, pickQuestions,
} = require('../exam');
const { DEFAULT_INSTRUCTIONS, bankCode } = require('../seed');

const router = express.Router();
const SESSION_HOURS = 8;

// ---------------- auth ----------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60000, limit: 10, skipSuccessfulRequests: true,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many failed logins. Try again in 15 minutes.' },
});

// Constant-time-ish: always run bcrypt so response time doesn't reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

router.post('/login', loginLimiter, async (req, res) => {
  const username = v.str(req.body.username, 'Username', { max: 64 });
  const password = v.str(req.body.password, 'Password', { max: 200 });
  const admin = get('SELECT * FROM admins WHERE username = ?', username);
  const ok = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_HASH);
  if (!admin || !ok) fail(401, 'Invalid username or password');
  const token = sign({ sub: admin.id, tv: admin.token_version, role: 'admin' }, SESSION_HOURS * 3600);
  res.cookie('kl_admin', token, cookieOpts(SESSION_HOURS * 3600 * 1000));
  res.json({ ok: true, username: admin.username });
});

router.post('/logout', (req, res) => {
  res.clearCookie('kl_admin', { path: '/' });
  res.json({ ok: true });
});

router.use(requireAdmin);

router.get('/me', (req, res) => res.json({ username: req.admin.username }));

router.post('/password', async (req, res) => {
  const current = v.str(req.body.current, 'Current password', { max: 200 });
  const next = v.str(req.body.next, 'New password', { min: 10, max: 200 });
  const admin = get('SELECT * FROM admins WHERE id = ?', req.admin.id);
  if (!(await bcrypt.compare(current, admin.password_hash))) fail(400, 'Current password is incorrect');
  // Bumping token_version signs out every other admin session.
  run('UPDATE admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', await bcrypt.hash(next, 12), admin.id);
  const token = sign({ sub: admin.id, tv: admin.token_version + 1, role: 'admin' }, SESSION_HOURS * 3600);
  res.cookie('kl_admin', token, cookieOpts(SESSION_HOURS * 3600 * 1000));
  res.json({ ok: true });
});

// ---------------- dashboard ----------------
router.get('/stats', (req, res) => {
  finalizeExpired();
  res.json({
    templates: get('SELECT COUNT(*) c FROM exam_templates').c,
    tests: get('SELECT COUNT(*) c FROM tests').c,
    live_tests: get("SELECT COUNT(*) c FROM tests WHERE status = 'live'").c,
    questions: get('SELECT COUNT(*) c FROM questions').c,
    approved: get("SELECT COUNT(*) c FROM questions WHERE status = 'approved'").c,
    pending: get("SELECT COUNT(*) c FROM questions WHERE status = 'pending'").c,
    students: get('SELECT COUNT(*) c FROM students').c,
    in_progress: get("SELECT COUNT(*) c FROM attempts WHERE status = 'in_progress'").c,
    submitted: get("SELECT COUNT(*) c FROM attempts WHERE status = 'submitted'").c,
    recent_tests: all(`SELECT t.id, t.name, t.exam_code, t.status, t.start_at,
        (SELECT COUNT(*) FROM students s WHERE s.test_id = t.id) AS students,
        (SELECT COUNT(*) FROM attempts a WHERE a.test_id = t.id AND a.status = 'submitted') AS submitted
      FROM tests t ORDER BY t.id DESC LIMIT 8`),
  });
});

// ---------------- settings ----------------
router.get('/settings', (req, res) => {
  const { key, model } = gemini.getConfig();
  const stored = get("SELECT value FROM settings WHERE key = 'gemini_key'");
  res.json({
    gemini_configured: !!key,
    gemini_key_source: stored ? 'admin' : (process.env.GEMINI_API_KEY ? 'env' : 'none'),
    gemini_key_hint: key ? `••••${key.slice(-4)}` : '',
    gemini_model: model,
  });
});

router.put('/settings', (req, res) => {
  if (req.body.gemini_key !== undefined) {
    const k = String(req.body.gemini_key).trim();
    if (k) {
      // Covers both classic "AIza…" keys and newer "AQ.…" keys (which contain dots).
      if (!/^[\w.-]{20,300}$/.test(k)) fail(400, 'That does not look like a valid Gemini API key');
      run("INSERT INTO settings (key, value) VALUES ('gemini_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", encrypt(k));
    } else {
      run("DELETE FROM settings WHERE key = 'gemini_key'");
    }
  }
  if (req.body.gemini_model) {
    const m = v.str(req.body.gemini_model, 'Model', { max: 80 });
    if (!/^[\w.-]+$/.test(m)) fail(400, 'Invalid model name');
    run("INSERT INTO settings (key, value) VALUES ('gemini_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", m);
  }
  res.json({ ok: true });
});

router.post('/gemini/test', async (req, res) => {
  const reply = await gemini.testConnection();
  res.json({ ok: true, reply, model: gemini.getConfig().model });
});

// ---------------- exam templates ----------------
function readSections(body) {
  if (!Array.isArray(body.sections) || !body.sections.length) fail(400, 'Add at least one section');
  if (body.sections.length > 12) fail(400, 'Too many sections');
  return body.sections.map((s, i) => ({
    id: s.id ? Number(s.id) : null,
    name: v.str(s.name, `Section ${i + 1} name`, { max: 80 }),
    question_count: v.int(s.question_count, `Section ${i + 1} question count`, { min: 1, max: 300 }),
    syllabus: v.str(s.syllabus, `Section ${i + 1} syllabus`, { required: false, max: 20000 }),
  }));
}

router.get('/templates', (req, res) => {
  const ts = all('SELECT * FROM exam_templates ORDER BY id');
  ts.forEach((t) => {
    t.bank_code = bankCode(t.code);
    t.sections = all('SELECT * FROM template_sections WHERE template_id = ? ORDER BY sort, id', t.id).map((sec) => {
      const bank = { easy: 0, medium: 0, hard: 0, pending: 0 };
      all('SELECT status, difficulty, COUNT(*) c FROM questions WHERE exam_code = ? AND subject = ? GROUP BY status, difficulty', t.bank_code, sec.name)
        .forEach((r) => { if (r.status === 'approved' && r.difficulty in bank) bank[r.difficulty] += r.c; if (r.status === 'pending') bank.pending += r.c; });
      return { ...sec, bank };
    });
  });
  res.json(ts);
});

function saveTemplate(id, body) {
  const code = v.str(body.code, 'Exam code', { max: 20 }).toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(code)) fail(400, 'Exam code may contain only letters, digits, - and _');
  const name = v.str(body.name, 'Exam name', { max: 150 });
  const departments = v.str(body.departments, 'Departments', { required: false, max: 300 });
  const duration = v.int(body.duration_min, 'Duration (minutes)', { min: 5, max: 600 });
  const mode = v.str(body.mode, 'Mode', { required: false, max: 40 }) || 'ONLINE';
  const sections = readSections(body);
  const dup = get('SELECT id FROM exam_templates WHERE code = ? AND id IS NOT ?', code, id);
  if (dup) fail(409, `Exam code ${code} already exists`);
  return tx(() => {
    let tid = id;
    if (id) {
      run('UPDATE exam_templates SET code = ?, name = ?, departments = ?, duration_min = ?, mode = ? WHERE id = ?', code, name, departments, duration, mode, id);
      run('DELETE FROM template_sections WHERE template_id = ?', id);
    } else {
      tid = run('INSERT INTO exam_templates (code, name, departments, duration_min, mode) VALUES (?, ?, ?, ?, ?)', code, name, departments, duration, mode).lastInsertRowid;
    }
    sections.forEach((s, i) => run('INSERT INTO template_sections (template_id, name, question_count, syllabus, sort) VALUES (?, ?, ?, ?, ?)', tid, s.name, s.question_count, s.syllabus, i));
    return tid;
  });
}

router.post('/templates', (req, res) => res.json({ id: saveTemplate(null, req.body) }));
router.put('/templates/:id', (req, res) => {
  const id = v.int(req.params.id, 'id', { min: 1 });
  if (!get('SELECT id FROM exam_templates WHERE id = ?', id)) fail(404, 'Template not found');
  saveTemplate(id, req.body);
  res.json({ ok: true });
});
router.delete('/templates/:id', (req, res) => {
  run('DELETE FROM exam_templates WHERE id = ?', v.int(req.params.id, 'id', { min: 1 }));
  res.json({ ok: true });
});

// ---------------- tests ----------------
const loadTest = (id) => get('SELECT * FROM tests WHERE id = ?', v.int(id, 'Test id', { min: 1 })) || fail(404, 'Test not found');
const hasAttempts = (testId) => !!get('SELECT 1 FROM attempts WHERE test_id = ? LIMIT 1', testId);

function publicTest(t) {
  const { passkey_hash, passkey_enc, ...rest } = t;
  return { ...rest, has_passkey: !!passkey_hash };
}

router.get('/tests', (req, res) => {
  const rows = all(`SELECT t.*,
      (SELECT COUNT(*) FROM students s WHERE s.test_id = t.id) AS students,
      (SELECT COUNT(*) FROM attempts a WHERE a.test_id = t.id AND a.status = 'submitted') AS submitted,
      (SELECT COUNT(*) FROM test_questions q WHERE q.test_id = t.id) AS paper_count,
      (SELECT COALESCE(SUM(question_count), 0) FROM test_sections s WHERE s.test_id = t.id) AS total_questions
    FROM tests t ORDER BY t.id DESC`);
  res.json(rows.map(publicTest));
});

function checkWindow(startAt, endAt, durationMin) {
  if (startAt && endAt && endAt <= startAt) fail(400, 'Exam end must be after the exam start');
  if (startAt && endAt && Date.parse(endAt) - Date.parse(startAt) < durationMin * 60000) {
    fail(400, `The exam window must be at least the exam duration (${durationMin} minutes)`);
  }
}

router.post('/tests', (req, res) => {
  const tpl = get('SELECT * FROM exam_templates WHERE id = ?', v.int(req.body.template_id, 'Exam template', { min: 1 })) || fail(404, 'Template not found');
  const name = v.str(req.body.name, 'Test name', { max: 150 });
  const startAt = v.isoDate(req.body.start_at, 'Exam start');
  const endAt = v.isoDate(req.body.end_at, 'Exam end');
  checkWindow(startAt, endAt, tpl.duration_min);
  const id = tx(() => {
    const tid = run(`INSERT INTO tests (template_id, exam_code, name, description, duration_min, instructions, start_at, end_at, max_violations)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2)`,
    tpl.id, bankCode(tpl.code), name, `${tpl.name} — ${tpl.departments}`, tpl.duration_min, DEFAULT_INSTRUCTIONS, startAt, endAt).lastInsertRowid;
    all('SELECT * FROM template_sections WHERE template_id = ? ORDER BY sort, id', tpl.id).forEach((s, i) => {
      run('INSERT INTO test_sections (test_id, name, question_count, syllabus, sort) VALUES (?, ?, ?, ?, ?)', tid, s.name, s.question_count, s.syllabus, i);
    });
    return tid;
  });
  res.json({ id });
});

router.get('/tests/:id', (req, res) => {
  const t = loadTest(req.params.id);
  const sections = sectionsWithPaper(t.id).map((s) => ({
    ...s,
    bank_approved: get("SELECT COUNT(*) c FROM questions WHERE exam_code = ? AND subject = ? AND status = 'approved'", t.exam_code, s.name).c,
    bank_pending: get("SELECT COUNT(*) c FROM questions WHERE exam_code = ? AND subject = ? AND status = 'pending'", t.exam_code, s.name).c,
    bank: bankStatus(t, s),
  }));
  res.json({ ...publicTest(t), sections, locked: hasAttempts(t.id) });
});

router.put('/tests/:id', (req, res) => {
  const t = loadTest(req.params.id);
  const b = req.body;
  const locked = hasAttempts(t.id);
  const fields = {
    name: v.str(b.name, 'Test name', { max: 150 }),
    description: v.str(b.description, 'Description', { required: false, max: 500 }),
    duration_min: v.int(b.duration_min, 'Duration', { min: 5, max: 600 }),
    marks_correct: v.num(b.marks_correct, 'Marks per correct answer', { min: 0, max: 100 }),
    marks_wrong: v.num(b.marks_wrong, 'Negative marks', { min: 0, max: 100 }),
    start_at: v.isoDate(b.start_at, 'Start time'),
    end_at: v.isoDate(b.end_at, 'End time'),
    max_violations: v.int(b.max_violations, 'Violations before the exam closes', { min: 0, max: 50 }),
    mix_easy: v.int(b.mix_easy, 'Easy %', { min: 0, max: 100 }),
    mix_medium: v.int(b.mix_medium, 'Medium %', { min: 0, max: 100 }),
    mix_hard: v.int(b.mix_hard, 'Hard %', { min: 0, max: 100 }),
    selection_mode: b.selection_mode === 'fixed' ? 'fixed' : 'random',
    registration_mode: b.registration_mode === 'name_only' ? 'name_only' : 'full',
    shuffle_questions: b.shuffle_questions ? 1 : 0,
    shuffle_options: b.shuffle_options ? 1 : 0,
    show_result: b.show_result ? 1 : 0,
    instructions: v.str(b.instructions, 'Instructions', { required: false, max: 8000 }),
  };
  checkWindow(fields.start_at, fields.end_at, fields.duration_min);
  if (fields.mix_easy + fields.mix_medium + fields.mix_hard !== 100) fail(400, 'Easy + Medium + Hard must add up to 100%');
  if (locked && ['mix_easy', 'mix_medium', 'mix_hard', 'selection_mode'].some((k) => fields[k] !== t[k])) {
    fail(409, 'Paper moderation cannot change after candidates have started the exam');
  }
  if (locked && (fields.marks_correct !== t.marks_correct || fields.marks_wrong !== t.marks_wrong)) {
    fail(409, 'Marking scheme cannot change after candidates have started the exam');
  }
  const sections = b.sections ? readSections(b) : null;
  tx(() => {
    run(`UPDATE tests SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(fields), t.id);
    if (!sections) return;
    const existing = all('SELECT * FROM test_sections WHERE test_id = ?', t.id);
    if (locked) {
      // Only syllabus text may change once the exam is under way.
      sections.forEach((s) => s.id && run('UPDATE test_sections SET syllabus = ? WHERE id = ? AND test_id = ?', s.syllabus, s.id, t.id));
      return;
    }
    const keep = new Set();
    sections.forEach((s, i) => {
      const cur = existing.find((e) => e.id === s.id);
      if (cur) {
        keep.add(cur.id);
        if (cur.name !== s.name || s.question_count < cur.question_count) run('DELETE FROM test_questions WHERE section_id = ?', cur.id);
        run('UPDATE test_sections SET name = ?, question_count = ?, syllabus = ?, sort = ? WHERE id = ?', s.name, s.question_count, s.syllabus, i, cur.id);
      } else {
        run('INSERT INTO test_sections (test_id, name, question_count, syllabus, sort) VALUES (?, ?, ?, ?, ?)', t.id, s.name, s.question_count, s.syllabus, i);
      }
    });
    existing.filter((e) => !keep.has(e.id)).forEach((e) => run('DELETE FROM test_sections WHERE id = ?', e.id));
  });
  res.json({ ok: true });
});

router.delete('/tests/:id', (req, res) => {
  const t = loadTest(req.params.id);
  if (t.status === 'live') fail(409, 'Close the test before deleting it');
  run('DELETE FROM tests WHERE id = ?', t.id);
  res.json({ ok: true });
});

router.post('/tests/:id/status', (req, res) => {
  const t = loadTest(req.params.id);
  const status = req.body.status;
  if (!['draft', 'live', 'closed'].includes(status)) fail(400, 'Invalid status');
  if (status === 'live') {
    if (!t.passkey_hash) fail(409, 'Generate a pass key before going live');
    const secs = sectionsWithPaper(t.id);
    if (t.selection_mode === 'random') {
      const short = secs.map((s) => ({ s, b: bankStatus(t, s) })).filter((x) => !x.b.enough);
      if (short.length) fail(409, `Not enough approved questions in the bank: ${short.map((x) => `${x.s.name} ${x.b.total}/${x.s.question_count}`).join(', ')}`);
    } else {
      const short = secs.filter((s) => s.paper_count < s.question_count);
      if (short.length) fail(409, `Question paper incomplete: ${short.map((s) => `${s.name} ${s.paper_count}/${s.question_count}`).join(', ')}`);
    }
  }
  run('UPDATE tests SET status = ? WHERE id = ?', status, t.id);
  if (status === 'closed') {
    all("SELECT id FROM attempts WHERE test_id = ? AND status = 'in_progress'", t.id).forEach((a) => finalize(a.id, 'test_closed'));
  }
  res.json({ ok: true });
});

router.post('/tests/:id/passkey', async (req, res) => {
  const t = loadTest(req.params.id);
  let key = req.body.passkey ? String(req.body.passkey).trim() : generatePasskey(8);
  if (!/^[A-Za-z0-9@#$%&*!_-]{6,32}$/.test(key)) fail(400, 'Pass key must be 6-32 characters (letters, digits, @#$%&*!_-)');
  run('UPDATE tests SET passkey_hash = ?, passkey_enc = ? WHERE id = ?', await bcrypt.hash(key, 10), encrypt(key), t.id);
  res.json({ passkey: key });
});

router.get('/tests/:id/passkey', (req, res) => {
  const t = loadTest(req.params.id);
  res.json({ passkey: t.passkey_enc ? decrypt(t.passkey_enc) : null });
});

router.post('/tests/:id/sections/:sid/syllabus', async (req, res) => {
  const t = loadTest(req.params.id);
  const s = get('SELECT * FROM test_sections WHERE id = ? AND test_id = ?', v.int(req.params.sid, 'Section', { min: 1 }), t.id) || fail(404, 'Section not found');
  const tpl = get('SELECT * FROM exam_templates WHERE id = ?', t.template_id);
  const syllabus = await gemini.suggestSyllabus({
    examName: tpl ? `${tpl.code} (${tpl.name})` : t.name, departments: tpl?.departments, subject: s.name, questionCount: s.question_count,
  });
  res.json({ syllabus });
});

// ---------------- question bank ----------------
function readQuestion(b) {
  const options = Array.isArray(b.options) ? b.options.map((o, i) => v.str(o, `Option ${i + 1}`, { max: 1000 })) : [];
  if (options.length !== 4) fail(400, 'Exactly 4 options are required');
  const optionsFormat = b.options_format === 'smiles' ? 'smiles' : 'text';
  const q = {
    subject: v.str(b.subject, 'Subject', { max: 80 }),
    exam_code: v.str(b.exam_code, 'Exam code', { required: false, max: 20 }).toUpperCase(),
    topic: v.str(b.topic, 'Topic', { required: false, max: 120 }),
    difficulty: ['easy', 'medium', 'hard'].includes(b.difficulty) ? b.difficulty : 'medium',
    text: v.str(b.text, 'Question', { min: 5, max: 4000 }),
    options: JSON.stringify(options),
    correct_index: v.int(b.correct_index, 'Correct option', { min: 0, max: 3 }),
    explanation: v.str(b.explanation, 'Explanation', { required: false, max: 2000 }),
    status: ['pending', 'approved', 'rejected'].includes(b.status) ? b.status : 'approved',
    options_format: optionsFormat,
    diagram: null,
  };
  const mathErr = content.checkMath(q.text) || content.checkMath(q.explanation)
    || (optionsFormat === 'text' ? options.map(content.checkMath).find(Boolean) : null);
  if (mathErr) fail(400, mathErr);
  if (optionsFormat === 'smiles' && !options.every(content.isSmiles)) fail(400, 'Every option must be a valid SMILES string');
  try {
    const d = content.cleanDiagram(b.diagram || {});
    q.diagram = d ? JSON.stringify(d) : null;
  } catch (e) {
    fail(400, e.message);
  }
  return q;
}

const parseQ = (q) => ({ ...q, options: JSON.parse(q.options), diagram: q.diagram ? JSON.parse(q.diagram) : null });

const Q_FIELDS = ['subject', 'exam_code', 'topic', 'difficulty', 'text', 'options', 'correct_index', 'explanation', 'status', 'diagram', 'options_format'];
const insertQuestion = (q, source) => run(`INSERT INTO questions (${Q_FIELDS.join(', ')}, source) VALUES (${Q_FIELDS.map(() => '?').join(', ')}, ?)`,
  ...Q_FIELDS.map((f) => q[f]), source).lastInsertRowid;

router.get('/questions', (req, res) => {
  const where = [];
  const p = [];
  if (req.query.exam_code) { where.push('exam_code = ?'); p.push(String(req.query.exam_code)); }
  if (req.query.subject) { where.push('subject = ?'); p.push(String(req.query.subject)); }
  if (req.query.status) { where.push('status = ?'); p.push(String(req.query.status)); }
  if (req.query.difficulty) { where.push('difficulty = ?'); p.push(String(req.query.difficulty)); }
  if (req.query.q) { where.push('(text LIKE ? OR topic LIKE ?)'); p.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const total = get(`SELECT COUNT(*) c FROM questions ${w}`, ...p).c;
  const rows = all(`SELECT q.*, (SELECT COUNT(*) FROM test_questions tq WHERE tq.question_id = q.id) AS used_in
                    FROM questions q ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...p, limit, (page - 1) * limit);
  res.json({ total, page, limit, items: rows.map(parseQ) });
});

router.get('/questions/subjects', (req, res) => {
  res.json(all(`SELECT exam_code, subject,
      SUM(status = 'approved') AS approved, SUM(status = 'pending') AS pending, SUM(status = 'rejected') AS rejected, COUNT(*) AS total
    FROM questions GROUP BY exam_code, subject ORDER BY exam_code, subject`));
});

router.post('/questions', (req, res) => {
  const q = readQuestion(req.body);
  res.json({ id: insertQuestion(q, 'manual') });
});

router.put('/questions/:id', (req, res) => {
  const id = v.int(req.params.id, 'id', { min: 1 });
  const cur = get('SELECT * FROM questions WHERE id = ?', id) || fail(404, 'Question not found');
  const q = readQuestion({ ...parseQ(cur), ...req.body });
  const inLiveAttempt = get('SELECT 1 FROM attempt_questions WHERE question_id = ? LIMIT 1', id)
    || get('SELECT 1 FROM test_questions tq JOIN attempts a ON a.test_id = tq.test_id WHERE tq.question_id = ? LIMIT 1', id);
  if (inLiveAttempt && q.correct_index !== cur.correct_index) fail(409, 'This question has already been answered by candidates; its correct option cannot change.');
  run(`UPDATE questions SET ${Q_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, ...Q_FIELDS.map((f) => q[f]), id);
  res.json({ ok: true });
});

function deleteQuestions(ids) {
  const used = ids.filter((id) => get('SELECT 1 FROM test_questions WHERE question_id = ? UNION ALL SELECT 1 FROM attempt_questions WHERE question_id = ?', id, id));
  tx(() => ids.filter((id) => !used.includes(id)).forEach((id) => run('DELETE FROM questions WHERE id = ?', id)));
  return used.length;
}

router.delete('/questions/:id', (req, res) => {
  if (deleteQuestions([v.int(req.params.id, 'id', { min: 1 })])) fail(409, 'Question is part of a test paper. Remove it from the paper first.');
  res.json({ ok: true });
});

router.post('/questions/bulk', (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => v.int(x, 'id', { min: 1 })).slice(0, 2000);
  const action = req.body.action;
  if (!ids.length) fail(400, 'Select at least one question');
  if (action === 'delete') {
    const skipped = deleteQuestions(ids);
    return res.json({ ok: true, skipped });
  }
  const status = { approve: 'approved', reject: 'rejected', pending: 'pending' }[action] || fail(400, 'Invalid action');
  tx(() => ids.forEach((id) => run('UPDATE questions SET status = ? WHERE id = ?', status, id)));
  res.json({ ok: true });
});

router.post('/questions/classify', async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => v.int(x, 'id', { min: 1 })).slice(0, 300);
  if (!ids.length) fail(400, 'Select at least one question');
  const qs = all(`SELECT id, subject, exam_code, text, options FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).map(parseQ);
  const labels = await gemini.classifyDifficulty(qs, qs[0]?.exam_code || 'KL entrance exam');
  tx(() => labels.forEach((l) => run('UPDATE questions SET difficulty = ? WHERE id = ?', l.difficulty, l.id)));
  const count = (d) => labels.filter((l) => l.difficulty === d).length;
  res.json({ updated: labels.length, easy: count('easy'), medium: count('medium'), hard: count('hard') });
});

router.post('/questions/import', (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : fail(400, 'items must be an array');
  if (items.length > 2000) fail(400, 'Import at most 2000 questions at a time');
  const parsed = items.map((it, i) => {
    try { return readQuestion({ ...it, text: it.text || it.question }); } catch (e) { fail(400, `Item ${i + 1}: ${e.message}`); }
  });
  tx(() => parsed.forEach((q) => insertQuestion(q, 'import')));
  res.json({ imported: parsed.length });
});

// Gemini generation for one section of a test, using that section's syllabus.
const genLimiter = rateLimit({ windowMs: 60000, limit: 10, message: { error: 'Too many generation requests, wait a minute.' } });
// Resolves where to generate for: a section of a test, or a section of an exam pattern
// (so a bank can be built before any test exists). Both map to the same shared bank code.
function generationTarget(b) {
  const sid = v.int(b.section_id, 'Section', { min: 1 });
  if (b.template_id) {
    const tpl = get('SELECT * FROM exam_templates WHERE id = ?', v.int(b.template_id, 'Exam pattern', { min: 1 })) || fail(404, 'Exam pattern not found');
    const sec = get('SELECT * FROM template_sections WHERE id = ? AND template_id = ?', sid, tpl.id) || fail(404, 'Section not found');
    return { tpl, sec, examCode: bankCode(tpl.code) };
  }
  const t = loadTest(b.test_id);
  const sec = get('SELECT * FROM test_sections WHERE id = ? AND test_id = ?', sid, t.id) || fail(404, 'Section not found');
  return { tpl: get('SELECT * FROM exam_templates WHERE id = ?', t.template_id), sec, examCode: t.exam_code, testName: t.name };
}

router.post('/questions/generate', genLimiter, async (req, res) => {
  const { tpl, sec: s, examCode, testName } = generationTarget(req.body);
  const count = v.int(req.body.count, 'Number of questions', { min: 1, max: 100 });
  const difficulty = ['easy', 'medium', 'hard', 'mixed'].includes(req.body.difficulty) ? req.body.difficulty : 'medium';
  const focus = v.str(req.body.focus, 'Focus topics', { required: false, max: 500 });
  const autoApprove = !!req.body.auto_approve;
  const existing = all('SELECT text FROM questions WHERE exam_code = ? AND subject = ? ORDER BY id DESC LIMIT 300', examCode, s.name).map((r) => r.text);

  const { questions: qs, rejected } = await gemini.generateQuestions({
    examName: tpl ? `${tpl.code} — ${tpl.name} (${tpl.departments})` : testName,
    subject: s.name,
    syllabus: s.syllabus,
    count,
    difficulty: difficulty === 'mixed' ? 'a mix of easy (30%), medium (50%) and hard (20%)' : difficulty,
    focus,
    existing,
  });
  const ids = tx(() => qs.map((q) => insertQuestion({
    ...q,
    subject: s.name,
    exam_code: examCode,
    difficulty: difficulty === 'mixed' ? q.difficulty : difficulty,
    options: JSON.stringify(q.options),
    diagram: q.diagram ? JSON.stringify(q.diagram) : null,
    status: autoApprove ? 'approved' : 'pending',
  }, 'gemini')));
  res.json({ requested: count, generated: ids.length, rejected: rejected.length, ids });
});

// ---------------- question paper ----------------
router.get('/tests/:id/paper', (req, res) => {
  const t = loadTest(req.params.id);
  const sections = sectionsWithPaper(t.id).map((s) => ({
    ...s,
    questions: all(`SELECT q.* FROM test_questions tq JOIN questions q ON q.id = tq.question_id
                    WHERE tq.section_id = ? ORDER BY tq.sort`, s.id).map(parseQ),
  }));
  res.json({ test: publicTest(t), sections });
});

// Pull approved questions from the bank into the paper. Questions not yet used in any other
// paper are preferred so repeated sittings get fresh questions.
router.post('/tests/:id/paper/build', (req, res) => {
  const t = loadTest(req.params.id);
  if (hasAttempts(t.id)) fail(409, 'Candidates have already started this test; the paper is locked.');
  const onlySection = req.body.section_id ? Number(req.body.section_id) : null;
  const report = tx(() => sectionsWithPaper(t.id).filter((s) => !onlySection || s.id === onlySection).map((s) => {
    run('DELETE FROM test_questions WHERE section_id = ?', s.id);
    const { qids } = pickQuestions(t, s, { preferUnused: true });
    qids.forEach((qid, i) => run('INSERT INTO test_questions (test_id, section_id, question_id, sort) VALUES (?, ?, ?, ?)', t.id, s.id, qid, i));
    return { section: s.name, required: s.question_count, pulled: qids.length };
  }));
  res.json({ report });
});

router.delete('/tests/:id/paper/:qid', (req, res) => {
  const t = loadTest(req.params.id);
  if (hasAttempts(t.id)) fail(409, 'The paper is locked.');
  run('DELETE FROM test_questions WHERE test_id = ? AND question_id = ?', t.id, v.int(req.params.qid, 'id', { min: 1 }));
  res.json({ ok: true });
});

// ---------------- students & results ----------------
router.get('/tests/:id/students', (req, res) => {
  const t = loadTest(req.params.id);
  finalizeExpired(t.id);
  res.json(all(`SELECT s.id, s.full_name, s.address, s.email, s.mobile, s.parent_mobile, s.created_at, s.reg_ip,
      a.id AS attempt_id, a.status AS attempt_status, a.started_at, a.submitted_at, a.score, a.violations
    FROM students s LEFT JOIN attempts a ON a.student_id = s.id WHERE s.test_id = ? ORDER BY s.id DESC`, t.id));
});

router.delete('/students/:id', (req, res) => {
  run('DELETE FROM students WHERE id = ?', v.int(req.params.id, 'id', { min: 1 }));
  res.json({ ok: true });
});

// Lets a candidate retake (e.g. after a genuine technical failure). Previous answers are discarded.
router.post('/attempts/:id/reset', (req, res) => {
  const a = get('SELECT * FROM attempts WHERE id = ?', v.int(req.params.id, 'id', { min: 1 })) || fail(404, 'Attempt not found');
  run('DELETE FROM attempts WHERE id = ?', a.id);
  run('UPDATE students SET session_id = NULL WHERE id = ?', a.student_id);
  res.json({ ok: true });
});

router.post('/attempts/:id/submit', (req, res) => {
  finalize(v.int(req.params.id, 'id', { min: 1 }), 'admin_forced');
  res.json({ ok: true });
});

router.get('/tests/:id/results', (req, res) => {
  const t = loadTest(req.params.id);
  finalizeExpired(t.id);
  const rows = rankings(t.id).map((r) => ({
    attempt_id: r.id, rank: r.rank, full_name: r.full_name, email: r.email, mobile: r.mobile, parent_mobile: r.parent_mobile,
    score: r.score, correct: r.correct, wrong: r.wrong, unanswered: r.unanswered, violations: r.violations,
    time_taken_sec: r.time_taken_sec, submitted_at: r.submitted_at, submit_reason: r.submit_reason,
    sections: JSON.parse(r.section_scores || '[]'),
  }));
  const max = sectionsWithPaper(t.id).reduce((m, s) => m + s.question_count, 0) * t.marks_correct;
  res.json({ test: publicTest(t), max_score: max, results: rows });
});

router.get('/attempts/:id', (req, res) => {
  const a = get('SELECT * FROM attempts WHERE id = ?', v.int(req.params.id, 'id', { min: 1 })) || fail(404, 'Attempt not found');
  const s = get('SELECT * FROM students WHERE id = ?', a.student_id);
  const order = JSON.parse(a.question_order);
  const answers = JSON.parse(a.answers);
  const qids = order.flatMap((x) => x.qids);
  const qmap = new Map(qids.length ? all(`SELECT * FROM questions WHERE id IN (${qids.map(() => '?').join(',')})`, ...qids).map((q) => [q.id, parseQ(q)]) : []);
  res.json({
    student: s,
    attempt: { ...a, question_order: undefined, answers: undefined, option_maps: undefined, violation_log: JSON.parse(a.violation_log), section_scores: JSON.parse(a.section_scores || '[]') },
    sections: order.map((sec) => ({
      name: sec.name,
      questions: sec.qids.map((id) => {
        const q = qmap.get(id) || {};
        return {
          id, text: q.text, options: q.options, correct_index: q.correct_index, answer: answers[id] ?? null,
          diagram: q.diagram, options_format: q.options_format,
        };
      }),
    })),
  });
});

// Name-only (trial) registrations store a placeholder email; exports show it blank.
const shownEmail = (e) => (String(e).startsWith('name-only:') ? '' : e);

// CSV exports (Excel-friendly, with formula-injection protection).
const csvCell = (val) => {
  let s = val === null || val === undefined ? '' : String(val);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const sendCsv = (res, name, header, rows) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`);
  res.send(`﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}`);
};

router.get('/tests/:id/results.csv', (req, res) => {
  const t = loadTest(req.params.id);
  finalizeExpired(t.id);
  const secs = sectionsWithPaper(t.id);
  const rows = rankings(t.id).map((r) => {
    const ss = JSON.parse(r.section_scores || '[]');
    return [r.rank, r.full_name, shownEmail(r.email), r.mobile, r.parent_mobile, r.address, r.score, r.correct, r.wrong, r.unanswered,
      ...secs.map((s) => ss.find((x) => x.section_id === s.id)?.score ?? ''),
      Math.round(r.time_taken_sec / 60), r.violations, r.submit_reason, r.submitted_at];
  });
  sendCsv(res, `${t.exam_code}_${t.name}_results.csv`,
    ['Rank', 'Name', 'Email', 'Mobile', 'Parent Mobile', 'Address', 'Score', 'Correct', 'Wrong', 'Unanswered', ...secs.map((s) => s.name), 'Time (min)', 'Violations', 'Submitted By', 'Submitted At'],
    rows);
});

router.get('/tests/:id/students.csv', (req, res) => {
  const t = loadTest(req.params.id);
  const rows = all(`SELECT s.*, a.status AS attempt_status FROM students s LEFT JOIN attempts a ON a.student_id = s.id WHERE s.test_id = ? ORDER BY s.id`, t.id)
    .map((s) => [s.id, s.full_name, shownEmail(s.email), s.mobile, s.parent_mobile, s.address, s.attempt_status || 'not started', s.created_at]);
  sendCsv(res, `${t.exam_code}_${t.name}_students.csv`, ['ID', 'Name', 'Email', 'Mobile', 'Parent Mobile', 'Address', 'Status', 'Registered At'], rows);
});

module.exports = router;
