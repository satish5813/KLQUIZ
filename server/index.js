const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Create .env with strong random secrets on first run — unless the secrets already come from the
// environment (containers/Kubernetes Secrets), where the file system is read-only.
const ENV_PATH = path.join(__dirname, '..', '.env');
if (!fs.existsSync(ENV_PATH) && !(process.env.JWT_SECRET && process.env.APP_SECRET)) {
  const rnd = (n) => crypto.randomBytes(n).toString('base64url');
  fs.writeFileSync(ENV_PATH, [
    'PORT=3000',
    `JWT_SECRET=${rnd(48)}`,
    `APP_SECRET=${rnd(48)}`,
    'ADMIN_USER=admin',
    `ADMIN_PASSWORD=${rnd(12)}`,
    'GEMINI_API_KEY=',
    'GEMINI_MODEL=gemini-3.8-flash',
    '# Set to true when serving over HTTPS (required in production)',
    'SECURE_COOKIES=false',
    '# Set to 1 when running behind a reverse proxy or Cloudflare Tunnel',
    'TRUST_PROXY=0',
    '# 127.0.0.1 = reachable only through the tunnel/proxy; 0.0.0.0 = whole network (exam-hall LAN)',
    'HOST=0.0.0.0',
    '',
  ].join('\n'));
  console.log('Created .env with random secrets. Admin password is in .env (ADMIN_PASSWORD).');
}
require('dotenv').config({ path: ENV_PATH });
for (const k of ['JWT_SECRET', 'APP_SECRET']) {
  if (!process.env[k] || process.env[k].length < 32) {
    console.error(`${k} must be set in .env (at least 32 characters).`);
    process.exit(1);
  }
}

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { db, get } = require('./db');
const { seed } = require('./seed');
const { csrfGuard, HttpError } = require('./security');

seed();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 0);

// Behind Cloudflare plus another proxy (e.g. Traefik in Kubernetes), X-Forwarded-For only shows the last hop.
// Cloudflare's edge puts the visitor's real address in CF-Connecting-IP; with CLIENT_IP_HEADER=cf-connecting-ip
// it is used as req.ip, so rate limits and logs work per candidate. Only enable where all traffic comes via Cloudflare.
const CLIENT_IP_HEADER = (process.env.CLIENT_IP_HEADER || '').toLowerCase();
if (CLIENT_IP_HEADER) {
  app.use((req, res, next) => {
    const ip = (req.get(CLIENT_IP_HEADER) || '').trim();
    if (/^[0-9a-f:.]{3,45}$/i.test(ip)) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    next();
  });
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

app.use('/api', rateLimit({ windowMs: 60000, limit: 3000, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use('/api', csrfGuard);

// For uptime monitors / Cloudflare health checks. Reveals nothing beyond "up and the database answers".
app.get('/api/health', (req, res) => {
  try {
    get('SELECT 1 AS ok');
    res.json({ ok: true, uptime_sec: Math.round(process.uptime()) });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/api/admin', require('./routes/admin'));
app.use('/api/student', require('./routes/student'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Third-party renderers are served from our own origin so the strict CSP needs no CDN.
const NM = path.join(__dirname, '..', 'node_modules');
const PUBLIC = path.join(__dirname, '..', 'public');
const VENDOR = {
  '/vendor/katex/': path.join(NM, 'katex', 'dist'),
  '/vendor/smiles-drawer/': path.join(NM, 'smiles-drawer', 'dist'),
  '/vendor/dompurify/': path.join(NM, 'dompurify', 'dist'),
};

// Cache busting: pages are served with every local script/stylesheet URL stamped with a hash of the file
// (register.js?v=3fa2…). A proxy or browser may keep JS/CSS for hours (Cloudflare's Browser Cache TTL overrides
// max-age=0), so after a release a changed file must get a new URL; pages themselves are never cached.
const assetFile = (url) => {
  const prefix = Object.keys(VENDOR).find((p) => url.startsWith(p));
  return prefix ? path.join(VENDOR[prefix], url.slice(prefix.length)) : path.join(PUBLIC, url);
};
const stampedPages = new Map();
for (const page of ['index.html', 'exam.html', 'result.html', 'admin/index.html', 'admin/login.html']) {
  const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8').replace(/(src|href)="(\/[^"?#]+\.(?:js|css))"/g, (m, attr, url) => {
    const file = assetFile(url);
    if (!fs.existsSync(file)) return m;
    const v = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
    return `${attr}="${url}?v=${v}"`;
  });
  stampedPages.set(page, html);
}
const pageFor = (p) => {
  const rel = p.replace(/^\/+/, '');
  if (rel === '') return 'index.html';
  if (stampedPages.has(rel)) return rel;
  if (stampedPages.has(`${rel}.html`)) return `${rel}.html`;
  if (stampedPages.has(`${rel.replace(/\/$/, '')}/index.html`)) return `${rel.replace(/\/$/, '')}/index.html`;
  return null;
};
app.get(/.*/, (req, res, next) => {
  const page = pageFor(req.path);
  if (!page) return next();
  if (page === 'admin/index.html' && !req.path.endsWith('/') && !req.path.endsWith('.html')) return res.redirect(301, '/admin/');
  res.set('Cache-Control', 'no-cache').type('html').send(stampedPages.get(page));
});

for (const [prefix, dir] of Object.entries(VENDOR)) app.use(prefix.slice(0, -1), express.static(dir, { maxAge: '7d' }));
app.use(express.static(PUBLIC, { extensions: ['html'], index: 'index.html' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const PORT = Number(process.env.PORT) || 3000;
// Behind Cloudflare Tunnel or a reverse proxy, set HOST=127.0.0.1 so the app is reachable only through it.
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`KL Entrance Exam portal running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Admin portal: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/admin/`);
});

// Clean stop for systemd / PM2 restarts: finish in-flight requests, then close the database.
function shutdown(signal) {
  console.log(`${signal} received, shutting down…`);
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
