const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, db, request, resetDb, createUser, auth } = require('./helpers');

const realFetch = globalThis.fetch;
let calls = [];
let nextResponse = null;

/** Stubs Gemini: records each call and replies with `nextResponse`. */
function stubGemini() {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    const r = typeof nextResponse === 'function' ? nextResponse() : nextResponse;
    if (r.throw) throw r.throw;
    return {
      ok: r.status === 200,
      status: r.status,
      json: async () => ({ candidates: [{ content: { parts: [{ text: typeof r.text === 'string' ? r.text : JSON.stringify(r.text) }] } }] }),
    };
  };
}

let user;
before(async () => { await resetDb(); user = await createUser('ai'); stubGemini(); });
beforeEach(() => { calls = []; });
after(async () => { globalThis.fetch = realFetch; await db.close(); });

// Smallest valid JPEG header bytes + padding (the server sniffs magic bytes).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]), Buffer.alloc(2048, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.alloc(512, 1)]);

const photo = (buf, name = 'meal.jpg', type = 'image/jpeg') =>
  request(app).post('/api/ai/food-photo').set(auth(user.token)).attach('photo', buf, { filename: name, contentType: type });

const GOOD_ESTIMATE = {
  is_food: true, image_quality: 'good', quality_note: '', dish_name: 'Dal chawal',
  items: [
    { name: 'Steamed rice', portion: '1 cup', grams: 180, calories: 234, protein: 4.3, carbs: 51.6, fat: 0.5 },
    { name: 'Toor dal', portion: '1 bowl', grams: 200, calories: 230, protein: 13.2, carbs: 34.1, fat: 4.4 },
  ],
  total: { calories: 9999, protein: 1, carbs: 1, fat: 1 }, // deliberately wrong: server recomputes
  confidence: 'medium', assumptions: 'Assumed home-style dal with a little ghee.',
};

test('food photo returns a normalised estimate with totals recomputed from items', async () => {
  nextResponse = { status: 200, text: GOOD_ESTIMATE };
  const res = await photo(JPEG);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const e = res.body.estimate;
  assert.equal(e.isFood, true);
  assert.equal(e.dishName, 'Dal chawal');
  assert.equal(e.items.length, 2);
  assert.deepEqual(e.total, { calories: 464, protein: 17.5, carbs: 85.7, fat: 4.9 });
  assert.equal(e.confidence, 'medium');

  // The key travels in a header, never the URL; the photo is sent inline.
  const call = calls[0];
  assert.ok(!call.url.includes('test-gemini-key'));
  assert.equal(call.opts.headers['x-goog-api-key'], 'test-gemini-key');
  const inline = call.body.contents[0].parts[0].inline_data;
  assert.equal(inline.mime_type, 'image/jpeg');
  assert.equal(Buffer.from(inline.data, 'base64').length, JPEG.length);
  assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
});

test('food photo does not write anything to the meal log by itself', async () => {
  nextResponse = { status: 200, text: GOOD_ESTIMATE };
  await photo(JPEG);
  const s = (await request(app).get('/api/data').set(auth(user.token))).body.state;
  assert.deepEqual(s.mealLogs, []);
});

test('non-food and poor-quality photos are reported, not guessed', async () => {
  nextResponse = { status: 200, text: { is_food: false, image_quality: 'good', dish_name: '', items: [], confidence: 'low' } };
  const notFood = await photo(JPEG);
  assert.equal(notFood.body.estimate.isFood, false);

  nextResponse = { status: 200, text: { is_food: true, image_quality: 'poor', quality_note: 'Too dark to see the food.', dish_name: 'Unclear', items: [{ name: 'Curry', portion: '1 bowl', calories: 300, protein: 10, carbs: 20, fat: 18 }], confidence: 'low' } };
  const poor = await photo(PNG, 'meal.png', 'image/png');
  assert.equal(poor.status, 200);
  assert.equal(poor.body.estimate.imageQuality, 'poor');
  assert.match(poor.body.estimate.qualityNote, /dark/);
});

test('rejects unsupported, spoofed, missing and oversized uploads', async () => {
  const gif = await photo(Buffer.from('GIF89a........'), 'a.gif', 'image/gif');
  assert.equal(gif.status, 400);
  assert.match(gif.body.error, /Unsupported/);

  const spoofed = await photo(Buffer.from('this is a text file pretending to be a jpeg'), 'x.jpg', 'image/jpeg');
  assert.equal(spoofed.status, 415);

  const none = await request(app).post('/api/ai/food-photo').set(auth(user.token));
  assert.equal(none.status, 400);

  const huge = await photo(Buffer.concat([JPEG, Buffer.alloc(8 * 1024 * 1024)]));
  assert.equal(huge.status, 413);
  assert.equal(calls.length, 0, 'invalid uploads never reach the AI service');
});

test('maps AI service failures to clear errors', async () => {
  nextResponse = { status: 429, text: '' };
  const busy = await photo(JPEG);
  assert.equal(busy.status, 503);
  assert.match(busy.body.error, /busy/);

  nextResponse = { status: 500, text: '' };
  assert.equal((await photo(JPEG)).status, 502);

  nextResponse = { throw: new Error('ECONNRESET') };
  const down = await photo(JPEG);
  assert.equal(down.status, 502);

  nextResponse = { status: 200, text: 'not json at all' };
  assert.equal((await photo(JPEG)).status, 502);
});

test('reports when AI is not configured', async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const res = await photo(JPEG);
    assert.equal(res.status, 503);
    assert.match(res.body.error, /configured/);
  } finally {
    process.env.GEMINI_API_KEY = saved;
  }
});

test('AI endpoints require a session', async () => {
  const res = await request(app).post('/api/ai/food-photo').attach('photo', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });
  assert.equal(res.status, 401);
  assert.equal((await request(app).post('/api/ai/coach').send({ message: 'hi' })).status, 401);
});

test('food search returns clamped per-100g results', async () => {
  nextResponse = { status: 200, text: [{ name: 'Paneer', cal: 265, p: 18.3, c: 1.2, f: 20.8 }, { name: 'Bad', cal: 99999, p: -3, c: 2, f: 1 }] };
  const res = await request(app).post('/api/ai/food-search').set(auth(user.token)).send({ query: 'paneer' });
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].name, 'Paneer');
  assert.equal(res.body.results[1].cal, 1000);
  assert.equal(res.body.results[1].p, 0);
  assert.equal((await request(app).post('/api/ai/food-search').set(auth(user.token)).send({ query: '' })).status, 400);
});

test('coach proxies chat with the persona server-side and history starting on a user turn', async () => {
  nextResponse = { status: 200, text: 'Solid week — <b>4 sessions</b>.' };
  const res = await request(app).post('/api/ai/coach').set(auth(user.token)).send({
    message: 'How was my week?',
    context: 'Streak: 3 days',
    history: [{ who: 'coach', text: 'Hey <b>there</b>' }, { who: 'user', text: 'Hi' }, { who: 'coach', text: 'Hello!' }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.reply, 'Solid week — <b>4 sessions</b>.');
  const body = calls[0].body;
  assert.match(body.systemInstruction.parts[0].text, /Coach Byte/);
  assert.match(body.systemInstruction.parts[0].text, /Streak: 3 days/);
  assert.equal(body.contents[0].role, 'user');
  assert.equal(body.contents[body.contents.length - 1].parts[0].text, 'How was my week?');
});
