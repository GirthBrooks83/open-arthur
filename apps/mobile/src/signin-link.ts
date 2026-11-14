// Tap-to-sign-in link handling (/?signin=<one-time-code>).
//
// Pure URL helpers with no platform imports, so they are unit-tested
// directly (apps/mobile/test/session-store.test.ts). The web-only
// glue that reads window.location and rewrites history lives in
// api.ts (consumeSigninLink).

export const SIGNIN_PARAM = "signin";

// Extract the one-time code from a URL, or null when the URL carries
// no (usable) sign-in code.
export function signinCodeFromUrl(url: string): string | null {
  try {
    const code = new URL(url).searchParams.get(SIGNIN_PARAM);
    return code?.trim() ? code : null;
  } catch {
    return null;
  }
}

// The same URL with the sign-in code removed — every other query
// parameter and the hash are preserved. Used with history.replaceState
// after an exchange so the spent code does not linger in the address
// bar, browser history, or a shared copy of the URL.
export function stripSigninParam(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has(SIGNIN_PARAM)) return url;
    parsed.searchParams.delete(SIGNIN_PARAM);
    return parsed.toString();
  } catch {
    return url;
  }
}
