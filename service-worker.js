const CACHE_NAME = "ajsf-shell-v27";
const APP_SHELL = ["./", "./index.html", "./style.css", "./src/app.js", "./src/config.js", "./customer.html", "./src/customer-app.js", "./assets/ajsf-logo.png", "./manifest.webmanifest"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("ajsf-shell-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put("./index.html", copy));
      return response;
    }).catch(() => caches.match("./index.html")));
    return;
  }
  if (url.origin === self.location.origin || url.hostname === "esm.sh") {
    const isAppCode = url.origin === self.location.origin && /\.(js|css)$/.test(url.pathname);
    if (isAppCode) {
      event.respondWith(fetch(request).then(response => {
        if (response && response.ok) {
          try { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {}); } catch (error) { console.warn("Cache write skipped", error); }
        }
        return response;
      }).catch(() => caches.match(request)));
    } else {
      event.respondWith(caches.match(request).then(cached => {
        const network = fetch(request).then(response => {
          if (response && response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
          return response;
        });
        return cached || network;
      }));
    }
  }
});
