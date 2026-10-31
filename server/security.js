// Auth tokens, encryption helpers, CSRF guard and input validation.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { get } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const APP_SECRET = process.env.APP_SECRET;
const IS_PROD = process.env.NODE_ENV === 'production';
const SECURE_COOKIES = process.env.SECURE_COOKIES === 'true' || IS_PROD;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// ---------- AES-256-GCM for secrets that admins must be able to read back ----------
const ENC_KEY = crypto.createHash('sha256').update(String(APP_SECRET)).digest();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob) {
  if (!blob) return null;
  const [iv, tag, data] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// Unambiguous characters only, so the pass key is easy to read aloud in an exam hall.
function generatePasskey(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

// ---------- cookies / JWT ----------
const cookieOpts = (maxAgeMs) => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: SECURE_COOKIES,
  path: '/',
  maxAge: maxAgeMs,
});

function sign(payload, expiresInSec) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: expiresInSec, algorithm: 'HS256' });
}
function verify(token) {
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const p = verify(req.cookies?.kl_admin);
  if (!p || p.role !== 'admin') return res.status(401).json({ error: 'Admin login required' });
  const admin = get('SELECT id, username, token_version FROM admins WHERE id = ?', p.sub);
  if (!admin || admin.token_version !== p.tv) return res.status(401).json({ error: 'Session expired' });
  req.admin = admin;
  next();
}

// Registered (but not yet unlocked) student.
function requireRegistered(req, res, next) {
  const p = verify(req.cookies?.kl_reg);
  if (!p || p.role !== 'reg') return res.status(401).json({ error: 'Please register first' });
  req.reg = p;
  next();
}

// Student who has entered the correct pass key. Only the most recent session is valid,
// so the same candidate cannot sit the exam from two devices at once.
function requireStudent(req, res, next) {
  const p = verify(req.cookies?.kl_stu);
  if (!p || p.role !== 'student') return res.status(401).json({ error: 'Exam session not found. Please log in again.' });
  const s = get('SELECT * FROM students WHERE id = ?', p.sid);
  if (!s || s.session_id !== p.sess) {
    return res.status(401).json({ error: 'This exam session was opened on another device or browser.' });
  }
  req.student = s;
  next();
}

// CSRF: state-changing API calls must carry a custom header (forces CORS preflight,
// which we never grant) and, when the browser sends Origin, it must be our own host.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-KL-Req') !== '1') return res.status(403).json({ error: 'Blocked request' });
  const origin = req.get('Origin');
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.get('Host')) return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
}

// ---------- validation ----------
const str = (v, name, { min = 1, max = 500, required = true } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) fail(400, `${name} is required`);
    return '';
  }
  if (typeof v !== 'string') fail(400, `${name} must be text`);
  const s = v.trim();
  if (required && s.length < min) fail(400, `${name} is too short`);
  if (s.length > max) fail(400, `${name} is too long (max ${max} characters)`);
  return s;
};
const int = (v, name, { min = 0, max = 1e9 } = {}) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${name} must be a whole number between ${min} and ${max}`);
  return n;
};
const num = (v, name, { min = -1e6, max = 1e6 } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(400, `${name} must be a number between ${min} and ${max}`);
  return n;
};
const email = (v) => {
  const s = str(v, 'Email', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) fail(400, 'Enter a valid email address');
  return s;
};
const mobile = (v, name) => {
  const s = str(v, name, { max: 20 }).replace(/[\s-]/g, '');
  if (!/^(\+91)?[6-9]\d{9}$/.test(s)) fail(400, `${name} must be a valid 10-digit Indian mobile number`);
  return s.slice(-10);
};
const isoDate = (v, name) => {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) fail(400, `${name} is not a valid date/time`);
  return d.toISOString();
};

module.exports = {
  HttpError, fail, encrypt, decrypt, generatePasskey, cookieOpts, sign, verify,
  requireAdmin, requireRegistered, requireStudent, csrfGuard,
  v: { str, int, num, email, mobile, isoDate },
};
