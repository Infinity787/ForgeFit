const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings (the app's native date
// format) instead of JS Dates, which would shift across time zones.
types.setTypeParser(1082, (v) => v);
// NUMERIC -> number (macros, weights) and BIGINT -> number (ids stay far
// below 2^53).
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

function sslConfig() {
  const mode = (process.env.DATABASE_SSL || '').toLowerCase();
  if (mode === 'false' || mode === 'disable') return false;
  if (mode === 'true' || mode === 'require') return { rejectUnauthorized: false };
  // Managed hosts (Render, Neon, Supabase) require TLS; local Postgres doesn't.
  const url = process.env.DATABASE_URL || '';
  return /localhost|127\.0\.0\.1|\/tmp|host=\//.test(url) || !url ? false : { rejectUnauthorized: false };
}

let pool = null;
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set. See backend/README.md.');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslConfig(),
      max: Number(process.env.DATABASE_POOL_MAX || 10),
    });
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

/** Runs fn(client) inside BEGIN/COMMIT, rolling back on any thrown error. */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { query, tx, close, getPool };
