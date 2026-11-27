// Partner API for the Edmission CRM: /api/v1/partner. Server-to-server only: Bearer key + HMAC signature
// (crm.partnerAuth), JSON in and out, errors as { error: { code, message, field } }.
const express = require('express');
const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const { all, get, run, tx } = require('../db');
const crm = require('../crm');
const { finalizeExpired } = require('../exam');

const router = express.Router();
const { pfail } = crm;

// Raw body kept for the signature check. Bulk calls with base64 photos can be large.
router.use(express.json({ limit: '25mb', verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));

// Every call is logged (method, path, status, caller IP, error) for 30 days: Admin → Settings → CRM integration.
router.use((req, res, next) => {
  res.on('finish', () => {
    try {
      run('INSERT INTO crm_log (at, method, path, status, ip, error) VALUES (?, ?, ?, ?, ?, ?)',
        new Date().toISOString(), req.method, req.originalUrl.slice(0, 200), res.statusCode, req.ip, res.locals.err || null);
    } catch { /* logging never breaks a request */ }
  });
  next();
});

router.use(rateLimit({
  windowMs: 60000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: () => 'partner',
  handler: (req, res) => res.status(429).json({ error: { code: 'rate_limited', message: 'Over 600 calls per minute. Retry after the Retry-After seconds.' } }),
}));

router.use(crm.partnerAuth);

// Idempotency-Key: a retried POST/PATCH/DELETE with the same key returns the first answer (kept 24 hours).
router.use((req, res, next) => {
  const key = req.get('Idempotency-Key');
  if (!key || req.method === 'GET') return next();
  if (key.length > 100) pfail(400, 'validation_failed', 'Idempotency-Key is too long (max 100)');
  const id = `${req.method} ${req.path} ${key}`;
  const hit = get('SELECT status, body FROM crm_idempotency WHERE key = ?', id);
  if (hit) return res.status(hit.status).set('Idempotent-Replayed', 'true').type('json').send(hit.body);
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 500) {
      run('INSERT OR IGNORE INTO crm_idempotency (key, status, body, at) VALUES (?, ?, ?, ?)', id, res.statusCode, JSON.stringify(body), new Date().toISOString());
    }
    return json(body);
  };
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const crmTests = () => all("SELECT * FROM tests WHERE registration_mode = 'crm' AND public_code IS NOT NULL ORDER BY start_at, id");

// ---------------- exams ----------------
router.get('/exams', (req, res) => {
  res.json(crmTests().filter((t) => t.status !== 'draft' || t.start_at).map((t) => crm.examView(t, req)));
});

router.get('/exams/:code', (req, res) => {
  const t = crmTests().find((x) => x.public_code === String(req.params.code).toUpperCase()) || pfail(404, 'not_found', 'Unknown exam_code', 'exam_code');
  res.json(crm.examView(t, req));
});

// ---------------- candidates ----------------
// exam_code wins; otherwise the course (taxonomy) picks the exam whose CRM course list contains it.
function resolveTest(examCode, taxonomy) {
  const tests = crmTests();
  if (examCode) {
    return tests.find((t) => t.public_code === examCode) || pfail(404, 'not_found', `Unknown exam_code ${examCode}`, 'exam_code');
  }
  const want = String(taxonomy || '').toLowerCase();
  const hits = tests.filter((t) => crm.examStatus(t) !== 'closed' && crm.examStatus(t) !== 'ended'
    && t.crm_taxonomies.split('\n').map((x) => x.trim().toLowerCase()).includes(want));
  if (!hits.length) pfail(404, 'not_found', `No open exam is mapped to taxonomy "${taxonomy}"; send exam_code`, 'exam_code');
  if (hits.length > 1) pfail(409, 'ambiguous_exam', `Taxonomy "${taxonomy}" is mapped to more than one exam; send exam_code`, 'exam_code');
  return hits[0];
}

const hasAttempt = (sid) => !!get('SELECT 1 FROM attempts WHERE student_id = ?', sid);

// Create or update (keyed on crm_candidate_id). `partial` = PATCH: only the fields sent change.
async function upsert(body, { partial = false, crmId: pathId } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) pfail(400, 'validation_failed', 'Body must be a JSON object');
  const crmId = pathId || crm.str(body, 'crm_candidate_id', { max: 64, re: /^[\w.:/-]+$/ });
  const cur = get('SELECT * FROM students WHERE crm_id = ?', crmId);
  if (partial && !cur) pfail(404, 'not_found', 'Unknown crm_candidate_id', 'crm_candidate_id');
  const req = !partial; // fields required when creating
  const f = {
    application_no: crm.str(body, 'application_no', { required: req, min: 3, max: 30, re: /^[A-Z0-9/-]+$/, upper: true }),
    first_name: crm.str(body, 'first_name', { required: req, max: 80, re: crm.NAME_RE }),
    last_name: body.last_name === undefined ? undefined : crm.str(body, 'last_name', { required: false, max: 80, re: crm.NAME_RE }) || '',
    email: crm.email(body, req),
    phone: crm.phone(body, req),
    taxonomy: crm.str(body, 'taxonomy', { required: req, max: 120 }),
    exam_code: crm.str(body, 'exam_code', { required: false, max: 40, upper: true }),
    payment_at: crm.date(body, 'application_payment_date', req),
    app_submitted_at: crm.date(body, 'application_submission_date', req),
  };
  if (!partial && !f.payment_at) pfail(400, 'payment_required', 'Only paid applicants can be registered', 'application_payment_date');

  // Which exam: on create always; on update only when exam_code/taxonomy is sent and differs.
  let test = cur ? get('SELECT * FROM tests WHERE id = ?', cur.test_id) : null;
  // An update moves the candidate only when a different exam_code is sent; a new taxonomy alone is just stored.
  const wantsMove = f.exam_code ? f.exam_code !== (test && test.public_code) : !cur;
  if (!cur || wantsMove) {
    const next = resolveTest(f.exam_code, f.taxonomy || (cur && cur.taxonomy));
    if (cur && hasAttempt(cur.id) && next.id !== cur.test_id) pfail(409, 'already_started', 'The candidate has already started the exam');
    test = next;
  }
  const st = crm.examStatus(test);
  if (st === 'closed' || st === 'ended') pfail(409, 'exam_ended', 'This exam has already ended', 'exam_code');
  const moving = !cur || cur.test_id !== test.id;
  if (moving && !crm.registrationOpen(test)) {
    pfail(409, 'registration_closed', `Registration for ${test.public_code} closed at ${new Date(test.reg_close_at).toISOString()}`, 'exam_code');
  }
  if (cur && hasAttempt(cur.id)) {
    const changing = ['first_name', 'last_name', 'email', 'phone', 'application_no'].some((k) => f[k] !== undefined && f[k] !== null
      && f[k] !== { first_name: cur.first_name, last_name: cur.last_name || '', email: cur.email, phone: cur.mobile, application_no: cur.application_no }[k]);
    if (changing || body.photo) pfail(409, 'already_started', 'The candidate has already started the exam; details can no longer change');
  }

  const photo = body.photo ? await crm.readPhoto(body.photo) : null;
  if (!cur && !photo && test.face_match) pfail(400, 'validation_failed', 'photo is required (this exam uses face match)', 'photo');

  const now = new Date().toISOString();
  const pick = (k, curVal) => (f[k] === undefined || f[k] === null ? curVal : f[k]);
  const first = pick('first_name', cur && cur.first_name);
  const last = f.last_name === undefined ? (cur && cur.last_name) || '' : f.last_name;
  const row = {
    test_id: test.id,
    full_name: `${first} ${last}`.trim(),
    first_name: first,
    last_name: last,
    email: pick('email', cur && cur.email),
    mobile: pick('phone', cur && cur.mobile),
    application_no: pick('application_no', cur && cur.application_no),
    taxonomy: pick('taxonomy', cur && cur.taxonomy),
    payment_at: pick('payment_at', cur && cur.payment_at),
    app_submitted_at: pick('app_submitted_at', cur && cur.app_submitted_at),
    crm_updated_at: now,
    revoked: 0,
  };
  if (photo) {
    row.photo_file = crm.savePhoto(crmId, photo);
    row.face_status = 'pending';
    row.face_tries = 0;
  }
  if (moving && cur) { row.face_status = 'pending'; row.face_tries = 0; row.session_id = null; }

  let sid;
  try {
    sid = tx(() => {
      if (cur) {
        run(`UPDATE students SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), cur.id);
        return cur.id;
      }
      const token = crypto.randomBytes(18).toString('base64url');
      return Number(run(`INSERT INTO students (test_id, full_name, address, email, mobile, parent_mobile, reg_ip, crm_id, link_token, first_name, last_name,
          application_no, taxonomy, payment_at, app_submitted_at, photo_file, crm_updated_at)
          VALUES (?, ?, '', ?, ?, '', 'crm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.test_id, row.full_name, row.email, row.mobile, crmId, token, row.first_name, row.last_name,
      row.application_no, row.taxonomy, row.payment_at, row.app_submitted_at, row.photo_file || null, now).lastInsertRowid);
    });
  } catch (e) {
    if (/UNIQUE/.test(e.message) && /email/.test(e.message)) pfail(409, 'duplicate_email', 'This email is already used by another candidate in the same exam', 'email');
    throw e;
  }
  return { created: !cur, student: get('SELECT * FROM students WHERE id = ?', sid) };
}

router.post('/candidates', wrap(async (req, res) => {
  const r = await upsert(req.body);
  res.status(r.created ? 201 : 200).json(crm.candidateView(r.student, req));
}));

router.post('/candidates/bulk', wrap(async (req, res) => {
  const list = req.body && req.body.candidates;
  if (!Array.isArray(list) || !list.length) pfail(400, 'validation_failed', 'candidates must be a non-empty array', 'candidates');
  if (list.length > 500) pfail(400, 'validation_failed', 'At most 500 candidates per call', 'candidates');
  const results = new Array(list.length);
  let i = 0;
  // A few at a time: photos given as URLs are downloaded.
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < list.length) {
      const n = i++;
      try {
        const r = await upsert(list[n]);
        results[n] = { index: n, ok: true, result: r.created ? 'created' : 'updated', candidate: crm.candidateView(r.student, req) };
      } catch (e) {
        if (!(e instanceof crm.PartnerError)) console.error('partner bulk:', e);
        results[n] = { index: n, ok: false, crm_candidate_id: list[n] && list[n].crm_candidate_id,
          error: e instanceof crm.PartnerError ? { code: e.code, message: e.message, field: e.field } : { code: 'server_error', message: 'Unexpected error' } };
      }
    }
  }));
  res.json({ total: list.length, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
}));

const byCrmId = (id) => get('SELECT * FROM students WHERE crm_id = ?', String(id)) || pfail(404, 'not_found', 'Unknown crm_candidate_id', 'crm_candidate_id');

router.get('/candidates/:id', (req, res) => res.json(crm.candidateView(byCrmId(req.params.id), req)));

router.patch('/candidates/:id', wrap(async (req, res) => {
  byCrmId(req.params.id);
  const r = await upsert(req.body, { partial: true, crmId: String(req.params.id) });
  res.json(crm.candidateView(r.student, req));
}));

// Revoke (e.g. refund): the candidate can no longer log in. Re-sending the candidate with POST restores them.
router.delete('/candidates/:id', (req, res) => {
  const s = byCrmId(req.params.id);
  if (hasAttempt(s.id)) pfail(409, 'already_started', 'The candidate has already started the exam');
  run('UPDATE students SET revoked = 1, session_id = NULL, crm_updated_at = ? WHERE id = ?', new Date().toISOString(), s.id);
  res.json(crm.candidateView(get('SELECT * FROM students WHERE id = ?', s.id), req));
});

// ---------------- results (pull) ----------------
router.get('/results', (req, res) => {
  const code = String(req.query.exam_code || '').toUpperCase();
  if (!code) pfail(400, 'validation_failed', 'exam_code is required', 'exam_code');
  const t = crmTests().find((x) => x.public_code === code) || pfail(404, 'not_found', 'Unknown exam_code', 'exam_code');
  if (!t.results_published_at) pfail(409, 'not_published', 'Results for this exam are not published yet');
  let since = null;
  if (req.query.since) {
    since = new Date(String(req.query.since));
    if (Number.isNaN(since.getTime())) pfail(400, 'validation_failed', 'since must be an ISO 8601 date-time', 'since');
  }
  finalizeExpired(t.id);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const per = 500;
  const rows = (since && Date.parse(t.results_published_at) < since.getTime()) ? []
    : all('SELECT * FROM students WHERE test_id = ? AND crm_id IS NOT NULL AND revoked = 0 ORDER BY id', t.id);
  res.json({
    exam_code: t.public_code, published_at: t.results_published_at, page, per_page: per, total: rows.length,
    items: rows.slice((page - 1) * per, page * per).map((s) => crm.resultPayload(s, t)),
  });
});

router.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint' } }));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof crm.PartnerError) {
    res.locals.err = `${err.code}: ${err.message}`;
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) } });
  }
  if (err.type === 'entity.parse.failed') { res.locals.err = 'invalid json'; return res.status(400).json({ error: { code: 'validation_failed', message: 'Invalid JSON' } }); }
  if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request over 25 MB; send fewer candidates or photo URLs' } });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: { code: 'error', message: err.message } });
  console.error('partner api:', err);
  res.locals.err = String(err.message).slice(0, 200);
  res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong. Retry with back-off.' } });
});

module.exports = router;
