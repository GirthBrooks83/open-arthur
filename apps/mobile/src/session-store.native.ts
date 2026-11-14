// Persisted session token — native builds (see session-store.web.ts).
//
// The repo carries no native secure-storage dependency, and adding
// one is a native-build change, so native keeps the token in memory
// for the life of the app process: sane behavior (no sign-out on
// navigation or backgrounding within a run) without pretending to a
// durability it does not have. Web — the surface the tap-to-sign-in
// link targets — persists in localStorage.

export interface StoredSession {
  token: string;
  mode: "sample" | "live";
}

let current: StoredSession | null = null;

export function readStoredSession(): StoredSession | null {
  return current;
}

export function writeStoredSession(session: StoredSession): void {
  current = session;
}

export function clearStoredSession(): void {
  current = null;
}
