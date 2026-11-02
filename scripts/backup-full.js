// Full, consistent database backup for the server (includes students and results — keep it private).
// Safe while the portal is running. Keeps the newest KEEP_DAYS backups.
//   node scripts/backup-full.js [backup-folder]     (default: /var/backups/klquiz, or ./backups/full on Windows)
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const KEEP_DAYS = Number(process.env.KEEP_DAYS) || 14;
const root = path.join(__dirname, '..');
const src = path.join(process.env.DATA_DIR || path.join(root, 'data'), 'klquiz.db');
const dir = process.argv[2] || (process.platform === 'win32' ? path.join(root, 'backups', 'full') : '/var/backups/klquiz');

fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const out = path.join(dir, `klquiz-full-${stamp}.db`);
if (fs.existsSync(out)) fs.unlinkSync(out);
new DatabaseSync(src).exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);

const check = new DatabaseSync(out);
const ok = check.prepare('PRAGMA integrity_check').get().integrity_check;
const n = (sql) => check.prepare(sql).get().c;
console.log(`${out}: integrity ${ok}; ${n('SELECT COUNT(*) c FROM questions')} questions, ${n('SELECT COUNT(*) c FROM students')} students, ${n('SELECT COUNT(*) c FROM attempts')} attempts`);
check.close();
if (ok !== 'ok') process.exit(1);

// Remove backups older than KEEP_DAYS.
const cutoff = Date.now() - KEEP_DAYS * 86400000;
for (const f of fs.readdirSync(dir)) {
  if (/^klquiz-full-.*\.db$/.test(f) && fs.statSync(path.join(dir, f)).mtimeMs < cutoff) fs.unlinkSync(path.join(dir, f));
}
