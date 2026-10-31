// Writes a consistent snapshot of the database to backups/klquiz-backup.db for publishing.
// Safe while the server is running (VACUUM INTO). The published copy never contains admin
// password hashes, session pass keys or candidates' personal data and answers; keep full
// backups (with students) offline, e.g. on the pen drive.
//   node scripts/backup-db.js
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const src = path.join(root, 'data', 'klquiz.db');
const outDir = path.join(root, 'backups');
const out = path.join(outDir, 'klquiz-backup.db');

fs.mkdirSync(outDir, { recursive: true });
if (fs.existsSync(out)) fs.unlinkSync(out);
new DatabaseSync(src).exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);

const db = new DatabaseSync(out);
db.exec(`
  DELETE FROM admins;                       -- recreated from ADMIN_USER / ADMIN_PASSWORD in .env on first start
  DELETE FROM attempts;                     -- candidates' answers and scores
  DELETE FROM students;                     -- names, addresses, phone numbers
  UPDATE tests SET passkey_hash = NULL, passkey_enc = NULL;
  DELETE FROM settings WHERE key = 'gemini_key';
  VACUUM;
`);
const count = (sql) => db.prepare(sql).get().c;
console.log(`Wrote ${path.relative(root, out)}: ${count("SELECT COUNT(*) c FROM questions WHERE status = 'approved'")} approved questions, `
  + `${count('SELECT COUNT(*) c FROM exam_templates')} exam patterns, ${count('SELECT COUNT(*) c FROM tests')} tests `
  + `(no admin hashes, pass keys or student data).`);
console.log('integrity:', db.prepare('PRAGMA integrity_check').get().integrity_check);
db.close();
