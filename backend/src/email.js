const nodemailer = require('nodemailer');

const MODE = (process.env.EMAIL_MODE || 'console').toLowerCase();
const IS_PROD = process.env.NODE_ENV === 'production';

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transporter;
}

const ACTIONS = {
  signup: 'verify your email',
  reset: 'reset your password',
  email_change: 'confirm your new email address',
};

function otpEmailBody(code, purpose) {
  const action = ACTIONS[purpose] || 'continue';
  return {
    subject: `Your ForgeFit code: ${code}`,
    text: `Your ForgeFit verification code is ${code}. Use it to ${action}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    html: `<div style="font-family:sans-serif;max-width:420px;margin:auto;padding:24px;color:#111;">
      <h2 style="margin-bottom:4px;">ForgeFit</h2>
      <p style="color:#555;">Use this code to ${action}. It expires in 10 minutes.</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:8px;text-align:center;padding:16px;background:#f4f4f4;border-radius:10px;margin:16px 0;">${code}</div>
      <p style="color:#999;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>
    </div>`,
  };
}

/**
 * Sends a one-time code. Returns { delivered, exposeCode }.
 *
 * exposeCode is true only in EMAIL_MODE=console (local development), where the
 * API returns the code so the flow can be tested without SMTP. Password-reset
 * codes are never exposed when NODE_ENV=production — returning them to the
 * caller would let anyone reset any account. If SMTP delivery fails, the
 * request fails; the code is never logged or handed back as a fallback.
 */
async function sendOtpEmail(toEmail, code, purpose) {
  const { subject, text, html } = otpEmailBody(code, purpose);

  if (MODE === 'brevo') return sendViaBrevo(toEmail, subject, text, html);

  if (MODE !== 'smtp') {
    const exposeCode = !(IS_PROD && purpose !== 'signup');
    if (!IS_PROD) console.log(`[email:console] ${purpose} code for ${toEmail}: ${code}`);
    return { delivered: false, exposeCode };
  }

  try {
    await getTransporter().sendMail({
      from: process.env.EMAIL_FROM || 'ForgeFit <no-reply@example.com>',
      to: toEmail,
      subject, text, html,
    });
    return { delivered: true, exposeCode: false };
  } catch (err) {
    console.error('[email] SMTP send failed:', err.code || err.message);
    const e = new Error('We couldn’t send the email right now. Please try again in a minute.');
    e.status = 502;
    e.expose = true;
    throw e;
  }
}


// Brevo's transactional email HTTP API (EMAIL_MODE=brevo).
function parseFrom(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from || '');
  if (m) return { name: m[1].trim() || 'ForgeFit', email: m[2].trim() };
  return { name: 'ForgeFit', email: (from || '').trim() };
}
function brevoSender() {
  const fromEnv = parseFrom(process.env.EMAIL_FROM);
  return {
    name: process.env.BREVO_SENDER_NAME || fromEnv.name,
    email: process.env.BREVO_SENDER_EMAIL || process.env.SENDER_EMAIL || fromEnv.email,
  };
}
function brevoKey() {
  return process.env.BREVO_API_KEY || process.env.BREVO_KEY || process.env.SENDINBLUE_API_KEY;
}
async function sendViaBrevo(toEmail, subject, text, html) {
  const key = brevoKey();
  const sender = brevoSender();
  const fail = (why) => {
    console.error('[email] Brevo send failed:', why);
    const e = new Error('We couldn’t send the email right now. Please try again in a minute.');
    e.status = 502;
    e.expose = true;
    return e;
  };
  if (!key || !sender.email) throw fail('missing BREVO_API_KEY or sender address');
  let res;
  try {
    res = await globalThis.fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender, to: [{ email: toEmail }], subject, textContent: text, htmlContent: html }),
    });
  } catch (err) {
    throw fail(err.code || err.message);
  }
  if (!res.ok) throw fail('HTTP ' + res.status); // body not logged: it can echo the request
  return { delivered: true, exposeCode: false };
}

module.exports = { sendOtpEmail, parseFrom };
