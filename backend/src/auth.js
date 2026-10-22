const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { sendOtpEmail } = require('./email');
const {
  signToken, verifyToken, sessionToken, requireAuth, wrap,
  otpRequestLimiter, otpVerifyLimiter, loginLimiter,
} = require('./middleware');

const router = express.Router();

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD = 200;

function genOtp() {
  return String(crypto.randomInt(100000, 1000000));
}
function badRequest(res, message) {
  return res.status(400).json({ error: message });
}
function publicUser(u) {
  return { id: u.id, username: u.username, email: u.email, name: u.name };
}
function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 200);
}

/* ---------------- data access ---------------- */
async function userBy(column, value) {
  const { rows } = await db.query(`SELECT * FROM users WHERE ${column} = $1`, [value]);
  return rows[0] || null;
}
async function createOtp({ email, code, purpose, userId }) {
  await db.tx(async (c) => {
    await c.query('UPDATE otp_codes SET consumed = TRUE WHERE email = $1 AND purpose = $2 AND consumed = FALSE', [email, purpose]);
    await c.query(
      `INSERT INTO otp_codes (email, code, purpose, user_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)`,
      [email, code, purpose, userId || null, String(OTP_TTL_MS)]
    );
  });
}
async function latestOtp(email, purpose, userId) {
  const { rows } = await db.query(
    `SELECT *, (expires_at < now()) AS expired FROM otp_codes
     WHERE email = $1 AND purpose = $2 AND consumed = FALSE
       AND ($3::bigint IS NULL OR user_id = $3)
     ORDER BY id DESC LIMIT 1`,
    [email, purpose, userId || null]
  );
  return rows[0] || null;
}
/** Checks a submitted code; returns an error message or null on success (and consumes it). */
async function checkOtp(email, purpose, code, userId) {
  const otp = await latestOtp(email, purpose, userId);
  if (!otp) return 'No pending code for this email — request a new one.';
  if (otp.expired) return 'Code expired — request a new one.';
  if (otp.attempts >= MAX_OTP_ATTEMPTS) return 'Too many attempts — request a new code.';
  await db.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
  const a = Buffer.from(String(code));
  const b = Buffer.from(otp.code);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'Incorrect code.';
  await db.query('UPDATE otp_codes SET consumed = TRUE WHERE id = $1', [otp.id]);
  return null;
}

/* =====================================================================
   SIGN UP — start (name + email -> send OTP), verify, complete
   ===================================================================== */
router.post('/signup/start', otpRequestLimiter, wrap(async (req, res) => {
  const name = str(req.body.name, 80);
  const email = str(req.body.email, 254).toLowerCase();
  if (!name) return badRequest(res, 'Enter your name.');
  if (!EMAIL_RE.test(email)) return badRequest(res, 'Enter a valid email address.');
  if (await userBy('email', email)) return badRequest(res, 'An account with this email already exists.');

  const code = genOtp();
  await createOtp({ email, code, purpose: 'signup' });
  const result = await sendOtpEmail(email, code, 'signup');
  res.json({
    ok: true,
    message: 'Verification code sent.',
    // Only present when no real email transport is configured (dev mode).
    devCode: result.exposeCode ? code : undefined,
  });
}));

router.post('/signup/verify', otpVerifyLimiter, wrap(async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase();
  const err = await checkOtp(email, 'signup', str(req.body.code, 10));
  if (err) return badRequest(res, err);
  const emailVerifiedToken = signToken({ type: 'signup_verified', email }, '15m');
  res.json({ ok: true, emailVerifiedToken });
}));

router.post('/signup/complete', wrap(async (req, res) => {
  const { emailVerifiedToken, password } = req.body;
  const username = str(req.body.username, 40).toLowerCase();

  let payload;
  try {
    payload = verifyToken(emailVerifiedToken);
    if (payload.type !== 'signup_verified') throw new Error('wrong token type');
  } catch (e) {
    return res.status(401).json({ error: 'Your email verification expired — start over.' });
  }
  if (!USERNAME_RE.test(username)) return badRequest(res, 'Username: 3-20 characters, letters/numbers/underscore only.');
  if (typeof password !== 'string' || password.length < 6) return badRequest(res, 'Password must be at least 6 characters.');
  if (password.length > MAX_PASSWORD) return badRequest(res, 'Password is too long.');
  if (await userBy('username', username)) return badRequest(res, 'That username is already taken.');
  if (await userBy('email', payload.email)) return badRequest(res, 'An account with this email already exists.');

  const name = str(req.body.name, 80) || username;
  const passwordHash = await bcrypt.hash(password, 10);
  let user;
  try {
    const { rows } = await db.query(
      `INSERT INTO users (username, email, name, password_hash, email_verified)
       VALUES ($1, $2, $3, $4, TRUE) RETURNING *`,
      [username, payload.email, name, passwordHash]
    );
    user = rows[0];
  } catch (e) {
    if (e.code === '23505') return badRequest(res, 'That username or email is already registered.');
    throw e;
  }
  res.status(201).json({ ok: true, token: sessionToken(user), user: publicUser(user) });
}));

/* =====================================================================
   LOG IN — username (or email) + password
   ===================================================================== */
router.post('/login', loginLimiter, wrap(async (req, res) => {
  const login = str(req.body.username, 254).toLowerCase();
  const password = String(req.body.password || '').slice(0, MAX_PASSWORD);
  const user = login.includes('@') ? await userBy('email', login) : await userBy('username', login);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  res.json({ ok: true, token: sessionToken(user), user: publicUser(user) });
}));

/* =====================================================================
   CURRENT USER / ACCOUNT
   ===================================================================== */
router.get('/me', requireAuth, wrap(async (req, res) => {
  const user = await userBy('id', req.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json(publicUser(user));
}));

// Update display name and/or username.
router.patch('/account', requireAuth, wrap(async (req, res) => {
  const user = await userBy('id', req.userId);
  const updates = {};
  if (req.body.name !== undefined) {
    const name = str(req.body.name, 80);
    if (!name) return badRequest(res, 'Name cannot be empty.');
    updates.name = name;
  }
  if (req.body.username !== undefined) {
    const username = str(req.body.username, 40).toLowerCase();
    if (!USERNAME_RE.test(username)) return badRequest(res, 'Username: 3-20 chars, letters/numbers/underscore only.');
    if (username !== user.username) {
      const taken = await userBy('username', username);
      if (taken) return badRequest(res, 'That username is already taken.');
      updates.username = username;
    }
  }
  const keys = Object.keys(updates);
  if (!keys.length) return res.json({ ok: true, user: publicUser(user) });
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  try {
    const { rows } = await db.query(
      `UPDATE users SET ${sets}, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.userId, ...keys.map((k) => updates[k])]
    );
    res.json({ ok: true, user: publicUser(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return badRequest(res, 'That username is already taken.');
    throw e;
  }
}));

// Email change: a code goes to the NEW address; the change applies once verified.
router.post('/email/start', requireAuth, otpRequestLimiter, wrap(async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return badRequest(res, 'Enter a valid email address.');
  const existing = await userBy('email', email);
  if (existing && existing.id !== req.userId) return badRequest(res, 'That email is already registered to another account.');
  if (existing) return badRequest(res, 'That is already your email.');
  const code = genOtp();
  await createOtp({ email, code, purpose: 'email_change', userId: req.userId });
  const result = await sendOtpEmail(email, code, 'email_change');
  res.json({ ok: true, devCode: result.exposeCode ? code : undefined });
}));

router.post('/email/verify', requireAuth, otpVerifyLimiter, wrap(async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase();
  const err = await checkOtp(email, 'email_change', str(req.body.code, 10), req.userId);
  if (err) return badRequest(res, err);
  try {
    const { rows } = await db.query(
      'UPDATE users SET email = $2, email_verified = TRUE, updated_at = now() WHERE id = $1 RETURNING *',
      [req.userId, email]
    );
    res.json({ ok: true, user: publicUser(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return badRequest(res, 'That email is already registered to another account.');
    throw e;
  }
}));

router.post('/change-password', requireAuth, loginLimiter, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await userBy('id', req.userId);
  if (typeof currentPassword !== 'string' || !(await bcrypt.compare(currentPassword.slice(0, MAX_PASSWORD), user.password_hash))) {
    return badRequest(res, 'Current password is incorrect.');
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6) return badRequest(res, 'New password must be at least 6 characters.');
  if (newPassword.length > MAX_PASSWORD) return badRequest(res, 'Password is too long.');
  const { rows } = await db.query(
    `UPDATE users SET password_hash = $2, session_epoch = session_epoch + 1, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [req.userId, await bcrypt.hash(newPassword, 10)]
  );
  // Other devices are signed out; this one gets a fresh token.
  res.json({ ok: true, token: sessionToken(rows[0]) });
}));

// Permanently deletes the account; every data table cascades from users.
router.delete('/me', requireAuth, wrap(async (req, res) => {
  await db.query('DELETE FROM users WHERE id = $1', [req.userId]);
  res.json({ ok: true });
}));

/* =====================================================================
   FORGOT PASSWORD — start, verify, complete
   ===================================================================== */
router.post('/forgot/start', otpRequestLimiter, wrap(async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return badRequest(res, 'Enter a valid email address.');
  const user = await userBy('email', email);
  let devCode;
  // Same response whether or not the email is registered (no account enumeration).
  if (user) {
    const code = genOtp();
    await createOtp({ email, code, purpose: 'reset' });
    const result = await sendOtpEmail(email, code, 'reset');
    if (result.exposeCode) devCode = code;
  }
  res.json({ ok: true, message: 'If that email has an account, a code has been sent.', devCode });
}));

router.post('/forgot/verify', otpVerifyLimiter, wrap(async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase();
  const err = await checkOtp(email, 'reset', str(req.body.code, 10));
  if (err) return badRequest(res, err);
  const resetToken = signToken({ type: 'reset_verified', email }, '15m', { singleUse: true });
  res.json({ ok: true, resetToken });
}));

router.post('/forgot/complete', wrap(async (req, res) => {
  const { resetToken, newPassword } = req.body;
  let payload;
  try {
    payload = verifyToken(resetToken);
    if (payload.type !== 'reset_verified' || !payload.jti) throw new Error('wrong token type');
    const used = await db.query('SELECT 1 FROM used_tokens WHERE jti = $1', [payload.jti]);
    if (used.rows.length) throw new Error('token already used');
  } catch (e) {
    return res.status(401).json({ error: 'Your reset session expired or was already used — start over.' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6) return badRequest(res, 'Password must be at least 6 characters.');
  if (newPassword.length > MAX_PASSWORD) return badRequest(res, 'Password is too long.');

  const user = await userBy('email', payload.email);
  if (!user) return res.status(404).json({ error: 'Account no longer exists.' });

  const hash = await bcrypt.hash(newPassword, 10);
  const applied = await db.tx(async (c) => {
    await c.query('DELETE FROM used_tokens WHERE expires_at < now()');
    const ins = await c.query(
      'INSERT INTO used_tokens (jti, expires_at) VALUES ($1, to_timestamp($2)) ON CONFLICT DO NOTHING RETURNING jti',
      [payload.jti, payload.exp]
    );
    if (!ins.rows.length) return false; // raced with another use of the same token
    await c.query(
      'UPDATE users SET password_hash = $2, session_epoch = session_epoch + 1, updated_at = now() WHERE id = $1',
      [user.id, hash]
    );
    return true;
  });
  if (!applied) return res.status(401).json({ error: 'Your reset session expired or was already used — start over.' });
  res.json({ ok: true, username: user.username });
}));

/* =====================================================================
   ADMIN — list signups. Requires ADMIN_SECRET (header x-admin-secret,
   or ?secret= for convenience in a browser). Disabled if unset.
   ===================================================================== */
router.get('/admin/users', wrap(async (req, res) => {
  const expected = process.env.ADMIN_SECRET || '';
  const provided = String(req.headers['x-admin-secret'] || req.query.secret || '');
  const ok = expected.length > 0 && provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'Missing or incorrect admin secret.' });
  const { rows } = await db.query(
    'SELECT id, username, email, name, created_at FROM users ORDER BY created_at DESC'
  );
  res.json({ count: rows.length, users: rows });
}));

module.exports = router;
