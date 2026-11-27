const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { all, get, run, tx } = require('../db');
const {
  fail, cookieOpts, sign, verify, requireRegistered, requireStudent, v,
} = require('../security');
const { testWindowState, sectionsWithPaper, createAttempt, finalize } = require('../exam');
const proctor = require('../proctor');
const crm = require('../crm');
const mailer = require('../mailer');

const router = express.Router();

// Thousands of candidates in one exam hall (or on one mobile network) can share a single public IP, so the
// per-IP caps only stop floods. Wrong pass keys are throttled per registration: one candidate's typos never
// lock out the rest of the hall, and guessing an 8-character key at 1,000 tries per 10 minutes is hopeless.
const registerLimiter = rateLimit({ windowMs: 10 * 60000, limit: 3000, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes.' } });
const passkeyLimiter = rateLimit({ windowMs: 10 * 60000, limit: 10, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => {
    const reg = verify(req.cookies?.kl_reg);
    return reg && reg.role === 'reg' ? `reg:${reg.sid}` : `ip:${ipKeyGenerator(req.ip)}`;
  },
  message: { error: 'Too many wrong pass keys. Please wait 10 minutes or contact the invigilator.' } });
const passkeyIpLimiter = rateLimit({ windowMs: 10 * 60000, limit: 1000, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many wrong pass keys from this network. Please wait a few minutes.' } });

const STATE_MSG = {
  not_live: 'This exam is not open right now.',
  not_started: 'This exam has not started yet.',
  ended: 'The exam window has closed.',
};

// What the exam and result pages show under the candidate's name: their email, the application number, or nothing
// for a name-only (trial) registration.
const shownContact = (e) => (e.startsWith('name-only:') ? '' : e.startsWith('app:') ? `Application No ${e.slice(4)}` : e);

// ---------- public ----------
router.get('/tests', (req, res) => {
  const tests = all("SELECT * FROM tests WHERE status = 'live' ORDER BY start_at, id")
    .filter((t) => testWindowState(t) !== 'ended')
    .map((t) => ({
      id: t.id, name: t.name, exam_code: t.exam_code, description: t.description, duration_min: t.duration_min,
      start_at: t.start_at, end_at: t.end_at, state: testWindowState(t), registration_mode: t.registration_mode,
      sections: sectionsWithPaper(t.id).map((s) => ({ name: s.name, question_count: s.question_count })),
    }));
  res.json(tests);
});

// ---------- registration ----------
router.post('/register', registerLimiter, (req, res) => {
  const b = req.body;
  const test = get('SELECT * FROM tests WHERE id = ?', v.int(b.test_id, 'Exam', { min: 1 })) || fail(404, 'Exam not found');
  if (test.registration_mode === 'crm') fail(403, 'This exam is only for applicants registered through KL admissions. Use the exam link sent to you, or log in with your registered email or mobile number.');
  const state = testWindowState(test);
  if (state !== 'open') fail(403, STATE_MSG[state]);

  const fullName = v.str(b.full_name, 'Full name', { min: 3, max: 120 }).replace(/\s+/g, ' ');
  if (!/^[\p{L} .'-]+$/u.test(fullName)) fail(400, 'Full name may contain only letters, spaces, dots and hyphens');

  // Trial/practice sessions ask only for a name. Each registration is a new candidate; the session cookie lets
  // them resume in the same browser. The placeholder email keeps the per-test uniqueness rule intact.
  if (test.registration_mode === 'name_only') {
    const r = run(`INSERT INTO students (test_id, full_name, address, email, mobile, parent_mobile, reg_ip) VALUES (?, ?, '', ?, '', '', ?)`,
      test.id, fullName, `name-only:${crypto.randomBytes(8).toString('hex')}`, req.ip);
    res.cookie('kl_reg', sign({ sid: Number(r.lastInsertRowid), tid: test.id, role: 'reg' }, 3600), cookieOpts(3600 * 1000));
    return res.json({ ok: true, name: fullName, test: test.name, returning: false });
  }

  // 'application' asks for the name and the application number (KLBSAT). The number is kept in the email column as
  // 'app:<number>', so the per-test uniqueness rule gives one attempt per application number; the same number and
  // name resume an unfinished exam on any device.
  if (test.registration_mode === 'application') {
    const appNo = v.str(b.application_no, 'Application number', { min: 3, max: 30 }).replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z0-9/-]+$/.test(appNo)) fail(400, 'Application number may contain only letters, digits, / and -');
    if (test.app_allowlist && !test.app_allowlist.split('\n').includes(appNo)) {
      fail(403, 'This application number is not on the list for this exam. Please check the number, or contact your KL admissions manager.');
    }
    const key = `app:${appNo}`;
    let student = get('SELECT * FROM students WHERE test_id = ? AND email = ?', test.id, key);
    const returning = !!student;
    if (student) {
      if (student.full_name.toLowerCase() !== fullName.toLowerCase()) fail(409, 'This application number is already registered with a different name.');
      const a = get('SELECT status FROM attempts WHERE student_id = ?', student.id);
      if (a && a.status === 'submitted') fail(409, 'You have already submitted this exam.');
    } else {
      const r = run(`INSERT INTO students (test_id, full_name, address, email, mobile, parent_mobile, reg_ip) VALUES (?, ?, '', ?, '', '', ?)`,
        test.id, fullName, key, req.ip);
      student = get('SELECT * FROM students WHERE id = ?', r.lastInsertRowid);
    }
    res.cookie('kl_reg', sign({ sid: student.id, tid: test.id, role: 'reg' }, 3600), cookieOpts(3600 * 1000));
    return res.json({ ok: true, name: student.full_name, test: test.name, returning });
  }

  // 'contact' asks for name, email and mobile only; 'full' also for the address and a parent's mobile.
  const full = test.registration_mode !== 'contact';
  const d = {
    full_name: fullName,
    address: full ? v.str(b.address, 'Address', { min: 5, max: 500 }) : '',
    email: v.email(b.email),
    mobile: v.mobile(b.mobile, 'Mobile number'),
    parent_mobile: full ? v.mobile(b.parent_mobile, 'Parent mobile number') : '',
  };
  if (full && d.mobile === d.parent_mobile) fail(400, 'Parent mobile number must be different from your mobile number');

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

// bcrypt takes ~50 ms of the single JS thread; 5,000 candidates unlocking at the start would stall everyone for
// minutes. Once a key has matched a test's hash, its keyed digest is remembered (in memory, tied to that hash, so a
// changed pass key is checked afresh) and later correct entries are verified in microseconds. Wrong keys still
// take the slow, rate-limited bcrypt path.
const knownGoodKey = new Map(); // test id -> { hash, digest }
const keyDigest = (k) => crypto.createHmac('sha256', process.env.APP_SECRET).update(k).digest();
async function passkeyMatches(test, passkey) {
  if (!test.passkey_hash) return false;
  const known = knownGoodKey.get(test.id);
  const d = keyDigest(passkey);
  if (known && known.hash === test.passkey_hash && crypto.timingSafeEqual(known.digest, d)) return true;
  if (!(await bcrypt.compare(passkey, test.passkey_hash))) return false;
  knownGoodKey.set(test.id, { hash: test.passkey_hash, digest: d });
  return true;
}

router.post('/unlock', passkeyIpLimiter, passkeyLimiter, requireRegistered, async (req, res) => {
  const passkey = v.str(req.body.passkey, 'Pass key', { max: 64 });
  const student = get('SELECT * FROM students WHERE id = ? AND test_id = ?', req.reg.sid, req.reg.tid) || fail(401, 'Registration not found');
  const test = get('SELECT * FROM tests WHERE id = ?', student.test_id);
  const state = testWindowState(test);
  if (state !== 'open') fail(403, STATE_MSG[state]);
  if (!(await passkeyMatches(test, passkey))) fail(401, 'Incorrect pass key');

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

// ---------- CRM candidates (Edmission) ----------
// Candidates pushed by the CRM log in with their personal link (/e/<token>) or with their registered email/mobile,
// then a one-time code; there is no pass key. Before the exam starts, a live webcam photo is compared with the
// applicant photo from the CRM.
const crmLimiter = rateLimit({ windowMs: 10 * 60000, limit: 3000, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes.' } });
const NOT_FOUND = 'We could not find your registration for this exam. Use the exam link sent to you, or the email / mobile number you gave when applying.';
const ist = (x) => new Date(x).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const faceRequired = (st, test) => !!test.face_match && !!st.photo_file && st.face_status === 'pending'
  && !get('SELECT 1 FROM attempts WHERE student_id = ?', st.id);

function findCrmStudent(b) {
  let st = null;
  if (b.token) {
    const tok = String(b.token);
    if (/^[\w-]{16,64}$/.test(tok)) st = get('SELECT * FROM students WHERE link_token = ?', tok);
  } else {
    const tid = v.int(b.test_id, 'Exam', { min: 1 });
    const login = v.str(b.login, 'Email or mobile number', { max: 254 }).toLowerCase();
    const digits = login.replace(/[\s-]/g, '');
    const mob = /^(\+?91)?[6-9]\d{9}$/.test(digits) ? digits.slice(-10) : '-';
    st = get('SELECT * FROM students WHERE test_id = ? AND crm_id IS NOT NULL AND (email = ? OR mobile = ?) ORDER BY id LIMIT 1', tid, login, mob);
  }
  if (!st || !st.crm_id) fail(404, NOT_FOUND);
  if (st.revoked) fail(403, 'Your registration for this exam has been cancelled. Please contact KL admissions.');
  const test = get('SELECT * FROM tests WHERE id = ?', st.test_id);
  if (test.registration_mode !== 'crm') fail(404, NOT_FOUND);
  return { st, test };
}
function crmWindowCheck(test) {
  const state = testWindowState(test);
  if (state === 'open') return;
  if (test.start_at && Date.now() < Date.parse(test.start_at)) fail(403, `Your exam opens on ${ist(test.start_at)}. Please come back then.`);
  fail(403, STATE_MSG[state]);
}
const lockedOut = (st) => st.otp_lock_until && Date.now() < Date.parse(st.otp_lock_until);

router.post('/crm/lookup', crmLimiter, (req, res) => {
  const { st, test } = findCrmStudent(req.body);
  const a = get('SELECT status FROM attempts WHERE student_id = ?', st.id);
  res.json({
    name: st.first_name || st.full_name, application_no: st.application_no,
    exam: { name: test.name, start_at: test.start_at, end_at: test.end_at, duration_min: test.duration_min, state: testWindowState(test), opens: test.start_at ? ist(test.start_at) : null },
    email: crm.maskEmail(st.email), phone: crm.maskPhone(st.mobile), submitted: !!(a && a.status === 'submitted'),
  });
});

router.post('/crm/otp', crmLimiter, async (req, res) => {
  const { st, test } = findCrmStudent(req.body);
  crmWindowCheck(test);
  const a = get('SELECT status FROM attempts WHERE student_id = ?', st.id);
  if (a && a.status === 'submitted') fail(409, 'You have already submitted this exam.');
  if (lockedOut(st)) fail(429, 'Too many wrong codes. Please wait 15 minutes and try again.');
  if (st.otp_sent_at && Date.now() - Date.parse(st.otp_sent_at) < crm.OTP_RESEND_MS) fail(429, 'A code was just sent. Please wait a minute before asking for another one.');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  run('UPDATE students SET otp_hash = ?, otp_expires = ?, otp_tries = 0, otp_sent_at = ? WHERE id = ?',
    crm.otpHash(st.id, code), new Date(Date.now() + crm.OTP_TTL_MS).toISOString(), new Date().toISOString(), st.id);
  const ch = mailer.channels();
  let sent = [];
  if (ch.email || ch.sms) {
    sent = await mailer.sendOtp({ email: st.email, mobile: st.mobile, name: st.first_name || st.full_name, exam: test.name, otp: code });
  } else if (process.env.NODE_ENV !== 'production') {
    console.log(`[dev] login code for ${st.crm_id}: ${code}`);
    sent = ['console'];
  }
  if (!sent.length) {
    run('UPDATE students SET otp_sent_at = NULL WHERE id = ?', st.id);
    fail(503, 'We could not send your login code right now. Please try again in a minute or contact the exam helpdesk.');
  }
  res.json({ ok: true, sent_to: sent.map((c) => (c === 'sms' ? crm.maskPhone(st.mobile) : c === 'email' ? crm.maskEmail(st.email) : 'the server log (test mode)')) });
});

router.post('/crm/verify', crmLimiter, (req, res) => {
  const { st, test } = findCrmStudent(req.body);
  if (lockedOut(st)) fail(429, 'Too many wrong codes. Please wait 15 minutes and ask for a new code.');
  const otp = v.str(req.body.otp, 'Code', { max: 12 }).replace(/\D/g, '');
  if (!st.otp_hash || !st.otp_expires || Date.now() > Date.parse(st.otp_expires)) fail(400, 'The code has expired. Please ask for a new code.');
  const ok = otp.length === 6 && crypto.timingSafeEqual(Buffer.from(crm.otpHash(st.id, otp)), Buffer.from(st.otp_hash));
  if (!ok) {
    const tries = st.otp_tries + 1;
    const lock = tries >= crm.OTP_MAX_TRIES;
    run('UPDATE students SET otp_tries = ?, otp_lock_until = ?, otp_hash = ? WHERE id = ?',
      tries, lock ? new Date(Date.now() + crm.OTP_LOCK_MS).toISOString() : null, lock ? null : st.otp_hash, st.id);
    fail(401, lock ? 'Too many wrong codes. Please wait 15 minutes and ask for a new code.' : `Incorrect code. ${crm.OTP_MAX_TRIES - tries} attempt(s) left.`);
  }
  crmWindowCheck(test);
  const a = get('SELECT status FROM attempts WHERE student_id = ?', st.id);
  if (a && a.status === 'submitted') fail(409, 'You have already submitted this exam.');
  // New session id: any other browser using this candidate's login is signed out.
  const sess = crypto.randomBytes(16).toString('hex');
  run('UPDATE students SET session_id = ?, otp_hash = NULL, otp_tries = 0, otp_lock_until = NULL WHERE id = ?', sess, st.id);
  const ttl = (test.duration_min + 60) * 60;
  res.cookie('kl_stu', sign({ sid: st.id, sess, role: 'student' }, ttl), cookieOpts(ttl * 1000));
  res.clearCookie('kl_reg', { path: '/' });
  res.json({ ok: true, face_required: faceRequired(st, test) });
});

// ---------- exam ----------
router.use(requireStudent);

router.get('/crm/me', (req, res) => {
  const st = req.student;
  const test = get('SELECT * FROM tests WHERE id = ?', st.test_id);
  res.json({ crm: !!st.crm_id, name: st.first_name || st.full_name, face_required: !!st.crm_id && faceRequired(st, test), tries_left: Math.max(0, crm.FACE_TRIES - st.face_tries) });
});

const FACE_RESULT_KIND = { passed: 'face_verified', review: 'face_unsure', failed: 'face_mismatch' };

router.post('/crm/face', async (req, res) => {
  const st = req.student;
  const test = get('SELECT * FROM tests WHERE id = ?', st.test_id);
  if (!st.crm_id || !faceRequired(st, test)) return res.json({ done: true, status: st.face_status });
  if (paced(`face:${st.id}`, 3000)) fail(429, 'Please wait a moment and try again.');
  const jpeg = b64(req.body.image, 400000, 'image');
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) fail(400, 'Invalid image');
  const r = await crm.faceMatch(st, jpeg);
  const tries = st.face_tries + 1;
  let status = null;
  if (r.result === 'match') status = 'passed';
  else if (r.reason || tries >= crm.FACE_TRIES) status = r.result === 'mismatch' ? 'failed' : 'review'; // r.reason: the AI could not check: never block the candidate
  const file = proctor.saveFile({ test_id: st.test_id, id: `face-${st.id}` }, 'face', 'jpg', jpeg);
  run('UPDATE students SET face_tries = ?, face_status = COALESCE(?, face_status), face_checked_at = ?, face_file = ? WHERE id = ?',
    tries, status, new Date().toISOString(), file, st.id);
  if (status) return res.json({ done: true, status });
  res.json({
    done: false, tries_left: crm.FACE_TRIES - tries,
    message: r.result === 'mismatch' ? 'Your photo did not match your application photo.' : 'We could not see your face clearly.',
  });
});

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
    student: { full_name: s.full_name, email: shownContact(s.email), mobile: s.mobile },
    test: {
      id: test.id, name: test.name, exam_code: test.exam_code, description: test.description, duration_min: test.duration_min,
      marks_correct: test.marks_correct, marks_wrong: test.marks_wrong, max_violations: test.max_violations,
      instructions: test.instructions, state: testWindowState(test), proctor_mode: test.proctor_mode, proctor_lab: !!test.proctor_lab,
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
  if (s.revoked) fail(403, 'Your registration for this exam has been cancelled. Please contact KL admissions.');
  if (s.crm_id && faceRequired(s, test)) fail(403, 'Please complete the face check first: open your exam link again.');
  a = tx(() => createAttempt(s, test, { ip: req.ip, ua: req.get('User-Agent') }));
  if (s.crm_id && FACE_RESULT_KIND[s.face_status]) {
    proctor.addEvent(a, 'ai', FACE_RESULT_KIND[s.face_status], `Face check before the exam (${s.face_tries} photo(s))`, s.face_file);
  }
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

// ---------- AI proctoring (online-from-home exams) ----------
// Per-attempt pacing, so a tampered browser cannot run up Gemini costs: a routine frame at most every 40 s, a frame
// for a browser finding at most every 15 s, an event or recording of the same kind at most every 10 s.
const proctorPace = new Map(); // `${attemptId}:${what}` -> last time (ms)
function paced(key, ms) {
  const now = Date.now();
  if (now - (proctorPace.get(key) || 0) < ms) return true;
  proctorPace.set(key, now);
  if (proctorPace.size > 50000) proctorPace.clear();
  return false;
}
function proctoredAttempt(req) {
  const a = activeAttempt(req.student.id);
  const test = get('SELECT proctor_mode, proctor_lab FROM tests WHERE id = ?', a.test_id);
  if (!['ai', 'browser'].includes(test.proctor_mode)) fail(400, 'This exam is not proctored online');
  a.proctor_mode = test.proctor_mode;
  a.proctor_lab = !!test.proctor_lab;
  return a;
}
const b64 = (val, max, what) => {
  const buf = Buffer.from(v.str(val, what, { max: Math.ceil(max * 1.37) + 4 }), 'base64');
  if (buf.length < 100 || buf.length > max) fail(400, `Invalid ${what}`);
  return buf;
};

router.post('/proctor/frame', async (req, res) => {
  const a = proctoredAttempt(req);
  const reason = req.body.reason === 'reference' || req.body.reason === 'periodic' || proctor.BROWSER_KINDS.includes(req.body.reason)
    ? req.body.reason : 'periodic';
  const jpeg = b64(req.body.image, 300000, 'image');
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) fail(400, 'Invalid image');
  if (reason === 'reference' ? paced(`${a.id}:ref`, 30000) : reason === 'periodic' ? paced(`${a.id}:frame`, 40000) : paced(`${a.id}:trigger`, 15000)) {
    return res.json({ alerts: [], paced: true });
  }
  const st = req.student;
  if (st.crm_id && st.photo_file && !paced(`${a.id}:identity`, 30 * 60000)) {
    const t = get('SELECT face_match FROM tests WHERE id = ?', a.test_id);
    if (t.face_match) {
      crm.faceMatch(st, jpeg, a.id).then((r) => {
        if (r.result === 'mismatch') proctor.addEvent(a, 'ai', 'face_mismatch', 'Periodic identity check during the exam', proctor.saveFile(a, 'identity', 'jpg', jpeg));
      }).catch((e) => console.error('identity check:', e.message));
    }
  }
  res.json(await proctor.checkFrame(a, jpeg, reason, a.proctor_mode, a.proctor_lab));
});

router.post('/proctor/event', (req, res) => {
  const a = proctoredAttempt(req);
  const kind = proctor.BROWSER_KINDS.includes(req.body.kind) ? req.body.kind : null;
  if (!kind) fail(400, 'Unknown event');
  if (!paced(`${a.id}:ev:${kind}`, 10000)) proctor.addEvent(a, 'browser', kind, v.str(req.body.detail, 'detail', { required: false, max: 200 }) || '');
  res.json({ ok: true });
});

router.post('/proctor/audio', (req, res) => {
  const a = proctoredAttempt(req);
  const clip = b64(req.body.audio, 400000, 'recording');
  if (!paced(`${a.id}:audio`, 45000)) proctor.saveAudio(a, clip);
  res.json({ ok: true });
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
    student: { full_name: s.full_name, email: shownContact(s.email), mobile: s.mobile },
    test: { name: test.name, exam_code: test.exam_code },
    submitted_at: a.submitted_at, submit_reason: a.submit_reason,
  };
  if (!test.show_result) return res.json({ ...base, published: false });
  const max = sectionsWithPaper(test.id).reduce((m, x) => m + x.question_count, 0) * test.marks_correct;
  res.json({
    ...base,
    published: true,
    score: a.score, max_score: max, correct: a.correct, wrong: a.wrong, unanswered: a.unanswered,
    sections: JSON.parse(a.section_scores || '[]'),
    marks_correct: test.marks_correct, marks_wrong: test.marks_wrong,
    // No rank here: ranks are worked out by the admin after the exam closes, once every candidate has finished.
    time_taken_sec: Math.round((Date.parse(a.submitted_at) - Date.parse(a.started_at)) / 1000),
  });
});

module.exports = router;
