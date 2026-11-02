// Same file format as ops/backup-crypt.js ("KLB1" | 12-byte nonce | AES-256-GCM ciphertext | 16-byte tag),
// so `node ops/backup-crypt.js decrypt` restores these backups.
//   encrypt <in> <out>    verify <file.enc> (decrypts to nowhere; fails on a wrong key or a damaged file)
//   decrypt <in> <out>    (used by the monthly restore test)
const crypto = require('crypto');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Writable } = require('stream');

const MAGIC = Buffer.from('KLB1');
const key = () => {
  const hex = fs.readFileSync(process.env.KL_BACKUP_KEY_FILE, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('Bad backup key');
  return Buffer.from(hex, 'hex');
};

async function encrypt(input, output) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), nonce);
  cipher.setAAD(MAGIC);
  const out = fs.createWriteStream(output);
  out.write(Buffer.concat([MAGIC, nonce]));
  await pipeline(fs.createReadStream(input), cipher, out, { end: false });
  await new Promise((res, rej) => out.end(cipher.getAuthTag(), (e) => (e ? rej(e) : res())));
}

async function decrypt(input, output) {
  const { size } = fs.statSync(input);
  const fd = fs.openSync(input, 'r');
  const head = Buffer.alloc(16);
  const tag = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.readSync(fd, tag, 0, 16, size - 16);
  fs.closeSync(fd);
  if (!head.subarray(0, 4).equals(MAGIC)) throw new Error('Not a KL backup file');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), head.subarray(4, 16));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const sink = output ? fs.createWriteStream(output) : new Writable({ write: (_c, _e, cb) => cb() });
  await pipeline(fs.createReadStream(input, { start: 16, end: size - 17 }), decipher, sink);
}

(async () => {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'encrypt' && a && b) return encrypt(a, b);
  if (cmd === 'decrypt' && a && b) return decrypt(a, b);
  if (cmd === 'verify' && a) { await decrypt(a, null); return console.log('verify OK'); }
  throw new Error('usage: encrypt <in> <out> | decrypt <in> <out> | verify <file>');
})().catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
