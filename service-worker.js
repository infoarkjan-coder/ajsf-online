const CACHE_NAME = "ajsf-shell-v4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./src/app.js",
  "./src/data-tools.js",
  "./service-worker.js",
  "./assets/ajsf-app-icon.svg",
  "./src/config.js",
  "./assets/ajsf-logo.png",
  "./manifest.webmanifest"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith("ajsf-shell-") && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin && url.hostname !== "esm.sh") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME)
              .then(cache => cache.put("./index.html", copy))
              .catch(() => {})
          );
        }
        return response;
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }

  const isAppCode = url.origin === self.location.origin && /\\.(js|css)$/.test(url.pathname);
  if (isAppCode) {
    // Always prefer fresh app code; use cache only when the device is offline.
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME)
              .then(cache => cache.put(request, copy))
              .catch(() => {})
          );
        }
        return response;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for static assets, with a safe background refresh.
  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME)
              .then(cache => cache.put(request, copy))
              .catch(() => {})
          );
        }
        return response;
      });
      return cached || network.catch(() => Response.error());
    })
  );
});
