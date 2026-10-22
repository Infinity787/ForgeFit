const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const DEV_SECRET = 'dev-only-insecure-secret-change-me';
const JWT_SECRET = process.env.JWT_SECRET || DEV_SECRET;
if (process.env.NODE_ENV === 'production' && (JWT_SECRET === DEV_SECRET || JWT_SECRET.length < 32)) {
  // Refuse to run in production with a guessable signing key.
  throw new Error('JWT_SECRET must be set to a long random value in production.');
}

// Every v2 token carries this issuer. Tokens minted by the v1 (SQLite)
// backend lack it and are rejected: their user ids refer to the old
// database and must never be resolved against the new one.
const ISSUER = 'forgefit-api-v2';

function signToken(payload, expiresIn, opts) {
  const jti = (opts && opts.singleUse) ? crypto.randomUUID() : undefined;
  return jwt.sign(payload, JWT_SECRET, { expiresIn, issuer: ISSUER, ...(jti ? { jwtid: jti } : {}) });
}
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { issuer: ISSUER, algorithms: ['HS256'] });
}
function sessionToken(user) {
  return signToken({ type: 'session', sub: user.id, ep: user.session_epoch || 0 }, '30d');
}

/**
 * Requires a valid session JWT (Authorization: Bearer <token>) whose account
 * still exists and whose session epoch is current (password changes and
 * resets bump the epoch, signing out older sessions). Sets req.userId.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing session token.' });
  let payload;
  try {
    payload = verifyToken(token);
    if (payload.type !== 'session') throw new Error('wrong token type');
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
  try {
    const { rows } = await db.query('SELECT id, session_epoch FROM users WHERE id = $1', [payload.sub]);
    if (!rows[0] || rows[0].session_epoch !== (payload.ep || 0)) {
      return res.status(401).json({ error: 'Your session has ended. Please log in again.' });
    }
    req.userId = rows[0].id;
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Wraps an async route handler so rejected promises reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const skipInTests = () => process.env.NODE_ENV === 'test' && !process.env.TEST_RATE_LIMITS;
function limiter(windowMs, max, error, keyByUser) {
  return rateLimit({
    windowMs, max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipInTests,
    message: { error },
    // AI endpoints are authenticated, so limit per account rather than per IP.
    ...(keyByUser ? { keyGenerator: (req) => 'u:' + req.userId } : {}),
  });
}

const otpRequestLimiter = limiter(60 * 60 * 1000, 8, 'Too many code requests. Please try again later.');
const otpVerifyLimiter = limiter(15 * 60 * 1000, 30, 'Too many attempts. Please try again later.');
const loginLimiter = limiter(15 * 60 * 1000, 20, 'Too many login attempts. Please try again later.');
const aiLimiter = limiter(60 * 60 * 1000, Number(process.env.AI_HOURLY_LIMIT || 60), 'You’ve hit the hourly AI limit. Try again later.', true);

module.exports = {
  signToken, verifyToken, sessionToken, requireAuth, wrap,
  otpRequestLimiter, otpVerifyLimiter, loginLimiter, aiLimiter,
};
