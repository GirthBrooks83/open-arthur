// Open Arthur service worker — deliberately minimal.
//
// Chrome's "Install app" prompt requires a registered service worker
// with a fetch handler; this file exists for that, plus a basic
// offline fallback for the app shell. Everything is network-first:
// the app is live data (chat, mail, agent runs), so the worker never
// serves stale content while the network is up. Only navigations
// fall back to the cached shell when the network is down.
//
// Cache hygiene: cleanup on activate removes ONLY this worker's own
// cache generations. The on-device brain keeps its downloaded models
// in Cache Storage under its own cache names — those must survive.

const CACHE_NAME = "open-arthur-shell-v1";
const CACHE_PREFIX = "open-arthur-shell-";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.add("/"))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (request.mode === "navigate") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        throw new Error("offline and not cached");
      }),
  );
});
