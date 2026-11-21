// KL live proctoring monitor: a separate web app (own pod) so video traffic never slows the exam server.
//
//  - Candidates in an online-proctored exam stream small JPEG frames (320x240, 7 per second; 640x480 while an
//    examiner has them enlarged) over a WebSocket to /live/ws/student. Nothing is stored: only the latest frame
//    per candidate is kept in memory.
//  - Examiners (admin login of the exam portal) open /live/, a wall of live tiles fed over /live/ws/monitor.
//  - /live/api/cluster reports CPU and memory of the servers and pods (Kubernetes metrics API) and this service's
//    own traffic, so bandwidth per candidate and in total is measured, not guessed.
// Authentication reuses the exam portal's signed cookies (same JWT_SECRET): kl_stu for candidates, kl_admin for
// examiners.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.LIVE_PORT) || 8090;
const SECRET = process.env.JWT_SECRET;
const NAMESPACE = process.env.POD_NAMESPACE || '';
const PUBLIC = path.join(__dirname, 'public');
const MAX_FRAME = 250000;          // bytes; a 640x480 JPEG is ~25-45 KB
const MONITOR_BACKLOG = 4 << 20;   // skip frames to an examiner whose connection is this far behind
if (!SECRET || SECRET.length < 32) { console.error('JWT_SECRET is required'); process.exit(1); }

// ---------------- auth ----------------
function cookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function who(req, name, role) {
  try {
    const p = jwt.verify(cookies(req.headers.cookie)[name], SECRET, { algorithms: ['HS256'] });
    return p && p.role === role ? p : null;
  } catch { return null; }
}

// ---------------- state ----------------
const started = Date.now();
const students = new Map(); // sid -> candidate
const monitors = new Set();
const totals = { inBytes: 0, outBytes: 0, frames: 0 };
// Per-second history of the last 10 s, for live rates.
const rate = () => ({ buckets: new Array(10).fill(0).map(() => ({ s: 0, bytes: 0, frames: 0 })) });
const bump = (r, bytes) => {
  const s = Math.floor(Date.now() / 1000);
  const b = r.buckets[s % 10];
  if (b.s !== s) { b.s = s; b.bytes = 0; b.frames = 0; }
  b.bytes += bytes; b.frames += 1;
};
const perSec = (r) => {
  const now = Math.floor(Date.now() / 1000);
  let bytes = 0; let frames = 0;
  r.buckets.forEach((b) => { if (b.s > now - 10 && b.s < now) { bytes += b.bytes; frames += b.frames; } });
  return { bps: bytes / 9, fps: frames / 9 };
};
const totalIn = rate();
const totalOut = rate();

function candidate(sid) {
  let c = students.get(sid);
  if (!c) {
    c = { sid, name: '', testId: null, testName: '', ws: null, frame: null, frameAt: 0, frames: 0, bytes: 0,
      since: Date.now(), lastSeen: Date.now(), q: 'sd', rate: rate(), device: {}, stats: {}, sessions: 0 };
    students.set(sid, c);
  }
  return c;
}
// Forget candidates who left more than 6 hours ago.
setInterval(() => {
  const old = Date.now() - 6 * 3600e3;
  for (const [sid, c] of students) if (!c.ws && c.lastSeen < old) students.delete(sid);
}, 600000).unref();

function setQuality(c) {
  const want = [...monitors].some((m) => m.focus === c.sid) ? 'hd' : 'sd';
  if (want !== c.q) {
    c.q = want;
    if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'quality', q: want }));
  }
}

function relay(c, frame) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(c.sid);
  let msg = null;
  const now = Date.now();
  for (const m of monitors) {
    const focused = m.focus === c.sid;
    if (!focused && !m.subs.has(c.sid)) continue;
    const gap = focused ? 0 : 1000 / m.fps;
    if (now - (m.sent.get(c.sid) || 0) < gap - 15) continue;
    if (m.ws.bufferedAmount > MONITOR_BACKLOG) { m.dropped++; continue; }
    msg = msg || Buffer.concat([head, frame]);
    m.ws.send(msg);
    m.sent.set(c.sid, now);
    m.outBytes += msg.length;
    totals.outBytes += msg.length;
    bump(totalOut, msg.length);
  }
}

function snapshot() {
  const list = [];
  let frameMem = 0;
  for (const c of students.values()) {
    const r = perSec(c.rate);
    if (c.frame) frameMem += c.frame.length;
    list.push({
      sid: c.sid, name: c.name, testId: c.testId, testName: c.testName, online: !!c.ws, q: c.q,
      fps: Math.round(r.fps * 10) / 10, kbps: Math.round((r.bps * 8) / 100) / 10, frameKB: c.frames ? Math.round(c.bytes / c.frames / 102.4) / 10 : 0,
      mb: Math.round(c.bytes / 1048576 * 100) / 100, frames: c.frames, since: c.since, lastFrameAgo: c.frameAt ? Date.now() - c.frameAt : null,
      device: c.device, stats: c.stats, sessions: c.sessions,
    });
  }
  const i = perSec(totalIn); const o = perSec(totalOut);
  const mem = process.memoryUsage();
  return {
    type: 'state', at: Date.now(), uptimeSec: Math.round((Date.now() - started) / 1000), students: list,
    totals: {
      online: list.filter((s) => s.online).length, known: list.length, monitors: monitors.size,
      inMbps: Math.round((i.bps * 8) / 1e4) / 100, outMbps: Math.round((o.bps * 8) / 1e4) / 100, fpsIn: Math.round(i.fps),
      inMB: Math.round(totals.inBytes / 1048576), outMB: Math.round(totals.outBytes / 1048576), frames: totals.frames,
    },
    proc: { rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576), bufferKB: Math.round(frameMem / 1024) },
  };
}

// ---------------- Kubernetes metrics (CPU / memory of servers and pods) ----------------
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
let clusterCache = { at: 0, data: null };
function k8s(p) {
  return new Promise((resolve, reject) => {
    let token; let ca;
    try { token = fs.readFileSync(`${SA}/token`, 'utf8'); ca = fs.readFileSync(`${SA}/ca.crt`); } catch { return reject(new Error('not in Kubernetes')); }
    const req = https.request({ host: process.env.KUBERNETES_SERVICE_HOST, port: process.env.KUBERNETES_SERVICE_PORT || 443, path: p, ca,
      headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`${p}: HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
const cpu = (s) => { const n = parseFloat(s); return s.endsWith('n') ? n / 1e6 : s.endsWith('u') ? n / 1e3 : s.endsWith('m') ? n : n * 1000; }; // millicores
const mem = (s) => { const u = { Ki: 1 / 1024, Mi: 1, Gi: 1024, K: 1 / 1000, M: 1, G: 1000 }; const m = /^(\d+)([A-Za-z]*)$/.exec(s); return m ? Math.round(Number(m[1]) * (u[m[2]] ?? 1 / 1048576)) : 0; }; // MiB
async function cluster() {
  if (Date.now() - clusterCache.at < 5000) return clusterCache.data;
  const out = { nodes: [], pods: [], error: null };
  try {
    const [nm, nl] = await Promise.all([k8s('/apis/metrics.k8s.io/v1beta1/nodes'), k8s('/api/v1/nodes')]);
    out.nodes = nl.items.map((n) => {
      const m = nm.items.find((x) => x.metadata.name === n.metadata.name);
      const capCpu = cpu(n.status.capacity.cpu); const capMem = mem(n.status.capacity.memory);
      return { name: n.metadata.name, role: n.metadata.labels['klu/role'] || (n.metadata.labels['node-role.kubernetes.io/control-plane'] ? 'control-plane' : ''),
        cpuM: m ? Math.round(cpu(m.usage.cpu)) : null, cpuCapM: capCpu, memMiB: m ? mem(m.usage.memory) : null, memCapMiB: capMem };
    });
    if (NAMESPACE) {
      const pm = await k8s(`/apis/metrics.k8s.io/v1beta1/namespaces/${NAMESPACE}/pods`);
      out.pods = pm.items.map((p) => ({ name: p.metadata.name, cpuM: Math.round(p.containers.reduce((a, c) => a + cpu(c.usage.cpu), 0)), memMiB: p.containers.reduce((a, c) => a + mem(c.usage.memory), 0) }));
    }
  } catch (e) { out.error = e.message; }
  clusterCache = { at: Date.now(), data: out };
  return out;
}

// ---------------- HTTP ----------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp' };
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; connect-src 'self' wss: ws:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
};
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { ...SECURITY, 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/live/healthz') return send(res, 200, { ok: true });
  if (!p.startsWith('/live')) return send(res, 404, { error: 'Not found' });
  const admin = who(req, 'kl_admin', 'admin');
  if (p === '/live/api/state') return admin ? send(res, 200, snapshot()) : send(res, 401, { error: 'Admin login required' });
  if (p === '/live/api/cluster') return admin ? send(res, 200, await cluster()) : send(res, 401, { error: 'Admin login required' });
  if (p === '/live' || p === '/live/') {
    if (!admin) { res.writeHead(302, { Location: '/admin/login.html?next=/live/' }); return res.end(); }
    return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), TYPES['.html']);
  }
  // Static files of the monitor app (logos come from the exam portal itself).
  const rel = path.normalize(p.slice('/live/'.length)).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC, rel);
  if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  return send(res, 404, { error: 'Not found' });
});

// ---------------- WebSockets ----------------
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME + 1024, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  const role = p === '/live/ws/student' ? 'student' : p === '/live/ws/monitor' ? 'monitor' : null;
  const user = role === 'student' ? who(req, 'kl_stu', 'student') : role === 'monitor' ? who(req, 'kl_admin', 'admin') : null;
  if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => (role === 'student' ? onStudent(ws, user) : onMonitor(ws, user)));
});

function onStudent(ws, user) {
  const c = candidate(Number(user.sid));
  if (c.ws && c.ws !== ws) c.ws.close(4000, 'replaced');
  c.ws = ws; c.sessions++; c.lastSeen = Date.now();
  setQuality(c);
  if (c.q === 'hd') ws.send(JSON.stringify({ type: 'quality', q: 'hd' }));
  ws.on('message', (data, isBinary) => {
    c.lastSeen = Date.now();
    if (isBinary) {
      if (data.length < 100 || data.length > MAX_FRAME || data[0] !== 0xff || data[1] !== 0xd8) return;
      c.frame = data; c.frameAt = Date.now(); c.frames++; c.bytes += data.length;
      totals.inBytes += data.length; totals.frames++;
      bump(c.rate, data.length); bump(totalIn, data.length);
      relay(c, data);
      return;
    }
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'hello') {
      c.name = String(m.name || '').slice(0, 120); c.testId = Number(m.testId) || null; c.testName = String(m.testName || '').slice(0, 150);
      c.device = { mem: Number(m.mem) || null, cores: Number(m.cores) || null, screen: String(m.screen || '').slice(0, 20), mobile: !!m.mobile, ua: String(m.ua || '').slice(0, 160) };
    } else if (m.type === 'stats') {
      c.stats = { heapMB: Number(m.heapMB) || null, heapLimitMB: Number(m.heapLimitMB) || null, net: String(m.net || '').slice(0, 10),
        downlink: Number(m.downlink) || null, rtt: Number(m.rtt) || null, sentFps: Number(m.sentFps) || 0, skipped: Number(m.skipped) || 0, at: Date.now() };
    }
  });
  ws.on('close', () => { if (c.ws === ws) { c.ws = null; c.lastSeen = Date.now(); } });
  ws.on('error', () => {});
}

function onMonitor(ws) {
  const m = { ws, subs: new Set(), fps: 7, focus: null, sent: new Map(), outBytes: 0, dropped: 0 };
  monitors.add(m);
  const tick = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ ...snapshot(), me: { outMB: Math.round(m.outBytes / 1048576 * 10) / 10, dropped: m.dropped } })); }, 1000);
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'sub') {
      m.subs = new Set((msg.sids || []).slice(0, 200).map(Number));
      m.fps = Math.min(7, Math.max(1, Number(msg.fps) || 7));
      // Send the latest frame at once so the wall is never blank.
      m.subs.forEach((sid) => { const c = students.get(sid); if (c && c.frame) { m.sent.delete(sid); relay(c, c.frame); } });
    } else if (msg.type === 'focus') {
      const prev = m.focus;
      m.focus = msg.sid ? Number(msg.sid) : null;
      [prev, m.focus].forEach((sid) => { const c = sid && students.get(sid); if (c) setQuality(c); });
    }
  });
  ws.on('close', () => {
    clearInterval(tick);
    monitors.delete(m);
    if (m.focus) { const c = students.get(m.focus); if (c) setQuality(c); }
  });
  ws.on('error', () => {});
}

server.listen(PORT, '0.0.0.0', () => console.log(`KL live proctoring monitor on :${PORT}/live/`));
process.on('SIGTERM', () => { wss.clients.forEach((c) => c.close(1001, 'restarting')); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
