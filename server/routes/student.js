const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { all, get, run, tx } = require('../db');
const {
  fail, cookieOpts, sign, requireRegistered, requireStudent, v,
} = require('../security');
const { testWindowState, sectionsWithPaper, createAttempt, finalize, rankings } = require('../exam');

const router = express.Router();

// Many candidates in one exam hall can share a single public IP, so limits are generous;
// failed pass-key guesses are what we really throttle.
const registerLimiter = rateLimit({ windowMs: 10 * 60000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes.' } });
const passkeyLimiter = rateLimit({ windowMs: 10 * 60000, limit: 40, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many wrong pass keys. Please wait 10 minutes or contact the invigilator.' } });

const STATE_MSG = {
  not_live: 'This exam is not open right now.',
  not_started: 'This exam has not started yet.',
  ended: 'The exam window has closed.',
};

// ---------- public ----------
router.get('/tests', (req, res) => {
  const tests = all("SELECT * FROM tests WHERE status = 'live' ORDER BY start_at, id")
    .filter((t) => testWindowState(t) !== 'ended')
    .map((t) => ({
      id: t.id, name: t.name, exam_code: t.exam_code, description: t.description, duration_min: t.duration_min,
      start_at: t.start_at, end_at: t.end_at, state: testWindowState(t),
      sections: sectionsWithPaper(t.id).map((s) => ({ name: s.name, question_count: s.question_count })),
    }));
  res.json(tests);
});

// ---------- registration ----------
router.post('/register', registerLimiter, (req, res) => {
  const b = req.body;
  const test = get('SELECT * FROM tests WHERE id = ?', v.int(b.test_id, 'Exam', { min: 1 })) || fail(404, 'Exam not found');
  const state = testWindowState(test);
  if (state !== 'open') fail(403, STATE_MSG[state]);

  const d = {
    full_name: v.str(b.full_name, 'Full name', { min: 3, max: 120 }).replace(/\s+/g, ' '),
    address: v.str(b.address, 'Address', { min: 5, max: 500 }),
    email: v.email(b.email),
    mobile: v.mobile(b.mobile, 'Mobile number'),
    parent_mobile: v.mobile(b.parent_mobile, 'Parent mobile number'),
  };
  if (!/^[\p{L} .'-]+$/u.test(d.full_name)) fail(400, 'Full name may contain only letters, spaces, dots and hyphens');
  if (d.mobile === d.parent_mobile) fail(400, 'Parent mobile number must be different from your mobile number');

  let student = get('SELECT * FROM students WHERE test_id = ? AND email = ?', test.id, d.email);
  const returning = !!student;
  if (student) {
    // Returning candidate (e.g. browser crashed): must match the mobile number registered before.
    if (student.mobile !== d.mobile) fail(409, 'This email is already registered for this exam with a different mobile number.');
    const a = get('SELECT status FROM attempts WHERE student_id = ?', student.id);
    if (a && a.status === 'submitted') fail(409, 'You have already submitted this exam.');
  } else {
    const r = run(`INSERT INTO students (test_id, full_name, address, email, mobile, parent_mobile, reg_ip) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      test.id, d.full_name, d.address, d.email, d.mobile, d.parent_mobile, req.ip);
    student = get('SELECT * FROM students WHERE id = ?', r.lastInsertRowid);
  }
  res.cookie('kl_reg', sign({ sid: student.id, tid: test.id, role: 'reg' }, 3600), cookieOpts(3600 * 1000));
  res.json({ ok: true, name: student.full_name, test: test.name, returning });
});

router.post('/unlock', passkeyLimiter, requireRegistered, async (req, res) => {
  const passkey = v.str(req.body.passkey, 'Pass key', { max: 64 });
  const student = get('SELECT * FROM students WHERE id = ? AND test_id = ?', req.reg.sid, req.reg.tid) || fail(401, 'Registration not found');
  const test = get('SELECT * FROM tests WHERE id = ?', student.test_id);
  const state = testWindowState(test);
  if (state !== 'open') fail(403, STATE_MSG[state]);
  if (!test.passkey_hash || !(await bcrypt.compare(passkey, test.passkey_hash))) fail(401, 'Incorrect pass key');

  // New session id invalidates any other browser that was using this candidate's login.
  const sess = crypto.randomBytes(16).toString('hex');
  run('UPDATE students SET session_id = ? WHERE id = ?', sess, student.id);
  const ttl = (test.duration_min + 60) * 60;
  res.cookie('kl_stu', sign({ sid: student.id, sess, role: 'student' }, ttl), cookieOpts(ttl * 1000));
  res.clearCookie('kl_reg', { path: '/' });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie('kl_stu', { path: '/' });
  res.clearCookie('kl_reg', { path: '/' });
  res.json({ ok: true });
});

// ---------- exam ----------
router.use(requireStudent);

const loadAttempt = (sid) => get('SELECT * FROM attempts WHERE student_id = ?', sid);

function autoFinalizeIfExpired(a) {
  if (a && a.status === 'in_progress' && Date.now() > Date.parse(a.deadline_at) + 5000) {
    return finalize(a.id, 'time_expired');
  }
  return a;
}

router.get('/exam', (req, res) => {
  const s = req.student;
  const test = get('SELECT * FROM tests WHERE id = ?', s.test_id);
  const a = autoFinalizeIfExpired(loadAttempt(s.id));
  res.json({
    student: { full_name: s.full_name, email: s.email, mobile: s.mobile },
    test: {
      name: test.name, exam_code: test.exam_code, description: test.description, duration_min: test.duration_min,
      marks_correct: test.marks_correct, marks_wrong: test.marks_wrong, max_violations: test.max_violations,
      instructions: test.instructions, state: testWindowState(test),
      sections: sectionsWithPaper(test.id).map((x) => ({ name: x.name, question_count: x.question_count })),
    },
    attempt: a ? { status: a.status, deadline_at: a.deadline_at } : null,
  });
});

router.post('/start', (req, res) => {
  const s = req.student;
  let a = loadAttempt(s.id);
  if (a) return res.json({ ok: true, status: a.status });
  const test = get('SELECT * FROM tests WHERE id = ?', s.test_id);
  const state = testWindowState(test);
  if (state !== 'open') fail(403, STATE_MSG[state]);
  a = tx(() => createAttempt(s, test, { ip: req.ip, ua: req.get('User-Agent') }));
  res.json({ ok: true, status: a.status });
});

const toDisplay = (perm, original) => (perm ? perm.indexOf(original) : original);

router.get('/paper', (req, res) => {
  const a = autoFinalizeIfExpired(loadAttempt(req.student.id));
  if (!a) fail(409, 'Exam not started');
  if (a.status === 'submitted') return res.json({ submitted: true });
  const test = get('SELECT * FROM tests WHERE id = ?', a.test_id);
  const order = JSON.parse(a.question_order);
  const maps = JSON.parse(a.option_maps);
  const answers = JSON.parse(a.answers);
  const qids = order.flatMap((x) => x.qids);
  const qmap = new Map(all(`SELECT id, text, options, diagram, options_format FROM questions WHERE id IN (${qids.map(() => '?').join(',')})`, ...qids)
    .map((q) => [q.id, q]));

  const displayAnswers = {};
  for (const [qid, ans] of Object.entries(answers)) displayAnswers[qid] = toDisplay(maps[qid], ans);

  res.json({
    sections: order.map((sec) => ({
      name: sec.name,
      questions: sec.qids.map((id) => {
        const q = qmap.get(id);
        const opts = JSON.parse(q.options);
        const perm = maps[id];
        return {
          id, text: q.text, options: perm ? perm.map((i) => opts[i]) : opts,
          options_format: q.options_format, diagram: q.diagram ? JSON.parse(q.diagram) : null,
        };
      }),
    })),
    answers: displayAnswers,
    marked: JSON.parse(a.marked),
    visited: JSON.parse(a.visited),
    deadline_at: a.deadline_at,
    server_now: new Date().toISOString(),
    violations: a.violations,
    max_violations: test.max_violations,
    marks_correct: test.marks_correct,
    marks_wrong: test.marks_wrong,
  });
});

function activeAttempt(studentId) {
  const a = autoFinalizeIfExpired(loadAttempt(studentId));
  if (!a) fail(409, 'Exam not started');
  if (a.status === 'submitted') fail(410, 'Exam already submitted');
  if (Date.now() > Date.parse(a.deadline_at) + 5000) fail(410, 'Time is over');
  return a;
}

// Autosave a single response. `answer` is the option index as displayed to the candidate.
router.post('/answer', (req, res) => {
  const a = activeAttempt(req.student.id);
  const qid = v.int(req.body.qid, 'Question', { min: 1 });
  const order = JSON.parse(a.question_order);
  if (!order.some((s) => s.qids.includes(qid))) fail(400, 'Question is not part of your paper');

  const answers = JSON.parse(a.answers);
  const marked = new Set(JSON.parse(a.marked));
  const visited = new Set(JSON.parse(a.visited));
  const maps = JSON.parse(a.option_maps);

  if ('answer' in req.body) {
    if (req.body.answer === null) delete answers[qid];
    else {
      const disp = v.int(req.body.answer, 'Answer', { min: 0, max: 3 });
      answers[qid] = maps[qid] ? maps[qid][disp] : disp;
    }
  }
  if ('marked' in req.body) {
    if (req.body.marked) marked.add(qid); else marked.delete(qid);
  }
  visited.add(qid);
  run('UPDATE attempts SET answers = ?, marked = ?, visited = ? WHERE id = ?',
    JSON.stringify(answers), JSON.stringify([...marked]), JSON.stringify([...visited]), a.id);
  res.json({ ok: true });
});

const VIOLATIONS = ['tab_switch', 'window_blur', 'fullscreen_exit', 'copy_attempt', 'devtools', 'multiple_screens', 'other'];

router.post('/violation', (req, res) => {
  const a = activeAttempt(req.student.id);
  const type = VIOLATIONS.includes(req.body.type) ? req.body.type : 'other';
  const test = get('SELECT max_violations FROM tests WHERE id = ?', a.test_id);
  const log = JSON.parse(a.violation_log);
  // Ignore bursts: blur + visibilitychange for one tab switch arrive together.
  const last = log[log.length - 1];
  if (last && Date.now() - Date.parse(last.at) < 2500) return res.json({ violations: a.violations, max: test.max_violations });
  log.push({ type, at: new Date().toISOString() });
  const count = a.violations + 1;
  run('UPDATE attempts SET violations = ?, violation_log = ? WHERE id = ?', count, JSON.stringify(log.slice(-200)), a.id);
  // max_violations = the violation number that closes the exam (default 2: one warning, then closed).
  if (test.max_violations > 0 && count >= test.max_violations) {
    finalize(a.id, 'violations');
    return res.json({ violations: count, max: test.max_violations, auto_submitted: true });
  }
  res.json({ violations: count, max: test.max_violations });
});

router.post('/submit', (req, res) => {
  const a = loadAttempt(req.student.id);
  if (!a) fail(409, 'Exam not started');
  finalize(a.id, Date.now() > Date.parse(a.deadline_at) ? 'time_expired' : 'candidate');
  res.json({ ok: true });
});

router.get('/result', (req, res) => {
  const a = autoFinalizeIfExpired(loadAttempt(req.student.id));
  if (!a || a.status !== 'submitted') fail(409, 'Exam not submitted yet');
  const test = get('SELECT * FROM tests WHERE id = ?', a.test_id);
  const s = req.student;
  const base = {
    student: { full_name: s.full_name, email: s.email, mobile: s.mobile },
    test: { name: test.name, exam_code: test.exam_code },
    submitted_at: a.submitted_at, submit_reason: a.submit_reason,
  };
  if (!test.show_result) return res.json({ ...base, published: false });
  const ranks = rankings(test.id);
  const me = ranks.find((r) => r.id === a.id);
  const max = sectionsWithPaper(test.id).reduce((m, x) => m + x.question_count, 0) * test.marks_correct;
  res.json({
    ...base,
    published: true,
    score: a.score, max_score: max, correct: a.correct, wrong: a.wrong, unanswered: a.unanswered,
    sections: JSON.parse(a.section_scores || '[]'),
    marks_correct: test.marks_correct, marks_wrong: test.marks_wrong,
    rank: me ? me.rank : null, candidates: ranks.length,
    time_taken_sec: me ? me.time_taken_sec : null,
  });
});

module.exports = router;
