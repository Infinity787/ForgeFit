// AI helpers (prompts, response schemas, image checks), shared by the
// Supabase Edge Function and the Node test suite.
import * as gemini from './gemini.mjs';

export const round1 = (n) => Math.round(n * 10) / 10;
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+n) ? +n : 0));

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

/** Confirms the bytes really are the image type claimed (not just the header). */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const ascii = (a, b) => String.fromCharCode(...buf.slice(a, b));
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => buf[i] === x)) return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
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
export const PHOTO_SCHEMA = {
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
    packaged: {
      type: 'OBJECT',
      properties: {
        is_packaged: { type: 'BOOLEAN' },
        brand: { type: 'STRING' },
        product_name: { type: 'STRING' },
        variant: { type: 'STRING' },
        unit: { type: 'STRING', enum: ['g', 'ml'] },
        net_quantity: { type: 'NUMBER' },
        serving_size: { type: 'NUMBER' },
        values_source: { type: 'STRING', enum: ['label', 'known'] },
        per_100: NUTRIENTS,
      },
      required: ['is_packaged'],
    },
  },
  required: ['is_food', 'image_quality', 'dish_name', 'items', 'confidence'],
};

export const PHOTO_PROMPT = `You are a careful sports nutritionist estimating the nutrition of a meal from a single photo.
Identify each distinct food item visible, estimate its portion (in everyday terms AND grams), and estimate calories (kcal), protein, carbs and fat (grams) for THAT portion.
Rules:
- Base estimates on typical recipes; assume common home/restaurant preparation unless clearly visible otherwise (e.g. fried vs grilled).
- Use visual cues (plate size, utensils, hands) to judge portion size. If there are no cues, assume a standard single serving and say so in "assumptions".
- If the image does not show food, set is_food=false and items=[].
- If the photo is too dark, blurry, cropped or obstructed to judge, set image_quality="poor" and explain briefly in quality_note.
- confidence reflects how sure you are about the portion and ingredients overall.
- Keep names short (e.g. "Paneer butter masala", "Steamed basmati rice").
- Numbers must be realistic for the portion.
Packaged products (a bar, packet, can, bottle, tub, box, pouch...):
- Set packaged.is_packaged=true and identify the exact product from the packaging: brand, product_name and variant/flavour (e.g. brand "Amul", product_name "High Protein Milk", variant "Chocolate"). Only use words you can read on the pack; leave a field empty if it isn't visible. Never guess a brand.
- unit is "g" for solids and "ml" for drinks. net_quantity is the pack size printed on it (e.g. 200 for "200 ml"); serving_size is the label's serving size if printed.
- per_100 is the nutrition per 100 g or 100 ml. If the nutrition table is readable, copy it (converting per-serving values to per 100) and set values_source="label". Otherwise use the known values for that exact product and set values_source="known".
- Still fill items/dish_name with the whole pack as one item.
For a plate of food that isn't a packaged product, set packaged.is_packaged=false.`;

export function normalisePhotoEstimate(raw) {
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
    packaged: normalisePackaged(raw && raw.packaged),
    model: gemini.MODEL,
  };
}

/** Packaged product with per-100 g/ml values, or null if it isn't one. */
function normalisePackaged(p) {
  if (!p || !p.is_packaged || !p.per_100) return null;
  const txt = (x) => String(x || '').trim().slice(0, 60);
  const name = txt(p.product_name);
  if (!name) return null;
  const qty = (x) => (Number(x) > 0 ? Math.round(clamp(x, 0, 10000)) : null);
  const n = p.per_100;
  return {
    brand: txt(p.brand),
    name,
    variant: txt(p.variant),
    unit: p.unit === 'ml' ? 'ml' : 'g',
    netQuantity: qty(p.net_quantity),
    servingSize: qty(p.serving_size),
    fromLabel: p.values_source === 'label',
    per100: {
      calories: Math.round(clamp(n.calories, 0, 900)),
      protein: round1(clamp(n.protein, 0, 100)),
      carbs: round1(clamp(n.carbs, 0, 100)),
      fat: round1(clamp(n.fat, 0, 100)),
    },
  };
}

export const COACH_PERSONA = `You are Coach Byte, an experienced, practical fitness coach inside the ForgeFit app. Speak like a knowledgeable training partner: direct, specific, warm, never corporate. No "As an AI" disclaimers. Ground advice in the user's real data provided below. Keep replies to 2-4 sentences unless asked for detail. You may use <b>bold</b> for key numbers; no other HTML or markdown. You are not a doctor: for pain, injury, illness or medical conditions, recommend a qualified professional.`;
