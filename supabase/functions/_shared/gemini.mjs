// Shared by the Supabase Edge Function and the Node test suite.
/*
 * Minimal Google Gemini client. The API key stays on the server (sent as a
 * header, never in a URL, never logged).
 */
import { env } from './env.mjs';
const API_BASE = () => env('GEMINI_API_BASE') || 'https://generativelanguage.googleapis.com/v1beta';
export const MODEL = env('GEMINI_MODEL') || 'gemini-2.5-flash';
const TIMEOUT_MS = () => Number(env('GEMINI_TIMEOUT_MS') || 45000);

export class AiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 502;
    this.expose = true;
  }
}

export function configured() {
  return !!env('GEMINI_API_KEY');
}

/**
 * Calls generateContent. `signal` lets the caller cancel (e.g. when the app
 * aborts the upload). Returns the first candidate's text.
 */
export async function generate({ system, contents, schema, temperature = 0.4, signal }) {
  if (!configured()) throw new AiError('AI features aren’t configured on the server yet.', 503);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), TIMEOUT_MS());
  const onAbort = () => controller.abort(new Error('cancelled'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const body = {
    contents,
    generationConfig: {
      temperature,
      ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
    },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };

  let res;
  try {
    res = await globalThis.fetch(`${API_BASE()}/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env('GEMINI_API_KEY') },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (signal && signal.aborted) throw new AiError('Request cancelled.', 499);
    if (controller.signal.aborted) throw new AiError('The AI service took too long to respond. Try again.', 504);
    throw new AiError('Couldn’t reach the AI service. Try again shortly.', 502);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
    // Log status only — upstream bodies can echo request content.
    console.error(`[ai] Gemini responded ${res.status}`);
    if (res.status === 429) throw new AiError('The AI service is busy right now. Try again in a minute.', 503);
    if (res.status === 400) throw new AiError('The AI service couldn’t process that request.', 422);
    throw new AiError('The AI service had a problem. Try again shortly.', 502);
  }

  const data = await res.json().catch(() => ({}));
  const cand = data.candidates && data.candidates[0];
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new AiError('The AI service declined to process that content.', 422);
  }
  const text = cand && cand.content && cand.content.parts
    ? cand.content.parts.map((p) => p.text || '').join('')
    : '';
  if (!text) throw new AiError('The AI service returned an empty response. Try again.', 502);
  return text;
}

export async function generateJson(opts) {
  const text = await generate(opts);
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = text.match(/[[{][\s\S]*[\]}]/);
    if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fall through */ } }
    throw new AiError('The AI service returned an unreadable response. Try again.', 502);
  }
}

