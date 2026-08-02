// Bump this on every release that changes anything in CORE_FILES. The activate
// handler deletes every cache whose name doesn't match, so changing the name is
// what actually evicts stale copies. Forgetting to bump it is why a shipped fix
// to /engines/timeclock.html kept serving the old broken file to everyone.
const CACHE_NAME = "larsa-control-v16";
const CORE_FILES = [
  "/",
  "/manifest.webmanifest",
  "/engines/timeclock.html",
  "/engines/hr.html",
  "/engines/accounting.html",
  "/engines/accounting-core.js",
  "/engines/accounting-cloud.js",
  "/icons/larsa-logo.svg",
  "/icons/larsa-mark.png",
  "/favicon.ico",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never serve React Server Component payloads or optimised images from cache:
  // cache-first on these pins the UI to a stale build after a deploy.
  if (url.searchParams.has("_rsc") || url.pathname.startsWith("/_vinext/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/"))),
    );
    return;
  }

  // The engine files are the part of this app that changes most often, and they
  // load inside iframes -- so a stale copy survives even a hard refresh of the
  // parent page, because the iframe request still gets answered from cache.
  // Network-first means a deploy always wins; the cache is only a fallback for
  // genuinely being offline.
  if (url.pathname.startsWith("/engines/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Stale-while-revalidate: everything else still loads instantly offline,
  // but a newer copy is fetched in the background for the next visit.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

// Real background push: arrives even when no tab is open, which is the whole
// point of "phone" notifications on an installed PWA. The payload is the same
// { title, body, url } shape the send-push Edge Function sends.
self.addEventListener("push", (event) => {
  let payload = { title: "Larsa Control", body: "" };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch { /* plain-text payload, keep defaults */ }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => client.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    }),
  );
});
