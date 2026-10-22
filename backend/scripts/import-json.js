/*
 * Loads a ForgeFit backup JSON into an existing account, server-side.
 * Uses the same duplicate-safe logic as the in-app import: existing account
 * data wins, records already present are skipped, and re-running is a no-op.
 *
 *   DATABASE_URL=postgres://... node scripts/import-json.js <username-or-email> <backup.json> [--dry-run]
 *
 * The backup can be an "Export backup" file ({username, profile, ...}) or a
 * raw localStorage dump ({username: {...}}).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { migrate } = require('../src/migrate');
const { importForUser } = require('../src/data');

function normalise(data) {
  if (data && typeof data === 'object' && data.username) return data;
  if (data && typeof data === 'object') {
    const first = data[Object.keys(data)[0]];
    if (first && first.username) return first;
  }
  return null;
}

async function main() {
  const [who, file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dryRun = process.argv.includes('--dry-run');
  if (!who || !file) {
    console.error('Usage: node scripts/import-json.js <username-or-email> <backup.json> [--dry-run]');
    process.exit(2);
  }
  const data = normalise(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
  if (!data) throw new Error('Not a ForgeFit backup (no username found in the file).');

  await migrate({ log: () => {} });
  const login = who.trim().toLowerCase();
  const { rows } = await db.query('SELECT id, username, email FROM users WHERE username = $1 OR email = $1', [login]);
  if (!rows[0]) throw new Error(`No account with username or email "${who}". Sign up in the app first.`);
  const user = rows[0];
  console.log(`Account: ${user.username} <${user.email}> (id ${user.id})`);
  console.log(`Backup:  ${(data.workoutLogs || []).length} workouts, ${(data.mealLogs || []).length} meals, ${(data.stepLogs || []).length} step days, ${Object.keys(data.routine || {}).length} routine days`);

  if (dryRun) {
    console.log('Dry run — nothing written.');
    return;
  }
  const res = await importForUser(user.id, data, 'backup-file');
  if (res.alreadyImported) console.log('This exact backup was already imported — nothing changed.');
  else console.log('Imported:', JSON.stringify(res.counts));
  if (res.skipped.length) console.log('Skipped (invalid records):\n  ' + res.skipped.join('\n  '));
  const s = res.state;
  console.log(`Account now has ${s.workoutLogs.length} workouts, ${s.mealLogs.length} meals, onboarded=${s.onboarded}.`);
}

main()
  .catch((err) => { console.error('Import failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
