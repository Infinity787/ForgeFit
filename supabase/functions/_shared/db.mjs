// PostgreSQL access for the Edge Function (and the Node tests).
import pg from 'pg';

const { Pool, types } = pg;
// DATE as 'YYYY-MM-DD' strings (no time-zone shifts); NUMERIC and BIGINT as numbers.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

export function createDb(connectionString, opts = {}) {
  if (!connectionString) throw new Error('Database connection string is missing.');
  const pool = new Pool({ connectionString, max: opts.max || 3, ssl: opts.ssl || false, idleTimeoutMillis: 10000 });
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return {
    query: (text, params) => pool.query(text, params),
    /** Runs fn(client) in a transaction, rolling back if it throws. */
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* connection already gone */ }
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
