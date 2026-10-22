const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const store = require('./store');
const v = require('./validate');
const { requireAuth, wrap } = require('./middleware');

const router = express.Router();
router.use(requireAuth);

const MAX_OPS = 500;

/* GET /api/data — the signed-in user's complete app state. */
router.get('/', wrap(async (req, res) => {
  const state = await store.loadState(db, req.userId);
  if (!state) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true, state, serverTime: new Date().toISOString() });
}));

/*
 * POST /api/data/sync — apply a batch of changes atomically.
 * Body: { ops: [{ type, data?, id? }, ...] }. Either every op is applied or
 * none are (one transaction), so the client can safely retry the whole batch.
 */
router.post('/sync', wrap(async (req, res) => {
  const ops = v.arr(req.body && req.body.ops, 'ops', MAX_OPS);
  await db.tx(async (c) => {
    for (let i = 0; i < ops.length; i++) await store.applyOp(c, req.userId, ops[i], i);
  });
  res.json({ ok: true, applied: ops.length, serverTime: new Date().toISOString() });
}));

/* ======================================================================
   POST /api/data/import — one-time import of data that previously lived
   only in a device's localStorage (or an exported backup file).

   Safe to retry: an identical payload is recognised by its fingerprint and
   skipped, and every record gets a stable id (its own, or one derived from
   its content) so overlapping imports never create duplicates. Existing
   server data always wins — the import only fills gaps.
   ====================================================================== */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

function fingerprintOf(data) {
  // Only the data-bearing fields matter; volatile bits like the coach chat's
  // rendering or session flags shouldn't make the same data look "new".
  const { workoutLogs, mealLogs, stepLogs, customExercises, routine, profile, targets, dietPlan, dietPlanChecks, coachChat } = data;
  const fields = { workoutLogs, mealLogs, stepLogs, customExercises, routine, profile, targets, dietPlan, dietPlanChecks, coachChat };
  // Only when present, so backups made before "My foods" keep their fingerprint.
  if (Array.isArray(data.savedFoods) && data.savedFoods.length) fields.savedFoods = data.savedFoods;
  return hash(canonical(fields));
}

function legacyId(prefix, value) {
  return prefix + '_' + hash(canonical(value)).slice(0, 24);
}

async function importForUser(userId, rawData, rawSource) {
  const data = v.obj(rawData, 'data');
  const source = v.oneOf(rawSource || 'device', 'source', ['device', 'backup-file', 'paste', 'bundled']);
  const fingerprint = fingerprintOf(data);

  const counts = { workouts: 0, meals: 0, steps: 0, savedFoods: 0, customExercises: 0, coachMessages: 0, dietPlanChecks: 0, profile: false, targets: false, routine: false, dietPlan: false };
  const skipped = [];

  const result = await db.tx(async (c) => {
    // Claim the fingerprint first: a concurrent identical import blocks on the
    // unique index here and then sees the conflict, so it can't double-apply.
    const claim = await c.query(
      `INSERT INTO data_imports (user_id, fingerprint, source, counts) VALUES ($1, $2, $3, '{}')
       ON CONFLICT (user_id, fingerprint) DO NOTHING RETURNING id`,
      [userId, fingerprint, source]
    );
    if (!claim.rows.length) {
      const prev = await c.query('SELECT id, counts, created_at FROM data_imports WHERE user_id = $1 AND fingerprint = $2', [userId, fingerprint]);
      return { alreadyImported: true, importId: prev.rows[0].id, counts: prev.rows[0].counts, importedAt: prev.rows[0].created_at };
    }
    const importId = claim.rows[0].id;
    const current = await store.loadState(c, userId);

    // Each record is applied inside a savepoint, so one bad legacy record is
    // reported and skipped instead of aborting the whole import.
    async function attempt(label, fn) {
      await c.query('SAVEPOINT rec');
      try {
        const r = await fn();
        await c.query('RELEASE SAVEPOINT rec');
        return r;
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT rec');
        if (!(err instanceof v.ValidationError)) throw err;
        if (skipped.length < 50) skipped.push(`${label}: ${err.message}`);
        return false;
      }
    }

    if (!current.profile && data.profile && await attempt('profile', () => store.setProfile(c, userId, data.profile).then(() => true))) counts.profile = true;
    if (!current.targets && data.targets && await attempt('targets', () => store.setTargets(c, userId, data.targets).then(() => true))) counts.targets = true;

    const account = {};
    if (!current.splitType && data.splitType) account.splitType = String(data.splitType).slice(0, 30);
    if (!current.onboarded && (data.onboarded || data.profile)) account.onboarded = true;
    if (Object.keys(account).length) await attempt('account', () => store.setAccount(c, userId, account));

    // Routine: keep server days, add any missing day from the import.
    if (data.routine && typeof data.routine === 'object' && !Array.isArray(data.routine)) {
      const merged = Object.assign({}, data.routine, current.routine);
      const order = Object.keys(current.routine).concat(Object.keys(data.routine).filter((d) => !(d in current.routine)));
      const ordered = {};
      order.forEach((d) => { ordered[d] = merged[d]; });
      if (order.length !== Object.keys(current.routine).length) {
        if (await attempt('routine', () => store.setRoutine(c, userId, ordered).then(() => true))) counts.routine = true;
      }
    }

    for (const [i, e] of (Array.isArray(data.customExercises) ? data.customExercises : []).entries()) {
      if (await attempt(`customExercises[${i}]`, () => store.upsertCustomExercise(c, userId, e, { onlyInsert: true }))) counts.customExercises++;
    }

    for (const [i, w] of (Array.isArray(data.workoutLogs) ? data.workoutLogs : []).entries()) {
      if (!w || typeof w !== 'object') continue;
      const log = { ...w, id: w.id || legacyId('w', { date: w.date, day: w.day, exercises: w.exercises }) };
      if (await attempt(`workoutLogs[${i}]`, () => store.upsertWorkout(c, userId, log, { onlyInsert: true }))) counts.workouts++;
    }

    for (const [i, m] of (Array.isArray(data.mealLogs) ? data.mealLogs : []).entries()) {
      if (!m || typeof m !== 'object') continue;
      const meal = { ...m, uid: m.uid || legacyId('m', m), source: m.source || 'import' };
      if (await attempt(`mealLogs[${i}]`, () => store.upsertMeal(c, userId, meal, { onlyInsert: true }))) counts.meals++;
    }

    for (const [i, f] of (Array.isArray(data.savedFoods) ? data.savedFoods : []).entries()) {
      if (await attempt(`savedFoods[${i}]`, () => store.upsertSavedFood(c, userId, f, { onlyInsert: true }))) counts.savedFoods++;
    }

    for (const [i, s] of (Array.isArray(data.stepLogs) ? data.stepLogs : []).entries()) {
      if (await attempt(`stepLogs[${i}]`, () => store.setSteps(c, userId, v.obj(s, 'step'), { onlyInsert: true }))) counts.steps++;
    }

    if (!current.dietPlan && data.dietPlan && data.dietPlan.items && data.dietPlan.items.length) {
      if (await attempt('dietPlan', () => store.setDietPlan(c, userId, data.dietPlan).then(() => true))) counts.dietPlan = true;
    }
    if (data.dietPlanChecks && typeof data.dietPlanChecks === 'object') {
      for (const date of Object.keys(data.dietPlanChecks).slice(0, 2000)) {
        const day = data.dietPlanChecks[date] || {};
        for (const itemId of Object.keys(day).slice(0, 200)) {
          if (await attempt(`dietPlanChecks.${date}`, () => store.setDietPlanCheck(c, userId, { date, itemId, checked: day[itemId] }, { onlyInsert: true }))) counts.dietPlanChecks++;
        }
      }
    }

    const chat = Array.isArray(data.coachChat) ? data.coachChat.slice(-500) : [];
    for (const [i, m] of chat.entries()) {
      if (!m || typeof m !== 'object') continue;
      const msg = { ...m, id: m.id || legacyId('c', { i, who: m.who, text: m.text }) };
      if (await attempt(`coachChat[${i}]`, () => store.appendCoachMessage(c, userId, msg))) counts.coachMessages++;
    }

    await c.query('UPDATE data_imports SET counts = $2 WHERE id = $1', [importId, JSON.stringify(counts)]);
    return { alreadyImported: false, importId, counts };
  });

  const state = await store.loadState(db, userId);
  return { ...result, skipped, state };
}

router.post('/import', wrap(async (req, res) => {
  const body = v.obj(req.body, 'body');
  const result = await importForUser(req.userId, body.data, body.source);
  res.json({ ok: true, ...result });
}));

/* GET /api/data/imports — the user's import history (for the UI). */
router.get('/imports', wrap(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, source, counts, created_at FROM data_imports WHERE user_id = $1 ORDER BY id DESC LIMIT 20',
    [req.userId]
  );
  res.json({ ok: true, imports: rows });
}));

module.exports = router;
module.exports.fingerprintOf = fingerprintOf;
module.exports.importForUser = importForUser;
