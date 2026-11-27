// One-time codes for CRM candidates: email through SMTP and, when configured, SMS through the university's
// DLT-registered SMS gateway. Settings come from Admin → Settings (stored encrypted), else from the environment.
const { get } = require('./db');
const { decrypt } = require('./security');

const setting = (k) => (get('SELECT value FROM settings WHERE key = ?', k) || {}).value || '';

function smtpConfig() {
  const pass = setting('smtp_pass');
  return {
    host: setting('smtp_host') || process.env.SMTP_HOST || '',
    port: Number(setting('smtp_port') || process.env.SMTP_PORT || 587),
    user: setting('smtp_user') || process.env.SMTP_USER || '',
    pass: (pass && decrypt(pass)) || process.env.SMTP_PASS || '',
    from: setting('smtp_from') || process.env.SMTP_FROM || '',
  };
}
function smsConfig() {
  const url = setting('sms_url');
  return { url: (url && decrypt(url)) || process.env.SMS_URL || '' };
}

let cached = { sig: '', transport: null };
function transport(c) {
  const sig = `${c.host}|${c.port}|${c.user}|${c.pass}`;
  if (cached.sig !== sig) {
    // Loaded on first use so the portal still starts where the package is missing.
    const nodemailer = require('nodemailer');
    cached = {
      sig,
      transport: nodemailer.createTransport({
        host: c.host, port: c.port, secure: c.port === 465, auth: c.user ? { user: c.user, pass: c.pass } : undefined,
        pool: true, maxConnections: 5, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
      }),
    };
  }
  return cached.transport;
}

const channels = () => ({ email: !!(smtpConfig().host && smtpConfig().from), sms: !!smsConfig().url });

async function sendEmail(to, subject, text) {
  const c = smtpConfig();
  await transport(c).sendMail({ from: c.from, to, subject, text });
}

// SMS gateway URL template, e.g. https://sms.example.in/send?key=…&to={mobile}&msg={message}; called with GET.
async function sendSms(mobile, message) {
  const { url } = smsConfig();
  const u = url.replace('{mobile}', encodeURIComponent(mobile)).replace('{message}', encodeURIComponent(message))
    .replace('{otp}', encodeURIComponent((message.match(/\d{6}/) || [''])[0]));
  const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`SMS gateway HTTP ${res.status}`);
}

// Sends the code on every configured channel; resolves with the channels that worked.
async function sendOtp({ email, mobile, name, exam, otp }) {
  const ch = channels();
  const sent = [];
  const errors = [];
  if (ch.email && email) {
    try {
      await sendEmail(email, `${otp} is your KL exam login code`,
        `Dear ${name},\n\nYour one-time code for ${exam} is ${otp}.\nIt is valid for 10 minutes. Do not share it with anyone.\n\nKL University Admissions`);
      sent.push('email');
    } catch (e) { errors.push(`email: ${e.message}`); }
  }
  if (ch.sms && mobile) {
    try {
      await sendSms(mobile, `${otp} is your KL University exam login code for ${exam}. Valid 10 minutes. Do not share. - KLU`);
      sent.push('sms');
    } catch (e) { errors.push(`sms: ${e.message}`); }
  }
  if (errors.length) console.error('otp delivery:', errors.join('; '));
  return sent;
}

module.exports = { sendOtp, sendEmail, channels, smtpConfig, smsConfig };
