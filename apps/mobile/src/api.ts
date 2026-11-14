import { Platform } from "react-native";
import {
  clearStoredSession,
  readStoredSession,
  type StoredSession,
  writeStoredSession,
} from "./session-store";
import { signinCodeFromUrl, stripSigninParam } from "./signin-link";

// In a production web build served by the API server itself (single-origin
// deploys such as Render), the API lives on the page's own origin, so use
// relative requests. Dev web builds keep the separate dev API on :8787,
// and EXPO_PUBLIC_API_URL always wins when set.
const sameOrigin =
  Platform.OS === "web" && process.env.NODE_ENV === "production" && typeof window !== "undefined"
    ? window.location.origin
    : undefined;

export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ||
  sameOrigin ||
  (Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787")
).replace(/\/$/, "");

export class MuseApi {
  constructor(readonly token: string) {}
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await fetch(`${API_URL}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      // A 401 means the stored session is dead (expired or revoked):
      // drop it so the next launch goes to the sign-in form instead of
      // restoring a token that can only fail again.
      if (response.status === 401) clearStoredSession();
      throw new Error(
        typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`,
      );
    }
    return payload;
  }
  url(path: string) {
    return path.startsWith("http") ? path : `${API_URL}${path}`;
  }
}

export async function createSession(
  accessKey?: string,
): Promise<{ token: string; mode: "sample" | "live" }> {
  const response = await fetch(`${API_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not open your workspace.");
  return payload;
}

// The session restored from storage on load, or null when there is
// none worth restoring. The stored token is probed against the API:
// a 401 clears it (and the caller falls back to sign-in), while any
// other failure (offline, server waking) keeps it — the workspace
// load that follows will surface the real error with a retry.
export async function restoreStoredSession(): Promise<StoredSession | null> {
  const stored = readStoredSession();
  if (!stored) return null;
  try {
    const response = await fetch(`${API_URL}/api/workspace`, {
      headers: { Authorization: `Bearer ${stored.token}` },
    });
    if (response.status === 401) {
      clearStoredSession();
      return null;
    }
  } catch {
    // Unreachable server: keep the stored session and let the app
    // open with it; its first real request reports the failure.
  }
  return stored;
}

// Trade a one-time sign-in code for a session and persist it.
export async function exchangeSigninCode(
  code: string,
): Promise<{ token: string; mode: "sample" | "live" }> {
  const response = await fetch(`${API_URL}/api/session/signin-exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Sign-in link is invalid or has expired.");
  writeStoredSession(payload);
  return payload;
}

// Web only: if this page was opened from a tap-to-sign-in link
// (/?signin=<code>), exchange the code, persist the session, and
// strip the code from the URL — in a finally, so even a spent or
// invalid code never lingers in the address bar or history. Returns
// the exchanged session, or null when the URL carries no code.
export async function consumeSigninLink(): Promise<{
  token: string;
  mode: "sample" | "live";
} | null> {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  const code = signinCodeFromUrl(window.location.href);
  if (!code) return null;
  try {
    return await exchangeSigninCode(code);
  } finally {
    window.history.replaceState(null, "", stripSigninParam(window.location.href));
  }
}

// Explicit sign-out: revoke the session server-side (best effort) and
// always clear the persisted token, so the next load shows the
// sign-in form.
export async function signOutSession(token: string): Promise<void> {
  try {
    await fetch(`${API_URL}/api/session/sign-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // The stored token is cleared either way; a server that could not
    // be reached lets the session record expire on its own.
  }
  clearStoredSession();
}
