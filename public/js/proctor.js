// AI video proctoring in the candidate's browser (online-from-home exams only).
//
// Runs on the candidate's own device, so it costs nothing per second:
//  - face detector (MediaPipe, every second): no face, more than one face, head turned away for a long time
//  - object detector (every 3 s): mobile phone, another screen/laptop, book in view
//  - microphone: sustained talking -> a 10-second recording is kept as evidence
//  - second display connected, camera/microphone switched off, camera covered or dark
// Once a minute (and at once when something above happens) one small JPEG goes to the server, where Gemini
// 3.1 Flash-Lite checks it. Findings are recorded for the examiner; the candidate sees a warning. The exam itself
// is never closed by the proctor.
// KL comes from common.js.
const { api, el, $ } = window.KL;

const PERIOD_MS = 60000;      // routine AI check
const FACE_MS = 1000;         // face detector
const OBJECT_MS = 3000;       // phone / device / book detector
const NO_FACE_S = 6;          // seconds without a face before it is reported
const MULTI_FACE_S = 2;       // seconds with two or more faces
const TURNED_S = 5;           // seconds with the head turned away
const YAW_LIMIT = 0.55;       // nose offset from the eye midpoint, in eye distances (0 = facing the screen)
const SPEECH_FRAMES = 15;     // 100 ms frames of voice within 3 s that count as talking (1.5 s)
const COOLDOWN_MS = 20000;    // the same finding is reported at most this often

const P = {
  stream: null, video: null, faceDet: null, objDet: null, detectorsReady: false,
  timers: [], running: false, cooldown: {}, since: {}, objHits: {},
  audio: null, voice: [], recording: false, extended: false, onBlocked: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => api(path, { method: 'POST', body });

// ---------------- camera & detectors ----------------
async function openCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot use the camera. Use the latest Chrome, Edge or Safari.');
  P.stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
  });
  P.video.srcObject = P.stream;
  P.video.muted = true;
  P.video.playsInline = true;
  await P.video.play().catch(() => {});
  for (let i = 0; i < 50 && P.video.readyState < 2; i++) await sleep(100);
}

async function loadDetectors() {
  try {
    const vision = await import('/vendor/mediapipe/vision_bundle.mjs');
    const files = await vision.FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
    P.faceDet = await vision.FaceDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: '/models/blaze_face_short_range.tflite' }, runningMode: 'VIDEO', minDetectionConfidence: 0.5,
    });
    P.detectorsReady = true;
    // The object model is larger (4.6 MB); the exam can start while it loads.
    vision.ObjectDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: '/models/efficientdet_lite0.tflite' }, runningMode: 'VIDEO',
      scoreThreshold: 0.45, maxResults: 5, categoryAllowlist: ['cell phone', 'laptop', 'tv', 'book'],
    }).then((d) => { P.objDet = d; }).catch((e) => console.warn('object detector unavailable', e));
  } catch (e) {
    // Old browsers: the AI frame check every minute still runs.
    console.warn('face detector unavailable', e);
  }
}

let lastTs = 0;
const ts = () => { lastTs = Math.max(lastTs + 1, performance.now()); return lastTs; };

function faces() {
  if (!P.faceDet || P.video.readyState < 2) return null;
  return P.faceDet.detectForVideo(P.video, ts()).detections;
}

// Head turned sideways: the nose tip moves away from the middle of the eyes.
function yaw(det) {
  const k = det.keypoints || [];
  if (k.length < 3) return 0;
  const [re, le, nose] = k;
  const dist = Math.abs(le.x - re.x) || 1e-3;
  return (nose.x - (re.x + le.x) / 2) / dist;
}

function frameJpeg(maxW = 640, quality = 0.7) {
  const v = P.video;
  if (!v || v.readyState < 2 || !v.videoWidth) return Promise.resolve(null);
  const scale = Math.min(1, maxW / v.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob((b) => {
    if (!b) return resolve(null);
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.readAsDataURL(b);
  }, 'image/jpeg', quality));
}

// Average brightness of a tiny copy of the frame: a covered camera or a dark room is close to 0.
function brightness() {
  const v = P.video;
  if (!v || v.readyState < 2) return 255;
  const c = document.createElement('canvas');
  c.width = 32; c.height = 24;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(v, 0, 0, 32, 24);
  const d = g.getImageData(0, 0, 32, 24).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return s / (d.length / 4);
}

// ---------------- reporting ----------------
const MESSAGES = {
  no_face: 'Your face is not visible. Stay in front of the camera.',
  multiple_faces: 'More than one person is in front of the camera.',
  face_turned: 'Look at your screen. Turning away for a long time is recorded.',
  phone_seen: 'A mobile phone is visible. Keep phones away during the exam.',
  device_seen: 'Another screen or laptop is visible.',
  book_seen: 'A book or notes are visible. Remove them.',
  speech: 'Talking was detected. The exam must be written alone and in silence.',
  second_screen: 'A second display is connected. Disconnect it.',
  camera_dark: 'Your camera is covered or the room is too dark.',
};

function warn(text) {
  const b = $('#procAlert');
  if (!b) return;
  b.textContent = `⚠ ${text} This has been recorded for the examiner.`;
  b.classList.remove('hidden');
  clearTimeout(warn.t);
  warn.t = setTimeout(() => b.classList.add('hidden'), 8000);
}

function cooled(kind) {
  const now = Date.now();
  if (now - (P.cooldown[kind] || 0) < COOLDOWN_MS) return false;
  P.cooldown[kind] = now;
  return true;
}

async function sendFrame(reason) {
  const image = await frameJpeg();
  if (!image) return;
  try {
    const r = await post('/api/student/proctor/frame', { image, reason });
    if (r.alerts && r.alerts.length) warn(`${r.alerts[0]}.`);
  } catch (e) {
    if (e.status === 410) stop();
  }
}

// A browser finding: warn the candidate and send the current frame as evidence for the AI to check.
function finding(kind, withFrame = true) {
  if (!P.running || !cooled(kind)) return;
  if (MESSAGES[kind]) warn(MESSAGES[kind]);
  if (withFrame) sendFrame(kind);
  else post('/api/student/proctor/event', { kind }).catch(() => {});
}

// Fires `kind` once the condition has held for `seconds`.
function sustained(kind, on, seconds) {
  if (!on) { delete P.since[kind]; return; }
  P.since[kind] = P.since[kind] || Date.now();
  if (Date.now() - P.since[kind] >= seconds * 1000) { delete P.since[kind]; finding(kind); }
}

// ---------------- watchers ----------------
function watchFaces() {
  let dets;
  try { dets = faces(); } catch { return; }
  if (!dets) return;
  sustained('no_face', dets.length === 0, NO_FACE_S);
  sustained('multiple_faces', dets.length > 1, MULTI_FACE_S);
  sustained('face_turned', dets.length === 1 && Math.abs(yaw(dets[0])) > YAW_LIMIT, TURNED_S);
  $('#procDot')?.classList.toggle('bad', dets.length !== 1);
}

function watchObjects() {
  if (!P.objDet || P.video.readyState < 2) return;
  let res;
  try { res = P.objDet.detectForVideo(P.video, ts()).detections; } catch { return; }
  const seen = new Set(res.map((d) => d.categories[0]?.categoryName));
  const map = { 'cell phone': 'phone_seen', laptop: 'device_seen', tv: 'device_seen', book: 'book_seen' };
  for (const [cat, kind] of Object.entries(map)) {
    // Two detections in a row (3 s apart) before reporting, to skip one-frame mistakes.
    P.objHits[cat] = seen.has(cat) ? (P.objHits[cat] || 0) + 1 : 0;
    if (P.objHits[cat] >= 2) { P.objHits[cat] = 0; finding(kind); }
  }
}

function watchDark() {
  sustained('camera_dark', brightness() < 25, 5);
}

function watchScreens() {
  const ext = !!(window.screen && window.screen.isExtended);
  if (ext && !P.extended) finding('second_screen', false);
  P.extended = ext;
}

function startAudio() {
  const track = P.stream.getAudioTracks()[0];
  if (!track) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let floor = 0.01;
    P.audio = ctx;
    P.timers.push(setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const rms = Math.sqrt(s / buf.length);
      // The noise floor follows quiet moments quickly and loud ones slowly.
      floor = rms < floor ? floor * 0.9 + rms * 0.1 : floor * 0.999 + rms * 0.001;
      P.voice.push(rms > Math.max(0.02, floor * 3.5) ? 1 : 0);
      if (P.voice.length > 30) P.voice.shift();
      if (P.voice.reduce((a, b) => a + b, 0) >= SPEECH_FRAMES && !P.recording && cooled('speech')) {
        P.voice = [];
        warn(MESSAGES.speech);
        recordClip(track);
      }
    }, 100));
  } catch (e) { console.warn('audio check unavailable', e); }
}

// Keeps 10 seconds of sound as evidence (opus, about 20 KB).
function recordClip(track) {
  if (!window.MediaRecorder) return;
  P.recording = true;
  const chunks = [];
  let rec;
  try {
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    rec = new MediaRecorder(new MediaStream([track]), type ? { mimeType: type, audioBitsPerSecond: 24000 } : undefined);
  } catch { P.recording = false; return; }
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    P.recording = false;
    const r = new FileReader();
    r.onload = () => post('/api/student/proctor/audio', { audio: String(r.result).split(',')[1] }).catch(() => {});
    r.readAsDataURL(new Blob(chunks, { type: rec.mimeType }));
  };
  rec.start();
  setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, 10000);
}

// Camera or microphone switched off, unplugged or taken by another app: block the exam until it is back.
function watchTracks() {
  P.stream.getTracks().forEach((t) => {
    t.addEventListener('ended', () => {
      if (!P.running) return;
      post('/api/student/proctor/event', { kind: t.kind === 'video' ? 'camera_off' : 'mic_off' }).catch(() => {});
      blocked(t.kind === 'video' ? 'Your camera was turned off.' : 'Your microphone was turned off.');
    });
  });
}

function blocked(msg) {
  const o = $('#camOverlay');
  if (!o) return;
  $('#camMsg').textContent = `${msg} This has been recorded. Turn it back on to continue your exam.`;
  o.classList.remove('hidden');
}

async function reconnect() {
  try {
    P.stream.getTracks().forEach((t) => t.stop());
    await openCamera();
    watchTracks();
    if (P.audio) { P.audio.close().catch(() => {}); P.timers.forEach(clearInterval); P.timers = []; startLoops(); }
    $('#camOverlay').classList.add('hidden');
  } catch {
    $('#camMsg').textContent = 'Camera or microphone still not available. Allow access in the browser (lock icon in the address bar) and try again.';
  }
}

function startLoops() {
  P.timers.push(setInterval(watchFaces, FACE_MS));
  P.timers.push(setInterval(watchObjects, OBJECT_MS));
  P.timers.push(setInterval(watchDark, 2500));
  P.timers.push(setInterval(watchScreens, 5000));
  P.timers.push(setInterval(() => sendFrame('periodic'), PERIOD_MS));
  startAudio();
}

// ---------------- public API (used by exam.js) ----------------
// Before the exam: camera + microphone permission, detectors, and the checks the candidate must pass.
async function prepare(videoEl, report) {
  P.video = videoEl;
  if (P.stream) P.stream.getTracks().forEach((t) => t.stop());
  const res = { camera: false, mic: false, face: false, screen: !(window.screen && window.screen.isExtended), error: '' };
  try {
    await openCamera();
    res.camera = P.stream.getVideoTracks().some((t) => t.readyState === 'live');
    res.mic = P.stream.getAudioTracks().some((t) => t.readyState === 'live');
  } catch (e) {
    res.error = e && e.name === 'NotAllowedError'
      ? 'Camera and microphone permission was denied. Allow both (lock icon in the address bar), then reload this page.'
      : e && e.name === 'NotFoundError' ? 'No camera or microphone was found on this device.' : (e.message || 'Could not open the camera.');
    report(res);
    return res;
  }
  report(res);
  if (!P.detectorsReady) await loadDetectors();
  if (!P.detectorsReady) {
    res.face = true; // cannot check here; the AI frame check still runs during the exam
    report(res);
    return res;
  }
  // Wait (up to 30 s) until exactly one face is seen.
  for (let i = 0; i < 60 && !res.face; i++) {
    const d = faces();
    res.face = !!d && d.length === 1;
    res.faces = d ? d.length : null;
    report(res);
    if (!res.face) await sleep(500);
  }
  return res;
}

// ---------------- live stream to the examiners' monitor (7 frames/s) ----------------
// 320x240 JPEG normally (about 8-12 KB a frame, ~0.6 Mbit/s); 640x480 while an examiner has this candidate enlarged.
// A frame is skipped when the connection has not sent the previous ones yet, so a slow network never piles up.
const LIVE = { ws: null, q: 'sd', retry: 0, info: null, canvas: null, sent: 0, skipped: 0, timers: [] };
const LIVE_FPS = 7;

function liveConnect() {
  if (!P.running) return;
  let ws;
  try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live/ws/student`); } catch { return; }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    LIVE.retry = 0;
    const i = LIVE.info || {};
    ws.send(JSON.stringify({ type: 'hello', name: i.student?.full_name, testId: i.test?.id, testName: i.test ? `${i.test.exam_code} · ${i.test.name}` : '',
      mem: navigator.deviceMemory, cores: navigator.hardwareConcurrency, screen: `${screen.width}x${screen.height}`,
      mobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent), ua: navigator.userAgent }));
  };
  ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === 'quality') LIVE.q = m.q; } catch { /* binary or bad */ } };
  ws.onclose = () => {
    if (LIVE.ws === ws) LIVE.ws = null;
    if (P.running) setTimeout(liveConnect, Math.min(30000, 2000 * 2 ** LIVE.retry++));
  };
  ws.onerror = () => {};
  LIVE.ws = ws;
}

function liveFrame() {
  const ws = LIVE.ws;
  const v = P.video;
  if (!ws || ws.readyState !== 1 || !v || v.readyState < 2) return;
  if (ws.bufferedAmount > 48000) { LIVE.skipped++; return; }
  const [w, h] = LIVE.q === 'hd' ? [640, 480] : [320, 240];
  const c = LIVE.canvas || (LIVE.canvas = document.createElement('canvas'));
  if (c.width !== w) { c.width = w; c.height = h; }
  c.getContext('2d').drawImage(v, 0, 0, w, h);
  c.toBlob((b) => { if (b && ws.readyState === 1) { ws.send(b); LIVE.sent++; } }, 'image/jpeg', LIVE.q === 'hd' ? 0.7 : 0.6);
}

function liveStats() {
  const ws = LIVE.ws;
  if (!ws || ws.readyState !== 1) return;
  const m = performance.memory;
  const n = navigator.connection || {};
  ws.send(JSON.stringify({ type: 'stats', heapMB: m ? Math.round(m.usedJSHeapSize / 1048576) : null, heapLimitMB: m ? Math.round(m.jsHeapSizeLimit / 1048576) : null,
    net: n.effectiveType, downlink: n.downlink, rtt: n.rtt, sentFps: Math.round((LIVE.sent / 5) * 10) / 10, skipped: LIVE.skipped }));
  LIVE.sent = 0;
}

function liveStart(info) {
  LIVE.info = info;
  liveConnect();
  LIVE.timers.push(setInterval(liveFrame, 1000 / LIVE_FPS), setInterval(liveStats, 5000));
}

async function begin(info) {
  if (P.running || !P.stream) return;
  P.running = true;
  liveStart(info);
  P.extended = !!(window.screen && window.screen.isExtended);
  const pip = $('#procPip');
  if (pip) { pip.appendChild(P.video); pip.classList.remove('hidden'); }
  $('#camRetry')?.addEventListener('click', reconnect);
  watchTracks();
  startLoops();
  sendFrame('reference');
  setTimeout(() => sendFrame('periodic'), 5000);
}

function stop() {
  P.running = false;
  LIVE.timers.forEach(clearInterval);
  LIVE.timers = [];
  if (LIVE.ws) LIVE.ws.close();
  P.timers.forEach(clearInterval);
  P.timers = [];
  if (P.audio) P.audio.close().catch(() => {});
  if (P.stream) P.stream.getTracks().forEach((t) => t.stop());
  $('#procPip')?.classList.add('hidden');
}

window.KLProctor = { prepare, begin, stop, el };
window.dispatchEvent(new Event('klproctor-ready'));
