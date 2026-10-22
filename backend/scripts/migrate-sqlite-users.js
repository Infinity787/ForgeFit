/*
 * One-time copy of accounts from the old SQLite database (v1 backend) into
 * PostgreSQL. Password hashes are bcrypt in both, so users keep their
 * passwords. Existing Postgres users with the same username or email are
 * left untouched (reported as skipped), so the script is safe to re-run.
 *
 *   npm install --no-save better-sqlite3
 *   DATABASE_URL=postgres://... node scripts/migrate-sqlite-users.js path/to/forgefit.sqlite [--dry-run]
 *
 * The SQLite file is opened read-only and is never modified — keep it as
 * your backup until you have verified the migration.
 */
require('dotenv').config();
const path = require('path');
const db = require('../src/db');
const { migrate } = require('../src/migrate');

async function main() {
  const file = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!file) {
    console.error('Usage: node scripts/migrate-sqlite-users.js <forgefit.sqlite> [--dry-run]');
    process.exit(2);
  }
  let Database;
  try { Database = require('better-sqlite3'); } catch (e) {
    console.error('Run `npm install --no-save better-sqlite3` first.');
    process.exit(2);
  }
  const sqlite = new Database(path.resolve(file), { readonly: true, fileMustExist: true });
  const users = sqlite.prepare('SELECT username, email, name, password_hash, email_verified, created_at FROM users ORDER BY id').all();
  console.log(`Found ${users.length} account(s) in ${file}${dryRun ? ' (dry run)' : ''}.`);

  await migrate();
  let copied = 0;
  let skipped = 0;
  await db.tx(async (c) => {
    for (const u of users) {
      const res = await c.query(
        `INSERT INTO users (username, email, name, password_hash, email_verified, created_at)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
         ON CONFLICT DO NOTHING RETURNING id`,
        [u.username.toLowerCase(), u.email.toLowerCase(), u.name || u.username, u.password_hash, !!u.email_verified, u.created_at || Date.now()]
      );
      if (res.rowCount) copied++; else { skipped++; console.log(`  skipped ${u.username} (username or email already exists)`); }
    }
    if (dryRun) throw Object.assign(new Error('dry run'), { dryRun: true });
  }).catch((e) => { if (!e.dryRun) throw e; });

  console.log(dryRun
    ? `Dry run: would copy ${copied}, skip ${skipped}. Nothing was written.`
    : `Copied ${copied}, skipped ${skipped}.`);
  sqlite.close();
}

main()
  .catch((err) => { console.error('Migration failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
