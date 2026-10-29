// Reads configuration from Deno.env on Supabase, process.env under Node (tests).
export function env(name) {
  if (typeof Deno !== 'undefined' && Deno.env) return Deno.env.get(name);
  return globalThis.process ? globalThis.process.env[name] : undefined;
}
