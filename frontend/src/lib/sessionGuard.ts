/**
 * Console session-expiry guard — the ONE place a dead console session becomes
 * the login view.
 *
 * When `webAuth` is active, the gateway answers **401 `console_auth_required`**
 * for every `/api/admin/*` request whose session cookie is missing or expired
 * (backend/src/server.ts, the webAuth gate). Without this guard each page
 * turned that into its own generic `HTTP 401` failure — an empty table, a toast,
 * a stuck spinner — and the operator stayed on a console that could not do
 * anything until a manual reload. The App-level gate only probes the session
 * once, at boot.
 *
 * The discriminator is the error CODE, not the path: `/api/admin/*` also
 * answers 401 for a WRONG CONSOLE PASSWORD on the credential-reveal endpoints
 * (`invalid_password`) and for a bad API key on the inference surface
 * (`missing_api_key` / `invalid_api_key`). Re-locking the console for those
 * would be a bug of its own — the session is perfectly alive, the operator just
 * mistyped something. Only `console_auth_required` means "sign in again".
 *
 * Installed from `main.tsx` (same pattern as `installExternalOpenInterceptor`):
 * the API client calls `fetch` directly at ~215 call sites with no shared
 * wrapper, so the patch sits UNDER all of them and stays transparent — the
 * original `Response` is returned untouched (a 401 body is read from a CLONE),
 * and everything that is not a session loss passes through byte-for-byte.
 *
 * Deliberately NOT a place that retries or re-authenticates: the console holds
 * no credentials between requests (the session is an HttpOnly cookie), so the
 * only honest recovery is the login form.
 */
export const SESSION_EXPIRED_EVENT = 'ocr-session-expired';

/** The gateway's webAuth-gate error code (backend/src/server.ts). */
export const CONSOLE_AUTH_REQUIRED_CODE = 'console_auth_required';

/**
 * Does this 401 body mean "the console session is gone"?
 * Pure so the rule can be tested without patching `fetch`.
 */
export function isConsoleAuthRequired(body: string): boolean {
  if (!body) return false;
  try {
    const json = JSON.parse(body) as { error?: { code?: unknown } };
    return json?.error?.code === CONSOLE_AUTH_REQUIRED_CODE;
  } catch {
    // Non-JSON 401 (an HTML error page from something in front of the
    // gateway) proves nothing about our session — never lock on a guess.
    return false;
  }
}

let installed = false;

/** Wrap `window.fetch` once so a dead console session re-locks the UI.
 *  Idempotent: a second call is a no-op. */
export function installSessionGuard(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await realFetch(input, init);
    if (res.status === 401) {
      // Clone, never consume: the caller still owns the stream it asked for.
      const body = await res
        .clone()
        .text()
        .catch(() => '');
      if (isConsoleAuthRequired(body)) {
        // The App listens and swaps in the login view. Dispatched after the
        // caller gets its response, never instead of it (pages may unmount
        // mid-await).
        window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
      }
    }
    return res;
  };
}

/** Test seam — clears the installed flag so the next call re-wraps. */
export function _resetSessionGuardForTests(): void {
  installed = false;
}
