// Persisted session token — web (see session-store.native.ts).
//
// The session token is stored in localStorage so a reload, a PWA
// relaunch, or the browser discarding the page cannot sign the user
// out: on load the app reads the token back and reopens the workspace
// with it. The token is a revocable server-side session record (never
// the access key itself), and it is cleared on explicit sign-out and
// whenever the API answers 401 (see MuseApi.request in api.ts).
//
// Reads are stateless — every read goes back to localStorage — so a
// page reload genuinely re-reads what a previous page stored.

export interface StoredSession {
  token: string;
  mode: "sample" | "live";
}

const SESSION_KEY = "openmuse.session";

function backend(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readStoredSession(): StoredSession | null {
  try {
    const raw = backend()?.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.token !== "string" || !parsed.token) return null;
    return { token: parsed.token, mode: parsed.mode === "live" ? "live" : "sample" };
  } catch {
    return null;
  }
}

export function writeStoredSession(session: StoredSession): void {
  try {
    backend()?.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage full or blocked (private mode): the in-memory session
    // still works for this page, exactly as before persistence.
  }
}

export function clearStoredSession(): void {
  try {
    backend()?.removeItem(SESSION_KEY);
  } catch {
    // Nothing to clear if storage itself is unreachable.
  }
}
