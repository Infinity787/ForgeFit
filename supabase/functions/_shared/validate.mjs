// Shared by the Supabase Edge Function and the Node test suite.
/*
 * Server-side validation for app data coming from the client. Every value is
 * checked and normalised here before it reaches SQL, and anything malformed
 * is rejected with a 400 that names the offending field.
 */

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true;
  }
}

function fail(path, msg) {
  throw new ValidationError(`${path}: ${msg}`);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function date(v, path) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) fail(path, 'must be a YYYY-MM-DD date');
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) fail(path, 'is not a real date');
  if (v < '2000-01-01' || v > '2100-12-31') fail(path, 'is out of range');
  return v;
}

function text(v, path, { max = 200, min = 1, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    if (min > 0) fail(path, 'is required');
  }
  if (typeof v !== 'string') fail(path, 'must be text');
  const s = v.trim();
  if (s.length < min) fail(path, 'is required');
  if (s.length > max) fail(path, `must be at most ${max} characters`);
  return s;
}

function num(v, path, { min = 0, max = 1e6, int = false, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    fail(path, 'is required');
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(path, 'must be a number');
  if (n < min || n > max) fail(path, `must be between ${min} and ${max}`);
  return int ? Math.round(n) : n;
}

function oneOf(v, path, allowed, { optional = false } = {}) {
  if ((v === undefined || v === null) && optional) return null;
  if (!allowed.includes(v)) fail(path, `must be one of ${allowed.join(', ')}`);
  return v;
}

function obj(v, path) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(path, 'must be an object');
  return v;
}

function arr(v, path, max) {
  if (!Array.isArray(v)) fail(path, 'must be a list');
  if (v.length > max) fail(path, `has too many entries (max ${max})`);
  return v;
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
function id(v, path) {
  if (typeof v !== 'string' || !ID_RE.test(v)) fail(path, 'is not a valid id');
  return v;
}

/* ---------------- domain shapes (client JSON -> normalised) ---------------- */

function profile(p, path = 'profile') {
  obj(p, path);
  return {
    sex: oneOf(p.sex, `${path}.sex`, ['male', 'female']),
    age: num(p.age, `${path}.age`, { min: 10, max: 120, int: true }),
    heightCm: num(p.heightCm, `${path}.heightCm`, { min: 50, max: 300 }),
    weightKg: num(p.weightKg, `${path}.weightKg`, { min: 20, max: 400 }),
    activity: String(num(p.activity, `${path}.activity`, { min: 1, max: 2.5 })),
    goal: oneOf(p.goal, `${path}.goal`, ['cut', 'maintain', 'bulk']),
    diet: oneOf(p.diet, `${path}.diet`, ['veg', 'nonveg']),
    experience: text(p.experience, `${path}.experience`, { max: 20, optional: true }),
  };
}

function targets(t, path = 'targets') {
  obj(t, path);
  const n = (k, max) => num(t[k], `${path}.${k}`, { min: 0, max, int: true });
  const o = (k, max) => num(t[k], `${path}.${k}`, { min: 0, max, int: true, optional: true });
  return {
    calories: n('calories', 20000), protein: n('protein', 2000), carbs: n('carbs', 4000), fat: n('fat', 2000),
    bmr: o('bmr', 20000), tdee: o('tdee', 30000), steps: o('steps', 200000),
  };
}

function exerciseRef(v, path) { return id(v, path); }

function routine(r, path = 'routine') {
  obj(r, path);
  const days = Object.keys(r);
  if (days.length > 14) fail(path, 'has too many days (max 14)');
  return days.map((name, i) => {
    const dayName = text(name, `${path} day ${i + 1} name`, { max: 60 });
    const ex = arr(r[name], `${path}.${name}`, 60).map((e, j) => exerciseRef(e, `${path}.${name}[${j}]`));
    return { name: dayName, exercises: Array.from(new Set(ex)) };
  });
}

function customExercise(e, path = 'customExercise') {
  obj(e, path);
  return {
    id: id(e.id, `${path}.id`),
    name: text(e.n, `${path}.name`, { max: 80 }),
    muscle: text(e.m, `${path}.muscle`, { max: 30 }),
    type: text(e.type || 'Custom', `${path}.type`, { max: 20 }),
  };
}

function repWeight(x, path) {
  obj(x, path);
  return {
    reps: num(x.reps, `${path}.reps`, { min: 0, max: 1000, int: true }),
    weight: num(x.weight, `${path}.weight`, { min: 0, max: 2000 }),
  };
}

function workoutSet(s, path) {
  obj(s, path);
  if (s.type === 'dropset') {
    const drops = arr(s.drops, `${path}.drops`, 10).map((d, i) => repWeight(d, `${path}.drops[${i}]`));
    if (!drops.length) fail(`${path}.drops`, 'needs at least one drop');
    return { type: 'dropset', drops };
  }
  if (s.type === 'unilateral') {
    const left = s.left ? repWeight(s.left, `${path}.left`) : null;
    const right = s.right ? repWeight(s.right, `${path}.right`) : null;
    if (!left && !right) fail(path, 'needs a left or right side');
    return { type: 'unilateral', left, right };
  }
  if (s.type !== undefined && s.type !== 'normal') fail(`${path}.type`, 'is unknown');
  return { type: 'normal', ...repWeight(s, path) };
}

function workout(w, path = 'workout') {
  obj(w, path);
  const exercises = arr(w.exercises, `${path}.exercises`, 60).map((e, i) => {
    const p = `${path}.exercises[${i}]`;
    obj(e, p);
    return {
      exId: exerciseRef(e.exId, `${p}.exId`),
      sets: arr(e.sets, `${p}.sets`, 50).map((s, j) => workoutSet(s, `${p}.sets[${j}]`)),
    };
  });
  return {
    id: id(w.id, `${path}.id`),
    date: date(w.date, `${path}.date`),
    day: text(w.day, `${path}.day`, { max: 60 }),
    exercises,
  };
}

const MEAL_SOURCES = ['library', 'custom', 'online', 'photo', 'idea', 'manual', 'import'];
function meal(m, path = 'meal') {
  obj(m, path);
  return {
    id: id(m.uid, `${path}.uid`),
    date: date(m.date, `${path}.date`),
    meal: text(m.meal, `${path}.meal`, { max: 30 }),
    foodId: m.foodId == null ? null : id(String(m.foodId), `${path}.foodId`),
    name: text(m.name, `${path}.name`, { max: 200 }),
    servings: num(m.servings == null ? 1 : m.servings, `${path}.servings`, { min: 0, max: 1000 }),
    qtyUnit: text(m.qtyUnit, `${path}.qtyUnit`, { max: 20, optional: true }),
    qtyAmount: num(m.qtyAmount, `${path}.qtyAmount`, { min: 0, max: 100000, optional: true }),
    cal: num(m.cal, `${path}.cal`, { min: 0, max: 20000 }),
    p: num(m.p, `${path}.p`, { min: 0, max: 2000 }),
    c: num(m.c, `${path}.c`, { min: 0, max: 4000 }),
    f: num(m.f, `${path}.f`, { min: 0, max: 2000 }),
    source: m.source == null ? 'manual' : oneOf(m.source, `${path}.source`, MEAL_SOURCES),
  };
}

function savedFood(f, path = 'savedFood') {
  obj(f, path);
  return {
    id: id(f.id, `${path}.id`),
    name: text(f.n, `${path}.name`, { max: 120 }),
    serving: text(f.serving, `${path}.serving`, { max: 60, optional: true }),
    cal: num(f.cal, `${path}.cal`, { min: 0, max: 20000 }),
    p: num(f.p, `${path}.p`, { min: 0, max: 2000 }),
    c: num(f.c == null ? 0 : f.c, `${path}.c`, { min: 0, max: 4000 }),
    f: num(f.f == null ? 0 : f.f, `${path}.f`, { min: 0, max: 2000 }),
  };
}

function dietPlan(p, path = 'dietPlan') {
  obj(p, path);
  const items = arr(p.items, `${path}.items`, 100).map((it, i) => {
    obj(it, `${path}.items[${i}]`);
    return { id: id(it.id, `${path}.items[${i}].id`), text: text(it.text, `${path}.items[${i}].text`, { max: 300 }) };
  });
  const seen = new Set();
  items.forEach((it) => { if (seen.has(it.id)) fail(path, `duplicate item id ${it.id}`); seen.add(it.id); });
  return { items };
}

function coachMessage(m, path = 'coachMessage') {
  obj(m, path);
  return {
    id: id(m.id, `${path}.id`),
    who: oneOf(m.who, `${path}.who`, ['user', 'coach']),
    text: text(m.text, `${path}.text`, { max: 8000 }),
  };
}

export {
  fail, date, text, num, oneOf, obj, arr, id, profile, targets, routine, customExercise, workout, meal, savedFood, dietPlan, coachMessage,
};
