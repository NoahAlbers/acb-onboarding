const nodemailer = require('nodemailer');

// Real email goes out when SMTP_* is configured in .env. With MAIL_DEBUG=true and
// no SMTP host, "sends" are logged as JSON instead — handy for local testing.
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_DEBUG = process.env.MAIL_DEBUG === 'true';
const FROM = process.env.MAIL_FROM || (SMTP_USER ? `"Advanced Collection Bureau" <${SMTP_USER}>` : '"Advanced Collection Bureau" <onboarding@advancedcb.com>');

let transporter = null;
if (SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
} else if (MAIL_DEBUG) {
  transporter = nodemailer.createTransport({ jsonTransport: true });
}

function enabled() {
  return !!transporter;
}

function status() {
  return {
    enabled: enabled(),
    debug: !SMTP_HOST && MAIL_DEBUG,
    from: FROM,
    host: SMTP_HOST || null,
  };
}

// to: string or array. attachments: nodemailer format [{filename, content|path}].
async function send({ to, subject, html, text, attachments }) {
  if (!transporter) throw new Error('Email is not configured — set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env.');
  const list = (Array.isArray(to) ? to : String(to || '').split(/[\s,;]+/)).filter(Boolean);
  if (!list.length) throw new Error('No recipient email addresses.');
  const info = await transporter.sendMail({ from: FROM, to: list.join(', '), subject, html, text, attachments });
  if (MAIL_DEBUG && info.message) {
    const parsed = JSON.parse(info.message);
    console.log(`[mail-debug] to=${parsed.to.map((t) => t.address).join(',')} subject="${parsed.subject}" attachments=${(parsed.attachments || []).map((a) => a.filename).join(',') || 'none'}`);
  }
  return info;
}

async function verify() {
  if (!transporter) return { ok: false, error: 'SMTP not configured' };
  if (!SMTP_HOST) return { ok: true, message: 'Debug transport (MAIL_DEBUG) — emails are logged, not sent.' };
  try {
    await transporter.verify();
    return { ok: true, message: `Connected to ${SMTP_HOST}:${SMTP_PORT} as ${SMTP_USER || 'anonymous'}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { enabled, status, send, verify, FROM };
