// PWA service worker registration — web only (see pwa.native.ts).
//
// Chrome on Android only offers a true "Install app" for Open Arthur
// when the page has a web app manifest (public/manifest.json, linked
// from the exported index.html) AND a registered service worker with
// a fetch handler (public/sw.js). Registration is a progressive
// enhancement: any failure is swallowed so the app boots identically
// with or without it.

export function registerPwaServiceWorker(): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Installability is optional; the app works without the worker.
    });
  });
}
