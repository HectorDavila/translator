const CACHE_NAME = "church-translator-v1";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/listener.html",
  "/operator.html",
  "/css/styles.css",
  "/js/listener.js",
  "/js/operator.js",
  "/js/audio-worklet.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Don't cache WebSocket or API requests
  if (
    event.request.url.includes("/ws/") ||
    event.request.url.includes("/health")
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request);
    })
  );
});
