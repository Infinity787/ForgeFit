// Shared test setup: a real PostgreSQL database (default: local forgefit_test),
// wiped and migrated before each test file.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql:///forgefit_test?host=/tmp';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-signing';
process.env.EMAIL_MODE = 'console';
process.env.GEMINI_API_KEY = 'test-gemini-key';

const request = require('supertest');
const db = require('../src/db');
const { migrate } = require('../src/migrate');
const { createApp } = require('../src/app');

const app = createApp();

async function resetDb() {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
}

let counter = 0;
/** Creates a verified account through the real signup flow; returns {token, user, password}. */
async function createUser(prefix = 'user') {
  counter += 1;
  const username = `${prefix}${counter}_${Date.now() % 100000}`.slice(0, 20);
  const email = `${username}@example.com`;
  const password = 'correct-horse-1';
  const start = await request(app).post('/api/auth/signup/start').send({ name: 'Test ' + prefix, email });
  if (start.status !== 200) throw new Error('signup/start failed: ' + JSON.stringify(start.body));
  const verify = await request(app).post('/api/auth/signup/verify').send({ email, code: start.body.devCode });
  const complete = await request(app).post('/api/auth/signup/complete')
    .send({ emailVerifiedToken: verify.body.emailVerifiedToken, username, password, name: 'Test ' + prefix });
  if (complete.status !== 201) throw new Error('signup/complete failed: ' + JSON.stringify(complete.body));
  return { token: complete.body.token, user: complete.body.user, password, email, username };
}

const auth = (token) => ({ Authorization: 'Bearer ' + token });

module.exports = { app, db, request, resetDb, createUser, auth };
