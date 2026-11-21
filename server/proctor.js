// AI video proctoring for exams written online from home (tests.proctor_mode = 'ai').
//
// The candidate's browser watches the camera and microphone continuously (face count, head turned away, phone in
// view, speech, second screen) at no cost. Once a minute, and at once when the browser notices something, it sends one
// small camera frame here; Gemini 3.1 Flash-Lite looks at it and answers with a few yes/no codes. Anything suspicious
// is kept as evidence (JPEG/audio under DATA_DIR/proctor) and shown in the admin report. Nothing closes the exam
// automatically: the examiner decides from the report.
const fs = require('fs');
const path = require('path');
const { get, run } = require('./db');
const { getConfig } = require('./gemini');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ROOT = path.join(DATA_DIR, 'proctor');
const MODEL = process.env.PROCTOR_MODEL || 'gemini-3.1-flash-lite';
// USD per million tokens (Gemini 3.1 Flash-Lite list price); thinking tokens are billed as output.
const PRICE_IN = Number(process.env.PROCTOR_PRICE_IN) || 0.25;
const PRICE_OUT = Number(process.env.PROCTOR_PRICE_OUT) || 1.5;
// Rupees per US dollar for reports: Admin → Settings, else USD_INR, else the rate on 20 Nov 2026.
const usdInr = () => {
  const row = get("SELECT value FROM settings WHERE key = 'usd_inr'");
  return Number(row && row.value) || Number(process.env.USD_INR) || 93.32;
};
// At most this many Gemini calls at once; a routine check is skipped (not queued) when the server is that busy.
const MAX_IN_FLIGHT = Number(process.env.PROCTOR_MAX_IN_FLIGHT) || 64;

// What each finding means for the report. Browser findings come from the candidate's device, AI findings from Gemini.
const KINDS = {
  // browser
  no_face: [2, 'No face in front of the camera'],
  multiple_faces: [3, 'More than one face in front of the camera'],
  face_turned: [2, 'Face turned away from the screen for a long time'],
  phone_seen: [3, 'Mobile phone seen by the camera'],
  device_seen: [3, 'Another screen or laptop seen by the camera'],
  book_seen: [2, 'Book or notes seen by the camera'],
  speech: [2, 'Talking or voices heard'],
  second_screen: [3, 'A second display is connected'],
  camera_off: [3, 'Camera was turned off or blocked'],
  mic_off: [2, 'Microphone was turned off'],
  camera_dark: [2, 'Camera covered or the room is too dark'],
  talking: [2, 'Lips moving — candidate talking'],
  eyes_away: [2, 'Eyes looking away from the screen'],
  // AI
  ai_person: [3, 'AI: another person is present'],
  ai_no_face: [2, 'AI: candidate not visible'],
  ai_phone: [3, 'AI: mobile phone visible'],
  ai_device: [3, 'AI: another screen, laptop or tablet visible'],
  ai_earphones: [2, 'AI: earphones or headset worn'],
  ai_material: [2, 'AI: book, notes or paper visible'],
  ai_away: [1, 'AI: looking away from the screen'],
  ai_neighbour: [3, 'AI: someone right beside the candidate'],
  ai_talking: [2, 'AI: candidate talking to someone'],
  // information
  reference: [0, 'Reference photo at the start of the exam'],
  snapshot: [0, 'Routine photo'],
};
const BROWSER_KINDS = Object.keys(KINDS).filter((k) => !k.startsWith('ai_') && k !== 'reference');

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    persons: { type: 'INTEGER' },
    face: { type: 'BOOLEAN' },
    away: { type: 'BOOLEAN' },
    phone: { type: 'BOOLEAN' },
    device: { type: 'BOOLEAN' },
    earphones: { type: 'BOOLEAN' },
    material: { type: 'BOOLEAN' },
  },
  required: ['persons', 'face', 'away', 'phone', 'device', 'earphones', 'material'],
};
// Kept short on purpose: every token here is paid for once a minute per candidate.
const PROMPT = 'Webcam frame of a student taking an online exam alone at home. Answer strictly: persons = number of people '
  + 'visible; face = student\'s face clearly visible; away = student looking away from the screen (sideways, back, or down '
  + 'at something other than the keyboard); phone = mobile phone visible anywhere; device = another monitor, laptop or tablet '
  + 'visible; earphones = earphones/headset/earbuds worn; material = book, notes or written paper visible.';

// Lab sessions: the background is full of students, staff and monitors; only the candidate matters.
const LAB_SCHEMA = {
  type: 'OBJECT',
  properties: {
    face: { type: 'BOOLEAN' }, near: { type: 'INTEGER' }, phone: { type: 'BOOLEAN' }, earphones: { type: 'BOOLEAN' },
    material: { type: 'BOOLEAN' }, away: { type: 'BOOLEAN' }, talking: { type: 'BOOLEAN' },
  },
  required: ['face', 'near', 'phone', 'earphones', 'material', 'away', 'talking'],
};
const LAB_PROMPT = 'Webcam frame of a student writing an exam in a university computer lab. Other students at their own desks, '
  + 'staff walking or standing, and computer monitors in the background are NORMAL - ignore them completely. Judge only the student '
  + 'closest to the camera: face = that student\'s face is clearly visible; near = number of OTHER people within arm\'s reach of the '
  + 'student (beside them or leaning in), 0 if none; phone = the student is holding or using a mobile phone (ignore phones held by '
  + 'other people); earphones = the student wears earphones/headset/earbuds; material = book, notes or written paper on the student\'s '
  + 'desk or in hand; away = the student is looking at a neighbour\'s screen or turned towards another person; talking = the student is '
  + 'talking to someone.';

let inFlight = 0;
// Routine photos: one kept every 5 minutes per attempt, so the examiner can see the whole exam, not only incidents.
const SNAPSHOT_MS = 5 * 60000;
const lastSnapshot = new Map(); // attempt id -> time (ms)
// Last Gemini failure (e.g. credits used up), shown to the admin; logged at most once a minute.
const health = { lastError: null, lastErrorAt: 0, lastOkAt: 0, loggedAt: 0 };

function cost(tokIn, tokOut) {
  return (tokIn * PRICE_IN + tokOut * PRICE_OUT) / 1e6;
}

// Saves an evidence file and returns its path relative to ROOT.
function saveFile(attempt, kind, ext, buf) {
  const rel = path.join(String(attempt.test_id), String(attempt.id), `${Date.now()}-${kind}.${ext}`);
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return rel.split(path.sep).join('/');
}

function fileFor(rel) {
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(path.resolve(ROOT) + path.sep)) return null;
  return fs.existsSync(abs) ? abs : null;
}

function addEvent(attempt, source, kind, detail = '', file = null) {
  const sev = (KINDS[kind] || [1])[0];
  run('INSERT INTO proctor_events (attempt_id, at, source, kind, severity, detail, file) VALUES (?, ?, ?, ?, ?, ?, ?)',
    attempt.id, new Date().toISOString(), source, kind, sev, String(detail).slice(0, 300), file);
  if (sev > 0) run('UPDATE attempts SET proctor_flags = proctor_flags + 1, proctor_high = proctor_high + ? WHERE id = ?', sev === 3 ? 1 : 0, attempt.id);
}

async function askGemini(jpeg, lab = false) {
  const { key } = getConfig();
  if (!key) throw new Error('Gemini API key is not configured');
  const body = {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }, { text: lab ? LAB_PROMPT : PROMPT }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 120,
      responseMimeType: 'application/json',
      responseSchema: lab ? LAB_SCHEMA : SCHEMA,
      mediaResolution: 'MEDIA_RESOLUTION_LOW',
      thinkingConfig: { thinkingLevel: 'minimal' },
    },
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
  const u = j.usageMetadata || {};
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return {
    verdict: JSON.parse(text),
    tokIn: u.promptTokenCount || 0,
    tokOut: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
  };
}

// Maps Gemini's answer to report findings.
function findings(v, lab = false) {
  const f = [];
  if (lab) {
    if (!v.face) f.push('ai_no_face');
    if (v.near > 0) f.push('ai_neighbour');
    if (v.phone) f.push('ai_phone');
    if (v.earphones) f.push('ai_earphones');
    if (v.material) f.push('ai_material');
    if (v.talking) f.push('ai_talking');
    if (v.away && v.face) f.push('ai_away');
    return f;
  }
  if (v.persons > 1) f.push('ai_person');
  if (!v.face || v.persons === 0) f.push('ai_no_face');
  if (v.phone) f.push('ai_phone');
  if (v.device) f.push('ai_device');
  if (v.earphones) f.push('ai_earphones');
  if (v.material) f.push('ai_material');
  if (v.away && v.face) f.push('ai_away');
  return f;
}

// One camera frame from the candidate. reason: 'periodic' (once a minute), a browser finding (sent at once), or
// 'reference' (start of the exam, kept for identity checks, not analysed). mode: 'ai' asks Gemini about the frame;
// 'browser' (no API key needed) relies on the browser's own detection and only keeps the evidence.
async function checkFrame(attempt, jpeg, reason, mode = 'ai', lab = false) {
  if (reason === 'reference') {
    addEvent(attempt, 'system', 'reference', '', saveFile(attempt, 'reference', 'jpg', jpeg));
    return { alerts: [] };
  }
  const trigger = BROWSER_KINDS.includes(reason) ? reason : null;
  // The browser already decided this moment is suspicious: keep the frame as evidence whatever Gemini says.
  const triggerFile = trigger ? saveFile(attempt, trigger, 'jpg', jpeg) : null;
  if (trigger) addEvent(attempt, 'browser', trigger, '', triggerFile);
  if (reason === 'periodic' && Date.now() - (lastSnapshot.get(attempt.id) || 0) >= SNAPSHOT_MS) {
    lastSnapshot.set(attempt.id, Date.now());
    if (lastSnapshot.size > 50000) lastSnapshot.clear();
    addEvent(attempt, 'system', 'snapshot', '', saveFile(attempt, 'snapshot', 'jpg', jpeg));
  }
  if (mode !== 'ai') return { alerts: [] };

  if (inFlight >= MAX_IN_FLIGHT && !trigger) return { alerts: [], skipped: true };
  inFlight++;
  let r;
  try {
    r = await askGemini(jpeg, lab);
  } catch (e) {
    health.lastError = e.message;
    health.lastErrorAt = Date.now();
    if (Date.now() - health.loggedAt > 60000) { health.loggedAt = Date.now(); console.error(`proctor: Gemini check failed: ${e.message}`); }
    return { alerts: [], ai: false };
  } finally {
    inFlight--;
  }
  health.lastOkAt = Date.now();
  const c = cost(r.tokIn, r.tokOut);
  run('UPDATE attempts SET ai_calls = ai_calls + 1, ai_tokens_in = ai_tokens_in + ?, ai_tokens_out = ai_tokens_out + ?, ai_cost_usd = ai_cost_usd + ? WHERE id = ?',
    r.tokIn, r.tokOut, c, attempt.id);
  const who = get('SELECT full_name FROM students WHERE id = ?', attempt.student_id);
  run(`INSERT INTO ai_usage (at, test_id, attempt_id, student_id, student_name, model, reason, tokens_in, tokens_out, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, new Date().toISOString(), attempt.test_id, attempt.id, attempt.student_id,
  who ? who.full_name : '', MODEL, trigger || reason, r.tokIn, r.tokOut, c);
  const found = findings(r.verdict, lab);
  if (found.length) {
    const file = triggerFile || saveFile(attempt, found[0], 'jpg', jpeg);
    const detail = `${lab ? `lab · near ${r.verdict.near}` : `persons ${r.verdict.persons}`}${trigger ? ` · checked after: ${KINDS[trigger][1]}` : ''}`;
    found.forEach((k) => addEvent(attempt, 'ai', k, detail, file));
  }
  // Looking away once is common (thinking, reading the question); only stronger findings warn the candidate.
  const alerts = found.filter((k) => KINDS[k][0] >= 2).map((k) => KINDS[k][1].replace(/^AI: /, ''));
  return { alerts };
}

function saveAudio(attempt, buf) {
  // Safari records MP4 (bytes 4-7 = 'ftyp'), other browsers WebM.
  const ext = buf.slice(4, 8).toString('latin1') === 'ftyp' ? 'm4a' : 'webm';
  addEvent(attempt, 'browser', 'speech', '10-second recording', saveFile(attempt, 'speech', ext, buf));
}

// Risk for the report: High = a serious finding confirmed by Gemini or several serious browser findings.
function risk(a) {
  const aiHigh = get("SELECT COUNT(*) c FROM proctor_events WHERE attempt_id = ? AND source = 'ai' AND severity = 3", a.id).c;
  if (aiHigh >= 1 || a.proctor_high >= 3) return 'high';
  if (a.proctor_flags >= 4) return 'medium';
  return 'low';
}

// For the admin: is Gemini answering? 'failing' when the latest call failed in the last 10 minutes.
function status() {
  const failing = health.lastErrorAt > health.lastOkAt && Date.now() - health.lastErrorAt < 600000;
  return { failing, error: failing ? health.lastError : null, last_ok_at: health.lastOkAt ? new Date(health.lastOkAt).toISOString() : null };
}

module.exports = { status, KINDS, BROWSER_KINDS, MODEL, usdInr, checkFrame, saveAudio, addEvent, fileFor, risk, cost, askGemini, findings };
