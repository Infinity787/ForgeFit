// Talks to Supabase Auth from the server: checks access tokens, signs in by
// username (the app only knows the username, the server looks up the email),
// and deletes accounts. Keys come from the Edge Function's environment and
// never reach the app.

export function createSupabaseAuth({ url, anonKey, serviceKey, fetchImpl = globalThis.fetch }) {
  const base = url.replace(/\/+$/, '') + '/auth/v1';
  const cache = new Map(); // token -> { user, until }

  return {
    /**
     * Returns { id, email } for a valid, still-active session, else null.
     * Asking Auth (rather than only checking the signature) means sessions
     * that were signed out, or belong to a deleted account, stop working.
     */
    async verifyUser(token) {
      if (!token) return null;
      const hit = cache.get(token);
      if (hit && hit.until > Date.now()) return hit.user;
      const res = await fetchImpl(base + '/user', { headers: { apikey: anonKey, Authorization: 'Bearer ' + token } });
      if (!res.ok) return null;
      const u = await res.json();
      if (!u || !u.id) return null;
      const user = { id: u.id, email: (u.email || '').toLowerCase() };
      if (cache.size > 500) cache.clear();
      cache.set(token, { user, until: Date.now() + 30000 });
      return user;
    },

    /** Email + password sign-in. Returns the session, or null for bad credentials. */
    async passwordLogin(email, password) {
      const res = await fetchImpl(base + '/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.status === 400 || res.status === 401) return null;
      if (!res.ok) {
        const e = new Error('Sign-in is unavailable right now. Please try again.');
        e.status = res.status === 429 ? 429 : 502;
        e.expose = true;
        throw e;
      }
      return res.json();
    },

    async deleteUser(id) {
      const res = await fetchImpl(base + '/admin/users/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
      });
      if (!res.ok && res.status !== 404) {
        const e = new Error('Couldn’t delete the account right now. Please try again.');
        e.status = 502;
        e.expose = true;
        throw e;
      }
    },
  };
}
