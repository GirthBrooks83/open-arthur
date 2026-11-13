// PWA service worker registration — native builds.
//
// Service workers are a web-platform feature; native apps install
// through the app stores instead, so registration is a no-op here.
// The web implementation lives in pwa.web.ts and is picked up by the
// bundler's platform resolution (same pattern as local-brain).

export function registerPwaServiceWorker(): void {
  // No-op on native: there is no service worker to register.
}
