const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Create .env with strong random secrets on first run.
const ENV_PATH = path.join(__dirname, '..', '.env');
if (!fs.existsSync(ENV_PATH)) {
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
app.use('/vendor/katex', express.static(path.join(NM, 'katex', 'dist'), { maxAge: '7d' }));
app.use('/vendor/smiles-drawer', express.static(path.join(NM, 'smiles-drawer', 'dist'), { maxAge: '7d' }));
app.use('/vendor/dompurify', express.static(path.join(NM, 'dompurify', 'dist'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], index: 'index.html' }));

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
