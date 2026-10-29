// Shared by the Supabase Edge Function and the Node test suite.
/*
 * SQL persistence for a user's app data. Every query is scoped by user_id
 * (taken from the verified session, never from the request body), so one
 * account can never read or change another account's rows.
 *
 * The client works with one JSON "user state" object (the same shape the app
 * always used in localStorage). loadState() assembles it from normalised
 * tables; applyOp() writes individual changes back.
 */
import * as v from './validate.mjs';

/* ======================================================================
   READ
   ====================================================================== */
async function loadState(c, userId) {
  const q = (sql) => () => c.query(sql, [userId]).then((r) => r.rows);
  // A single transaction client can only run one query at a time, so run
  // sequentially there; through the pool the reads go in parallel.
  const all = (thunks) => (typeof c.release === 'function'
    ? thunks.reduce((p, t) => p.then((acc) => t().then((r) => acc.concat([r]))), Promise.resolve([]))
    : Promise.all(thunks.map((t) => t())));
  const [
    [user], [profile], [targets], customEx, routineRows, workouts, sets, meals, steps,
    [plan], planItems, checks, coach, savedFoods,
  ] = await all([
    q('SELECT username, email, name, onboarded, split_type, created_at FROM app.accounts WHERE id = $1'),
    q('SELECT * FROM app.profiles WHERE user_id = $1'),
    q('SELECT * FROM app.targets WHERE user_id = $1'),
    q('SELECT client_id, name, muscle, type FROM app.custom_exercises WHERE user_id = $1 ORDER BY id'),
    q(`SELECT d.name, d.position, e.exercise_ref FROM app.routine_days d
       LEFT JOIN app.routine_day_exercises e ON e.routine_day_id = d.id
       WHERE d.user_id = $1 ORDER BY d.position, e.position`),
    q('SELECT id, client_id, date, day_name FROM app.workout_logs WHERE user_id = $1 ORDER BY date, id'),
    q(`SELECT we.workout_id, we.position AS ex_pos, we.exercise_ref, s.*
       FROM app.workout_exercises we
       JOIN app.workout_logs w ON w.id = we.workout_id
       LEFT JOIN app.workout_sets s ON s.workout_exercise_id = we.id
       WHERE w.user_id = $1 ORDER BY we.workout_id, we.position, s.position`),
    q('SELECT * FROM app.meal_logs WHERE user_id = $1 ORDER BY date, id'),
    q('SELECT date, steps FROM app.step_logs WHERE user_id = $1 ORDER BY date'),
    q('SELECT updated_at FROM app.diet_plans WHERE user_id = $1'),
    q('SELECT item_id, text FROM app.diet_plan_items WHERE user_id = $1 ORDER BY position'),
    q('SELECT date, item_id, checked FROM app.diet_plan_checks WHERE user_id = $1'),
    q('SELECT client_id, who, text FROM app.coach_messages WHERE user_id = $1 ORDER BY seq, id'),
    q('SELECT client_id, name, serving, calories, protein, carbs, fat FROM app.saved_foods WHERE user_id = $1 ORDER BY id'),
  ]);
  if (!user) return null;

  const routine = {};
  routineRows.forEach((r) => {
    if (!routine[r.name]) routine[r.name] = [];
    if (r.exercise_ref) routine[r.name].push(r.exercise_ref);
  });

  const byWorkout = new Map();
  sets.forEach((r) => {
    if (!byWorkout.has(r.workout_id)) byWorkout.set(r.workout_id, []);
    const exs = byWorkout.get(r.workout_id);
    let ex = exs[exs.length - 1];
    if (!ex || ex.pos !== r.ex_pos) { ex = { pos: r.ex_pos, exId: r.exercise_ref, sets: [] }; exs.push(ex); }
    if (r.set_type) ex.sets.push(rowToSet(r));
  });

  const dietPlanChecks = {};
  checks.forEach((r) => {
    if (!dietPlanChecks[r.date]) dietPlanChecks[r.date] = {};
    dietPlanChecks[r.date][r.item_id] = r.checked;
  });

  return {
    username: user.username,
    email: user.email,
    name: user.name,
    backendAuth: true,
    onboarded: user.onboarded,
    createdAt: new Date(user.created_at).getTime(),
    profile: profile ? {
      sex: profile.sex, age: profile.age, heightCm: profile.height_cm, weightKg: profile.weight_kg,
      activity: profile.activity, goal: profile.goal, diet: profile.diet,
      ...(profile.experience ? { experience: profile.experience } : {}),
    } : null,
    targets: targets ? stripNulls({
      calories: targets.calories, protein: targets.protein, carbs: targets.carbs, fat: targets.fat,
      bmr: targets.bmr, tdee: targets.tdee, steps: targets.steps,
    }) : null,
    splitType: user.split_type,
    routine,
    customExercises: customEx.map((e) => ({ id: e.client_id, n: e.name, m: e.muscle, type: e.type })),
    workoutLogs: workouts.map((w) => ({
      id: w.client_id, date: w.date, day: w.day_name,
      exercises: (byWorkout.get(w.id) || []).map((e) => ({ exId: e.exId, sets: e.sets })),
    })),
    mealLogs: meals.map((m) => ({
      uid: m.client_id, date: m.date, meal: m.meal, foodId: m.food_ref, name: m.name,
      servings: m.servings, qtyUnit: m.qty_unit, qtyAmount: m.qty_amount,
      cal: m.calories, p: m.protein, c: m.carbs, f: m.fat, source: m.source,
    })),
    stepLogs: steps.map((s) => ({ date: s.date, steps: s.steps })),
    savedFoods: savedFoods.map((f) => stripNulls({
      id: f.client_id, n: f.name, serving: f.serving, cal: f.calories, p: f.protein, c: f.carbs, f: f.fat,
    })),
    dietPlan: plan ? { items: planItems.map((i) => ({ id: i.item_id, text: i.text })), updatedAt: new Date(plan.updated_at).getTime() } : null,
    dietPlanChecks,
    coachChat: coach.map((m) => ({ id: m.client_id, who: m.who, text: m.text })),
  };
}

function stripNulls(o) {
  Object.keys(o).forEach((k) => { if (o[k] === null) delete o[k]; });
  return o;
}

function rowToSet(r) {
  if (r.set_type === 'dropset') return { type: 'dropset', drops: r.drops };
  if (r.set_type === 'unilateral') {
    return {
      type: 'unilateral',
      left: r.left_reps === null ? null : { reps: r.left_reps, weight: r.left_weight },
      right: r.right_reps === null ? null : { reps: r.right_reps, weight: r.right_weight },
    };
  }
  return { reps: r.reps, weight: r.weight };
}

/* ======================================================================
   WRITE — each function takes a transaction client and validated input
   ====================================================================== */
async function setAccount(c, userId, a) {
  const fields = [];
  const vals = [userId];
  if (a.name !== undefined) { vals.push(v.text(a.name, 'account.name', { max: 80 })); fields.push(`name = $${vals.length}`); }
  if (a.onboarded !== undefined) { vals.push(!!a.onboarded); fields.push(`onboarded = $${vals.length}`); }
  if (a.splitType !== undefined) {
    vals.push(a.splitType === null ? null : v.text(a.splitType, 'account.splitType', { max: 30 }));
    fields.push(`split_type = $${vals.length}`);
  }
  if (!fields.length) return;
  await c.query(`UPDATE app.accounts SET ${fields.join(', ')}, updated_at = now() WHERE id = $1`, vals);
}

async function setProfile(c, userId, p) {
  if (p === null) { await c.query('DELETE FROM app.profiles WHERE user_id = $1', [userId]); return; }
  const x = v.profile(p);
  await c.query(
    `INSERT INTO app.profiles (user_id, sex, age, height_cm, weight_kg, activity, goal, diet, experience, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (user_id) DO UPDATE SET sex=$2, age=$3, height_cm=$4, weight_kg=$5, activity=$6,
       goal=$7, diet=$8, experience=$9, updated_at=now()`,
    [userId, x.sex, x.age, x.heightCm, x.weightKg, x.activity, x.goal, x.diet, x.experience]
  );
}

async function setTargets(c, userId, t) {
  if (t === null) { await c.query('DELETE FROM app.targets WHERE user_id = $1', [userId]); return; }
  const x = v.targets(t);
  await c.query(
    `INSERT INTO app.targets (user_id, calories, protein, carbs, fat, bmr, tdee, steps, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (user_id) DO UPDATE SET calories=$2, protein=$3, carbs=$4, fat=$5, bmr=$6, tdee=$7, steps=$8, updated_at=now()`,
    [userId, x.calories, x.protein, x.carbs, x.fat, x.bmr, x.tdee, x.steps]
  );
}

async function setRoutine(c, userId, r) {
  const days = v.routine(r);
  await c.query('DELETE FROM app.routine_days WHERE user_id = $1', [userId]);
  for (let i = 0; i < days.length; i++) {
    const { rows } = await c.query(
      'INSERT INTO app.routine_days (user_id, name, position) VALUES ($1, $2, $3) RETURNING id',
      [userId, days[i].name, i]
    );
    const exs = days[i].exercises;
    if (exs.length) {
      await c.query(
        `INSERT INTO app.routine_day_exercises (routine_day_id, position, exercise_ref)
         SELECT $1, ord - 1, ref FROM unnest($2::text[]) WITH ORDINALITY AS t(ref, ord)`,
        [rows[0].id, exs]
      );
    }
  }
}

async function upsertCustomExercise(c, userId, e, { onlyInsert = false } = {}) {
  const x = v.customExercise(e);
  const res = await c.query(
    `INSERT INTO app.custom_exercises (user_id, client_id, name, muscle, type) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, client_id) DO ${onlyInsert ? 'NOTHING' : 'UPDATE SET name=$3, muscle=$4, type=$5'}
     RETURNING id`,
    [userId, x.id, x.name, x.muscle, x.type]
  );
  return res.rowCount > 0;
}

async function deleteCustomExercise(c, userId, clientId) {
  await c.query('DELETE FROM app.custom_exercises WHERE user_id = $1 AND client_id = $2', [userId, v.id(clientId, 'id')]);
}

async function upsertWorkout(c, userId, w, { onlyInsert = false } = {}) {
  const x = v.workout(w);
  const { rows } = await c.query(
    `INSERT INTO app.workout_logs (user_id, client_id, date, day_name) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, client_id) DO ${onlyInsert ? 'NOTHING' : 'UPDATE SET date=$3, day_name=$4, updated_at=now()'}
     RETURNING id`,
    [userId, x.id, x.date, x.day]
  );
  if (!rows.length) return false; // already present (import)
  const workoutId = rows[0].id;
  // Replace the exercise/set tree wholesale; it's small and edits are rare.
  await c.query('DELETE FROM app.workout_exercises WHERE workout_id = $1', [workoutId]);
  for (let i = 0; i < x.exercises.length; i++) {
    const e = x.exercises[i];
    const ex = await c.query(
      'INSERT INTO app.workout_exercises (workout_id, position, exercise_ref) VALUES ($1,$2,$3) RETURNING id',
      [workoutId, i, e.exId]
    );
    for (let j = 0; j < e.sets.length; j++) {
      const s = e.sets[j];
      await c.query(
        `INSERT INTO app.workout_sets (workout_exercise_id, position, set_type, reps, weight,
           left_reps, left_weight, right_reps, right_weight, drops)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          ex.rows[0].id, j, s.type,
          s.type === 'normal' ? s.reps : null, s.type === 'normal' ? s.weight : null,
          s.left ? s.left.reps : null, s.left ? s.left.weight : null,
          s.right ? s.right.reps : null, s.right ? s.right.weight : null,
          s.type === 'dropset' ? JSON.stringify(s.drops) : null,
        ]
      );
    }
  }
  return true;
}

async function deleteWorkout(c, userId, clientId) {
  await c.query('DELETE FROM app.workout_logs WHERE user_id = $1 AND client_id = $2', [userId, v.id(clientId, 'id')]);
}

async function upsertMeal(c, userId, m, { onlyInsert = false } = {}) {
  const x = v.meal(m);
  const res = await c.query(
    `INSERT INTO app.meal_logs (user_id, client_id, date, meal, food_ref, name, servings, qty_unit, qty_amount,
       calories, protein, carbs, fat, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (user_id, client_id) DO ${onlyInsert ? 'NOTHING' : `UPDATE SET date=$3, meal=$4, food_ref=$5, name=$6,
       servings=$7, qty_unit=$8, qty_amount=$9, calories=$10, protein=$11, carbs=$12, fat=$13, source=$14`}
     RETURNING id`,
    [userId, x.id, x.date, x.meal, x.foodId, x.name, x.servings, x.qtyUnit, x.qtyAmount, x.cal, x.p, x.c, x.f, x.source]
  );
  return res.rowCount > 0;
}

async function deleteMeal(c, userId, clientId) {
  await c.query('DELETE FROM app.meal_logs WHERE user_id = $1 AND client_id = $2', [userId, v.id(clientId, 'id')]);
}

async function upsertSavedFood(c, userId, f, { onlyInsert = false } = {}) {
  const x = v.savedFood(f);
  const res = await c.query(
    `INSERT INTO app.saved_foods (user_id, client_id, name, serving, calories, protein, carbs, fat)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id, client_id) DO ${onlyInsert ? 'NOTHING' : `UPDATE SET name=$3, serving=$4,
       calories=$5, protein=$6, carbs=$7, fat=$8, updated_at=now()`}
     RETURNING id`,
    [userId, x.id, x.name, x.serving, x.cal, x.p, x.c, x.f]
  );
  return res.rowCount > 0;
}

async function deleteSavedFood(c, userId, clientId) {
  await c.query('DELETE FROM app.saved_foods WHERE user_id = $1 AND client_id = $2', [userId, v.id(clientId, 'id')]);
}

async function setSteps(c, userId, s, { onlyInsert = false } = {}) {
  const date = v.date(s.date, 'steps.date');
  const steps = v.num(s.steps, 'steps.steps', { min: 0, max: 200000, int: true });
  const res = await c.query(
    `INSERT INTO app.step_logs (user_id, date, steps) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, date) DO ${onlyInsert ? 'NOTHING' : 'UPDATE SET steps=$3, updated_at=now()'}
     RETURNING date`,
    [userId, date, steps]
  );
  return res.rowCount > 0;
}

async function setDietPlan(c, userId, p) {
  await c.query('DELETE FROM app.diet_plans WHERE user_id = $1', [userId]);
  if (p === null) return;
  const x = v.dietPlan(p);
  await c.query('INSERT INTO app.diet_plans (user_id) VALUES ($1)', [userId]);
  if (x.items.length) {
    await c.query(
      `INSERT INTO app.diet_plan_items (user_id, item_id, position, text)
       SELECT $1, t.item_id, t.ord - 1, t.text
       FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS t(item_id, text, ord)`,
      [userId, x.items.map((i) => i.id), x.items.map((i) => i.text)]
    );
  }
}

async function setDietPlanCheck(c, userId, ch, { onlyInsert = false } = {}) {
  const date = v.date(ch.date, 'dietPlanCheck.date');
  const itemId = v.id(ch.itemId, 'dietPlanCheck.itemId');
  const res = await c.query(
    `INSERT INTO app.diet_plan_checks (user_id, date, item_id, checked) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, date, item_id) DO ${onlyInsert ? 'NOTHING' : 'UPDATE SET checked=$4'}
     RETURNING date`,
    [userId, date, itemId, !!ch.checked]
  );
  return res.rowCount > 0;
}

async function appendCoachMessage(c, userId, m) {
  const x = v.coachMessage(m);
  const res = await c.query(
    `INSERT INTO app.coach_messages (user_id, client_id, seq, who, text)
     VALUES ($1, $2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM app.coach_messages WHERE user_id = $1), $3, $4)
     ON CONFLICT (user_id, client_id) DO NOTHING RETURNING id`,
    [userId, x.id, x.who, x.text]
  );
  return res.rowCount > 0;
}

async function clearCoach(c, userId) {
  await c.query('DELETE FROM app.coach_messages WHERE user_id = $1', [userId]);
}

/* ---------------- sync ops ---------------- */
const OPS = {
  'account.set': (c, u, op) => setAccount(c, u, v.obj(op.data, 'data')),
  'profile.set': (c, u, op) => setProfile(c, u, op.data === null ? null : op.data),
  'targets.set': (c, u, op) => setTargets(c, u, op.data === null ? null : op.data),
  'routine.set': (c, u, op) => setRoutine(c, u, op.data),
  'customExercise.upsert': (c, u, op) => upsertCustomExercise(c, u, op.data),
  'customExercise.delete': (c, u, op) => deleteCustomExercise(c, u, op.id),
  'workout.upsert': (c, u, op) => upsertWorkout(c, u, op.data),
  'workout.delete': (c, u, op) => deleteWorkout(c, u, op.id),
  'meal.upsert': (c, u, op) => upsertMeal(c, u, op.data),
  'meal.delete': (c, u, op) => deleteMeal(c, u, op.id),
  'steps.set': (c, u, op) => setSteps(c, u, v.obj(op.data, 'data')),
  'savedFood.upsert': (c, u, op) => upsertSavedFood(c, u, op.data),
  'savedFood.delete': (c, u, op) => deleteSavedFood(c, u, op.id),
  'dietPlan.set': (c, u, op) => setDietPlan(c, u, op.data === null ? null : op.data),
  'dietPlanCheck.set': (c, u, op) => setDietPlanCheck(c, u, v.obj(op.data, 'data')),
  'coach.append': (c, u, op) => appendCoachMessage(c, u, op.data),
  'coach.clear': (c, u) => clearCoach(c, u),
};

async function applyOp(c, userId, op, index) {
  if (!op || typeof op !== 'object' || !OPS[op.type]) {
    throw new v.ValidationError(`ops[${index}]: unknown operation type`);
  }
  try {
    await OPS[op.type](c, userId, op);
  } catch (err) {
    if (err instanceof v.ValidationError) err.message = `ops[${index}] (${op.type}) ${err.message}`;
    throw err;
  }
}

export {
  loadState, applyOp, OPS, setAccount, setProfile, setTargets, setRoutine, upsertCustomExercise, upsertWorkout, upsertMeal, setSteps, upsertSavedFood, setDietPlan, setDietPlanCheck, appendCoachMessage,
};
