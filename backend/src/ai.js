const express = require('express');
const multer = require('multer');
const gemini = require('./gemini');
const v = require('./validate');
const { requireAuth, wrap, aiLimiter } = require('./middleware');

const router = express.Router();
router.use(requireAuth, aiLimiter);

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+n) ? +n : 0));

/* ======================================================================
   POST /api/ai/food-photo — estimate calories/macros from a meal photo.

   Retention: the photo is held in memory only for the duration of this
   request (multer memoryStorage — never written to disk), forwarded once to
   Gemini, then dropped. It is never logged or stored in the database.
   ====================================================================== */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 4 },
  fileFilter: (req, file, cb) => {
    if (!PHOTO_TYPES.includes(file.mimetype)) {
      return cb(new v.ValidationError('Unsupported file type. Use a JPEG, PNG, WebP or HEIC photo.'));
    }
    cb(null, true);
  },
});

/** Confirms the bytes really are the image type claimed (not just the header). */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'heim', 'heis'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1'].includes(brand)) return 'image/heif';
  }
  return null;
}

const NUTRIENTS = {
  type: 'OBJECT',
  properties: {
    calories: { type: 'NUMBER' }, protein: { type: 'NUMBER' }, carbs: { type: 'NUMBER' }, fat: { type: 'NUMBER' },
  },
  required: ['calories', 'protein', 'carbs', 'fat'],
};
const PHOTO_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_food: { type: 'BOOLEAN' },
    image_quality: { type: 'STRING', enum: ['good', 'fair', 'poor'] },
    quality_note: { type: 'STRING' },
    dish_name: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          portion: { type: 'STRING' },
          grams: { type: 'NUMBER' },
          ...NUTRIENTS.properties,
        },
        required: ['name', 'portion', 'calories', 'protein', 'carbs', 'fat'],
      },
    },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
    assumptions: { type: 'STRING' },
  },
  required: ['is_food', 'image_quality', 'dish_name', 'items', 'confidence'],
};

const PHOTO_PROMPT = `You are a careful sports nutritionist estimating the nutrition of a meal from a single photo.
Identify each distinct food item visible, estimate its portion (in everyday terms AND grams), and estimate calories (kcal), protein, carbs and fat (grams) for THAT portion.
Rules:
- Base estimates on typical recipes; assume common home/restaurant preparation unless clearly visible otherwise (e.g. fried vs grilled).
- Use visual cues (plate size, utensils, hands) to judge portion size. If there are no cues, assume a standard single serving and say so in "assumptions".
- If the image does not show food, set is_food=false and items=[].
- If the photo is too dark, blurry, cropped or obstructed to judge, set image_quality="poor" and explain briefly in quality_note.
- confidence reflects how sure you are about the portion and ingredients overall.
- Keep names short (e.g. "Paneer butter masala", "Steamed basmati rice").
- Never invent brand names. Numbers must be realistic for the portion.`;

router.post('/food-photo', (req, res, next) => {
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That photo is too large (max 8 MB).' : 'Couldn’t read the upload.';
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: msg });
    }
    return next(err);
  });
}, wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a photo of your meal.' });
  const mime = sniffImage(req.file.buffer);
  if (!mime) {
    req.file.buffer = null;
    return res.status(415).json({ error: 'That file isn’t a supported image. Use a JPEG, PNG, WebP or HEIC photo.' });
  }
  const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 200) : '';

  // Cancel the upstream call if the app disconnects (user pressed Cancel).
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });

  let raw;
  try {
    raw = await gemini.generateJson({
      schema: PHOTO_SCHEMA,
      temperature: 0.2,
      signal: abort.signal,
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: mime, data: req.file.buffer.toString('base64') } },
          { text: PHOTO_PROMPT + (note ? `\nThe user adds this context: "${note.replace(/"/g, "'")}"` : '') },
        ],
      }],
    });
  } finally {
    req.file.buffer = null; // drop the photo as soon as the upstream call is done
  }
  if (abort.signal.aborted) return;

  res.json({ ok: true, estimate: normalisePhotoEstimate(raw) });
}));

function normalisePhotoEstimate(raw) {
  const items = (Array.isArray(raw && raw.items) ? raw.items : []).slice(0, 12).map((it) => ({
    name: String(it.name || 'Food item').slice(0, 80),
    portion: String(it.portion || '').slice(0, 80),
    grams: it.grams == null ? null : Math.round(clamp(it.grams, 0, 5000)),
    calories: Math.round(clamp(it.calories, 0, 5000)),
    protein: round1(clamp(it.protein, 0, 500)),
    carbs: round1(clamp(it.carbs, 0, 1000)),
    fat: round1(clamp(it.fat, 0, 500)),
  }));
  // Totals are recomputed from the items so they always add up.
  const total = items.reduce((t, i) => ({
    calories: t.calories + i.calories, protein: round1(t.protein + i.protein),
    carbs: round1(t.carbs + i.carbs), fat: round1(t.fat + i.fat),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const quality = ['good', 'fair', 'poor'].includes(raw && raw.image_quality) ? raw.image_quality : 'fair';
  return {
    isFood: !!(raw && raw.is_food) && items.length > 0,
    imageQuality: quality,
    qualityNote: String((raw && raw.quality_note) || '').slice(0, 300),
    dishName: String((raw && raw.dish_name) || (items[0] && items[0].name) || 'Meal').slice(0, 80),
    items,
    total,
    confidence: ['low', 'medium', 'high'].includes(raw && raw.confidence) ? raw.confidence : 'low',
    assumptions: String((raw && raw.assumptions) || '').slice(0, 400),
    model: gemini.MODEL,
  };
}

/* ======================================================================
   POST /api/ai/food-search — macros per 100 g for a typed food name.
   ====================================================================== */
const SEARCH_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING' },
      cal: { type: 'NUMBER' }, p: { type: 'NUMBER' }, c: { type: 'NUMBER' }, f: { type: 'NUMBER' },
    },
    required: ['name', 'cal', 'p', 'c', 'f'],
  },
};

router.post('/food-search', wrap(async (req, res) => {
  const query = v.text(req.body.query, 'query', { max: 100 });
  const raw = await gemini.generateJson({
    schema: SEARCH_SCHEMA,
    temperature: 0.2,
    contents: [{ role: 'user', parts: [{ text: `For the food "${query.replace(/"/g, "'")}", list up to 5 closely related food items with typical nutrition per 100 g: name, cal (kcal), p (protein g), c (carbs g), f (fat g). Give realistic best estimates.` }] }],
  });
  const results = (Array.isArray(raw) ? raw : []).slice(0, 5)
    .filter((r) => r && r.name)
    .map((r) => ({
      name: String(r.name).slice(0, 80),
      cal: Math.round(clamp(r.cal, 0, 1000)),
      p: round1(clamp(r.p, 0, 100)), c: round1(clamp(r.c, 0, 100)), f: round1(clamp(r.f, 0, 100)),
    }));
  res.json({ ok: true, results });
}));

/* ======================================================================
   POST /api/ai/coach — Coach chat reply grounded in the user's own logs.
   The client sends a compact summary of its data plus recent history.
   ====================================================================== */
const COACH_PERSONA = `You are Coach Byte, an experienced, practical fitness coach inside the ForgeFit app. Speak like a knowledgeable training partner: direct, specific, warm, never corporate. No "As an AI" disclaimers. Ground advice in the user's real data provided below. Keep replies to 2-4 sentences unless asked for detail. You may use <b>bold</b> for key numbers; no other HTML or markdown. You are not a doctor: for pain, injury, illness or medical conditions, recommend a qualified professional.`;

router.post('/coach', wrap(async (req, res) => {
  const message = v.text(req.body.message, 'message', { max: 2000 });
  const context = v.text(req.body.context || '', 'context', { max: 6000, min: 0, optional: true }) || '';
  const history = v.arr(req.body.history || [], 'history', 12).map((m, i) => ({
    role: m && m.who === 'user' ? 'user' : 'model',
    parts: [{ text: v.text(String((m && m.text) || '').replace(/<[^>]*>/g, ''), `history[${i}].text`, { max: 4000 }) }],
  }));
  // Gemini requires the conversation to start with a user turn.
  while (history.length && history[0].role !== 'user') history.shift();
  history.push({ role: 'user', parts: [{ text: message }] });

  const reply = await gemini.generate({
    system: `${COACH_PERSONA}\n\nUser data:\n${context}`,
    contents: history,
    temperature: 0.7,
  });
  res.json({ ok: true, reply: reply.trim().slice(0, 4000) });
}));

module.exports = router;
module.exports.sniffImage = sniffImage;
module.exports.normalisePhotoEstimate = normalisePhotoEstimate;
