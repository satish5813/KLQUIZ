// Edmission CRM integration: partner authentication, candidate records pushed by the CRM, applicant photos,
// face match, one-time codes, and the webhook outbox that sends marks back.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { all, get, run } = require('./db');
const { HttpError, encrypt, decrypt } = require('./security');
const { testWindowState } = require('./exam');
const proctor = require('./proctor');
const { getConfig } = require('./gemini');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'crm-photos');
const MAX_PHOTO = 500 * 1024;
const OTP_TTL_MS = 10 * 60000;
const OTP_RESEND_MS = 60000;
const OTP_MAX_TRIES = 5;
const OTP_LOCK_MS = 15 * 60000;
const FACE_TRIES = 3;
const SIG_WINDOW_SEC = 300;

// Errors in the partner API's own format: { error: { code, message, field } }.
class PartnerError extends HttpError {
  constructor(status, code, message, field) {
    super(status, message);
    this.code = code;
    this.field = field;
  }
}
const pfail = (status, code, message, field) => { throw new PartnerError(status, code, message, field); };

// ---------------- settings ----------------
const setting = (k) => (get('SELECT value FROM settings WHERE key = ?', k) || {}).value || '';
const setSetting = (k, value) => {
  if (value === null || value === undefined || value === '') run('DELETE FROM settings WHERE key = ?', k);
  else run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(value));
};
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function partnerConfig() {
  const secret = setting('partner_secret');
  const hook = setting('partner_webhook');
  return {
    keyHash: setting('partner_key_hash'),
    keyHint: setting('partner_key_hint'),
    secret: secret ? decrypt(secret) : '',
    ips: setting('partner_ips').split(/[\s,]+/).filter(Boolean),
    webhook: hook ? decrypt(hook) : '',
    createdAt: setting('partner_key_created'),
  };
}

// New API key + signing secret. Returned once; only a hash of the key and the encrypted secret are kept.
function rotateCredentials() {
  const key = `klp_${crypto.randomBytes(24).toString('base64url')}`;
  const secret = crypto.randomBytes(32).toString('base64url');
  setSetting('partner_key_hash', sha(key).toString('hex'));
  setSetting('partner_key_hint', key.slice(-4));
  setSetting('partner_secret', encrypt(secret));
  setSetting('partner_key_created', new Date().toISOString());
  return { key, secret };
}

const sign = (secret, ts, body) => crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

// Bearer key + HMAC signature over "timestamp.body" + optional IP allow-list.
function partnerAuth(req, res, next) {
  const c = partnerConfig();
  if (!c.keyHash || !c.secret) return next(new PartnerError(503, 'not_configured', 'The partner API is not enabled yet.'));
  if (c.ips.length && !c.ips.includes(req.ip)) return next(new PartnerError(403, 'ip_not_allowed', `Calls from ${req.ip} are not allowed.`));
  const m = /^Bearer\s+(\S+)$/.exec(req.get('Authorization') || '');
  if (!m || !safeEq(sha(m[1]), Buffer.from(c.keyHash, 'hex'))) return next(new PartnerError(401, 'unauthorized', 'Missing or invalid API key.'));
  const ts = Number(req.get('X-KL-Timestamp'));
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > SIG_WINDOW_SEC) {
    return next(new PartnerError(401, 'unauthorized', 'X-KL-Timestamp is missing or more than 5 minutes off.'));
  }
  const given = Buffer.from(String(req.get('X-KL-Signature') || '').toLowerCase(), 'utf8');
  const want = Buffer.from(sign(c.secret, ts, req.rawBody || ''), 'utf8');
  if (!safeEq(given, want)) return next(new PartnerError(401, 'unauthorized', 'Invalid X-KL-Signature.'));
  next();
}

// ---------------- validation ----------------
const NAME_RE = /^[\p{L} .'-]+$/u;
function str(b, key, { required = true, max = 200, min = 1, re, upper } = {}) {
  let x = b[key];
  if (x === undefined || x === null || x === '') {
    if (required) pfail(400, 'validation_failed', `${key} is required`, key);
    return null;
  }
  if (typeof x !== 'string' && typeof x !== 'number') pfail(400, 'validation_failed', `${key} must be text`, key);
  x = String(x).trim().replace(/\s+/g, ' ');
  if (upper) x = x.toUpperCase();
  if (x.length < min || x.length > max) pfail(400, 'validation_failed', `${key} must be ${min}-${max} characters`, key);
  if (re && !re.test(x)) pfail(400, 'validation_failed', `${key} has invalid characters`, key);
  return x;
}
function date(b, key, required = true) {
  const x = b[key];
  if (x === undefined || x === null || x === '') {
    if (required) pfail(400, 'validation_failed', `${key} is required`, key);
    return null;
  }
  const d = new Date(x);
  if (typeof x !== 'string' || Number.isNaN(d.getTime())) pfail(400, 'validation_failed', `${key} must be an ISO 8601 date-time`, key);
  if (d.getTime() > Date.now() + 10 * 60000) pfail(400, 'validation_failed', `${key} cannot be in the future`, key);
  return d.toISOString();
}
function email(b, required) {
  const x = str(b, 'email', { required, max: 254 });
  if (x === null) return null;
  const e = x.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) pfail(400, 'validation_failed', 'email is not a valid address', 'email');
  return e;
}
function phone(b, required) {
  const x = str(b, 'phone', { required, max: 20 });
  if (x === null) return null;
  const p = x.replace(/[\s-]/g, '');
  if (!/^(\+?91)?[6-9]\d{9}$/.test(p)) pfail(400, 'validation_failed', 'phone must be a 10-digit Indian mobile number', 'phone');
  return p.slice(-10);
}

// ---------------- photos ----------------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

// The photo arrives as base64 (optionally a data: URL) or as a public https URL that we download once.
async function readPhoto(input) {
  if (typeof input !== 'string' || !input) pfail(400, 'validation_failed', 'photo is required', 'photo');
  let buf;
  if (/^https:\/\//i.test(input)) {
    let u;
    try { u = new URL(input); } catch { pfail(400, 'validation_failed', 'photo URL is not valid', 'photo'); }
    const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) pfail(400, 'photo_unavailable', 'photo URL host could not be resolved', 'photo');
    if (addrs.some((a) => isPrivateIp(a.address))) pfail(400, 'validation_failed', 'photo URL must be a public address', 'photo');
    let res;
    try {
      res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch (e) { pfail(400, 'photo_unavailable', `photo could not be downloaded (${e.message})`, 'photo'); }
    if (!res.ok) pfail(400, 'photo_unavailable', `photo URL returned HTTP ${res.status}`, 'photo');
    if (Number(res.headers.get('content-length')) > MAX_PHOTO) pfail(400, 'validation_failed', 'photo must be under 500 KB', 'photo');
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    const b64 = input.replace(/^data:image\/[a-z]+;base64,/i, '');
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) pfail(400, 'validation_failed', 'photo must be base64 JPEG/PNG or an https URL', 'photo');
    buf = Buffer.from(b64, 'base64');
  }
  if (buf.length > MAX_PHOTO) pfail(400, 'validation_failed', 'photo must be under 500 KB', 'photo');
  if (buf.length < 2000) pfail(400, 'validation_failed', 'photo is too small to show a face', 'photo');
  const ext = imageType(buf);
  if (!ext) pfail(400, 'validation_failed', 'photo must be a JPEG or PNG image', 'photo');
  return { buf, ext };
}

function savePhoto(crmId, { buf, ext }) {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const name = `${crypto.createHash('sha256').update(crmId).digest('hex').slice(0, 16)}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
  return name;
}
function photoPath(name) {
  if (!name || !/^[\w.-]+$/.test(name)) return null;
  const p = path.join(PHOTO_DIR, name);
  return fs.existsSync(p) ? p : null;
}

// ---------------- face match ----------------
const FACE_PROMPT = 'Image 1 is an applicant\'s ID photo. Image 2 is a live webcam photo taken just before an exam. '
  + 'Is the person in image 2 the same person as in image 1? Reply with one digit only: 2 = clearly the same person, '
  + '1 = cannot tell (face hidden, blurred, too dark or more than one face), 0 = clearly a different person.';

// Compares the applicant photo with a live JPEG. Returns 'match' | 'unsure' | 'mismatch'. Every call is recorded in
// the AI usage ledger like any proctoring check.
async function faceMatch(student, jpeg, attemptId = 0) {
  const ref = photoPath(student.photo_file);
  if (!ref) return { result: 'unsure', reason: 'no applicant photo' };
  const { key } = getConfig();
  if (!key) return { result: 'unsure', reason: 'AI not configured' };
  const refBuf = fs.readFileSync(ref);
  const body = {
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: imageType(refBuf) === 'png' ? 'image/png' : 'image/jpeg', data: refBuf.toString('base64') } },
      { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
      { text: FACE_PROMPT },
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 8, thinkingConfig: { thinkingLevel: 'minimal' } },
  };
  let j;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${proctor.MODEL}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
  } catch (e) {
    console.error('face match failed:', e.message);
    return { result: 'unsure', reason: 'AI unavailable' };
  }
  const u = j.usageMetadata || {};
  const tokIn = u.promptTokenCount || 0;
  const tokOut = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
  const usd = proctor.cost(tokIn, tokOut);
  run(`INSERT INTO ai_usage (at, test_id, attempt_id, student_id, student_name, model, reason, tokens_in, tokens_out, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, 'face_match', ?, ?, ?)`,
  new Date().toISOString(), student.test_id, attemptId, student.id, student.full_name, proctor.MODEL, tokIn, tokOut, usd);
  if (attemptId) {
    run('UPDATE attempts SET ai_calls = ai_calls + 1, ai_tokens_in = ai_tokens_in + ?, ai_tokens_out = ai_tokens_out + ?, ai_cost_usd = ai_cost_usd + ? WHERE id = ?',
      tokIn, tokOut, usd, attemptId);
  }
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  const d = (text.match(/[012]/) || [])[0];
  return { result: d === '2' ? 'match' : d === '0' ? 'mismatch' : 'unsure' };
}

// ---------------- one-time codes ----------------
const otpHash = (sid, code) => crypto.createHmac('sha256', process.env.APP_SECRET).update(`${sid}:${code}`).digest('hex');
const maskEmail = (e) => (e ? e.replace(/^(.)(.*)(@.*)$/, (m, a, b, c) => `${a}${'*'.repeat(Math.min(b.length, 6))}${c}`) : '');
const maskPhone = (p) => (p ? `******${p.slice(-4)}` : '');

// ---------------- views ----------------
const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const iso = (x) => (x ? new Date(x).toISOString() : null);

function examStatus(t, now = Date.now()) {
  if (t.status === 'closed') return 'closed';
  if (t.end_at && now > Date.parse(t.end_at)) return 'ended';
  if (t.status === 'live' && testWindowState(t, now) === 'open') return 'open';
  return 'scheduled';
}
const registrationOpen = (t, now = Date.now()) => examStatus(t, now) !== 'closed' && examStatus(t, now) !== 'ended'
  && (!t.reg_close_at || now <= Date.parse(t.reg_close_at));

function examView(t, req) {
  const secs = all('SELECT name, question_count FROM test_sections WHERE test_id = ? ORDER BY sort, id', t.id);
  return {
    exam_code: t.public_code,
    name: t.name,
    taxonomies: t.crm_taxonomies.split('\n').map((x) => x.trim()).filter(Boolean),
    registration_closes_at: iso(t.reg_close_at),
    registration_open: registrationOpen(t),
    window: { start: iso(t.start_at), end: iso(t.end_at) },
    duration_min: t.duration_min,
    pattern: `${secs.reduce((a, s) => a + s.question_count, 0)} MCQs: ${secs.map((s) => `${s.name} ${s.question_count}`).join(', ')}`,
    mode: t.proctor_mode === 'offline' ? 'exam_hall' : t.proctor_lab ? 'online_proctored_lab' : 'online_proctored',
    face_match: !!t.face_match,
    status: examStatus(t),
    results_published_at: iso(t.results_published_at),
    url: baseUrl(req),
  };
}

function candidateStatus(s, a, t) {
  if (s.revoked) return 'revoked';
  if (a && a.status === 'submitted') return t.results_published_at ? 'result_published' : 'submitted';
  if (a) return 'in_progress';
  if (s.face_status !== 'pending' || s.session_id) return 'verified';
  return 'eligible';
}

function candidateView(s, req) {
  const t = get('SELECT * FROM tests WHERE id = ?', s.test_id);
  const a = get('SELECT status FROM attempts WHERE student_id = ?', s.id);
  return {
    candidate_id: `c_${s.id}`,
    crm_candidate_id: s.crm_id,
    application_no: s.application_no,
    first_name: s.first_name,
    last_name: s.last_name || '',
    email: s.email,
    phone: s.mobile,
    taxonomy: s.taxonomy,
    status: candidateStatus(s, a, t),
    exam_code: t.public_code,
    exam_url: `${baseUrl(req)}/e/${s.link_token}`,
    exam_window: { start: iso(t.start_at), end: iso(t.end_at) },
    registration_closes_at: iso(t.reg_close_at),
    duration_min: t.duration_min,
    face_match: s.face_status,
    updated_at: s.crm_updated_at,
  };
}

// Marks payload, as sent by the webhook and the results API.
function resultPayload(s, t, event = 'result.published') {
  const a = get('SELECT * FROM attempts WHERE student_id = ?', s.id);
  const base = {
    event,
    sent_at: new Date().toISOString(),
    crm_candidate_id: s.crm_id,
    application_no: s.application_no,
    exam_code: t.public_code,
  };
  if (!a) return { ...base, status: s.revoked ? 'revoked' : 'absent', marks: null };
  const sections = JSON.parse(a.section_scores || '[]');
  const out = {
    ...base,
    status: a.status === 'submitted' ? 'submitted' : 'in_progress',
    started_at: a.started_at,
    submitted_at: a.submitted_at,
    submit_reason: { violations: 'violations', time_expired: 'time_up', test_closed: 'time_up', admin_forced: 'admin' }[a.submit_reason] || (a.submit_reason ? 'candidate' : null),
  };
  if (event === 'attempt.submitted') return out;
  const max = sections.reduce((x, sec) => x + sec.total * t.marks_correct, 0);
  return {
    ...out,
    marks: a.status === 'submitted' ? { total: a.score, max } : null,
    sections: sections.map((sec) => ({ name: sec.name, marks: sec.score, max: sec.total * t.marks_correct, correct: sec.correct, wrong: sec.wrong, unanswered: sec.unanswered })),
    correct: a.correct, wrong: a.wrong, unanswered: a.unanswered,
    proctoring: { risk: proctor.risk(a), flags: a.proctor_flags, face_match: s.face_status },
  };
}

// ---------------- outbox ----------------
function enqueue(event, s, t, payload) {
  if (!s.crm_id) return;
  const now = new Date().toISOString();
  run('INSERT INTO crm_outbox (event, crm_id, test_id, payload, created_at, next_at) VALUES (?, ?, ?, ?, ?, ?)',
    event, s.crm_id, t.id, JSON.stringify(payload), now, now);
}

// Called by finalize(): tells the CRM the candidate finished (marks follow when results are published).
function onSubmitted(attempt) {
  const s = get('SELECT * FROM students WHERE id = ?', attempt.student_id);
  if (!s || !s.crm_id) return;
  const t = get('SELECT * FROM tests WHERE id = ?', attempt.test_id);
  enqueue('attempt.submitted', s, t, resultPayload(s, t, 'attempt.submitted'));
}

function publishResults(t) {
  const now = new Date().toISOString();
  run('UPDATE tests SET results_published_at = ? WHERE id = ?', now, t.id);
  const t2 = get('SELECT * FROM tests WHERE id = ?', t.id);
  const rows = all('SELECT * FROM students WHERE test_id = ? AND crm_id IS NOT NULL AND revoked = 0', t.id);
  rows.forEach((s) => enqueue('result.published', s, t2, resultPayload(s, t2)));
  return rows.length;
}

const BACKOFF_MIN = [1, 2, 5, 10, 30, 60, 120, 240, 480];
let delivering = false;
async function deliver(row, c) {
  const body = row.payload;
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(c.webhook, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'User-Agent': 'KL-Exam-Portal/1.0', 'X-KL-Event': row.event,
      'X-KL-Delivery': String(row.id), 'X-KL-Timestamp': String(ts), 'X-KL-Signature': sign(c.secret, ts, body),
    },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function flushOutbox() {
  if (delivering) return;
  const c = partnerConfig();
  if (!c.webhook || !c.secret) return;
  delivering = true;
  try {
    const rows = all('SELECT * FROM crm_outbox WHERE sent_at IS NULL AND failed = 0 AND next_at <= ? ORDER BY id LIMIT 100', new Date().toISOString());
    for (const r of rows) {
      try {
        await deliver(r, c);
        run('UPDATE crm_outbox SET sent_at = ?, tries = tries + 1, last_error = NULL WHERE id = ?', new Date().toISOString(), r.id);
      } catch (e) {
        const tries = r.tries + 1;
        const expired = Date.now() - Date.parse(r.created_at) > 24 * 3600000;
        const next = new Date(Date.now() + BACKOFF_MIN[Math.min(tries - 1, BACKOFF_MIN.length - 1)] * 60000).toISOString();
        run('UPDATE crm_outbox SET tries = ?, next_at = ?, failed = ?, last_error = ? WHERE id = ?', tries, next, expired ? 1 : 0, String(e.message).slice(0, 300), r.id);
      }
    }
  } finally { delivering = false; }
}

async function testWebhook() {
  const c = partnerConfig();
  if (!c.webhook) throw new HttpError(400, 'Set the webhook URL first');
  const payload = JSON.stringify({ event: 'ping', sent_at: new Date().toISOString() });
  await deliver({ id: 0, event: 'ping', payload }, c);
}

function startWorker() {
  const timer = setInterval(() => {
    flushOutbox().catch((e) => console.error('crm outbox:', e.message));
    // Housekeeping: request log and idempotency records are kept 30 days / 24 hours.
    run('DELETE FROM crm_log WHERE at < ?', new Date(Date.now() - 30 * 86400000).toISOString());
    run('DELETE FROM crm_idempotency WHERE at < ?', new Date(Date.now() - 86400000).toISOString());
  }, 15000);
  timer.unref();
}

module.exports = {
  PartnerError, pfail, partnerAuth, partnerConfig, rotateCredentials, setSetting, setting, sign,
  str, date, email, phone, NAME_RE, readPhoto, savePhoto, photoPath, faceMatch, FACE_TRIES,
  otpHash, maskEmail, maskPhone, OTP_TTL_MS, OTP_RESEND_MS, OTP_MAX_TRIES, OTP_LOCK_MS,
  examView, examStatus, registrationOpen, candidateView, resultPayload, onSubmitted, publishResults,
  flushOutbox, testWebhook, startWorker, baseUrl,
};
