// Bump this on every release that changes anything in CORE_FILES. The activate
// handler deletes every cache whose name doesn't match, so changing the name is
// what actually evicts stale copies. Forgetting to bump it is why a shipped fix
// to /engines/timeclock.html kept serving the old broken file to everyone.
const CACHE_NAME = "larsa-control-v42";
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
  "/icons/badge-72.png",
  "/icons/badge-96.png",
  "/icons/notify-192.png",
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

// A push payload arrives from the network, so it is treated as untrusted input
// even though only our own Edge Function is supposed to be able to send one.
// Whatever it claims the destination is, the only thing acted on is a path on
// THIS origin: an absolute URL elsewhere, a protocol-relative "//evil.example",
// or a javascript: URI all collapse to "/". A notification is a thing people
// tap without reading, which is exactly why it must not be able to steer them
// somewhere we did not write.
function safeInternalPath(candidate) {
  if (typeof candidate !== "string" || !candidate) return "/";
  try {
    const resolved = new URL(candidate, self.location.origin);
    if (resolved.origin !== self.location.origin) return "/";
    return resolved.pathname + resolved.search;
  } catch {
    return "/";
  }
}

// Real background push: arrives even when no tab is open, which is the whole
// point of "phone" notifications on an installed PWA. The payload is the
// { title, body, url, tag, notificationId } shape send-push composes from the
// outbox — already stripped of any figure for sensitive categories.
self.addEventListener("push", (event) => {
  let payload = { title: "Larsa Control", body: "" };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch { /* plain-text payload, keep defaults */ }
  const url = safeInternalPath(payload.url);
  event.waitUntil(
    self.registration.showNotification(String(payload.title || "Larsa Control"), {
      body: String(payload.body || ""),
      /* An OPAQUE near-black canvas carrying the white mark.
         Opaque on purpose, and it took a wrong turn to learn why. A canvas
         that is transparent outside the droplet lets the phone's own icon
         container show through, and that container is grey — it is system UI,
         and there is no property in the Web Notifications API that can
         recolour it, reshape it or remove it. Filling the canvas is the only
         way to decide what sits behind the mark. Android then crops it to a
         circle, so the result is a black disc with the logo rather than a
         square, and the mark is sized to stay clear of that cut. */
      icon: "/icons/notify-192.png",
      /* Android masks the badge to its ALPHA and tints it, so the alpha has
         to be the logo's STROKES — the droplet rim and the cursive L — not
         the filled shape. A silhouette masks down to a solid white blob, and
         on skins that show the badge as the notification's main icon that
         blob is all anybody sees. The strokes are drawn slightly heavier than
         the source so they survive being rendered at about 24dp. */
      badge: "/icons/badge-96.png",
      // Tagging by notification id is what stops the same event, re-sent to a
      // device that was offline, from stacking three identical banners.
      tag: payload.tag ? String(payload.tag) : undefined,
      renotify: Boolean(payload.tag),
      timestamp: Date.now(),
      /* Announce itself the way a message does. `silent: false` is not the
         same as leaving it unset on every platform, and the vibration pattern
         is what makes a phone in a pocket actually noticeable — two short
         buzzes, the cadence of a text rather than the long drone of a call.
         Both defer to the person's own setting, and to the OS above that. */
      silent: payload.sound === false,
      vibrate: payload.sound === false ? undefined : [180, 90, 180],
      data: { url, notificationId: payload.notificationId || null, category: payload.category || null },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = safeInternalPath(data.url);
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients.find((client) => client.url.startsWith(self.location.origin));
    if (existing) {
      // The old version focused the window and stopped there, so tapping a
      // notification left you wherever you already were. Telling the page
      // where to go — and letting it route in-app rather than reloading —
      // is the difference between a notification and a doorbell.
      await existing.focus();
      existing.postMessage({ type: "larsa:notification-click", url, notificationId: data.notificationId || null });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

// The app asks the worker to keep the app-icon badge honest across tabs and
// after the page is closed. setAppBadge is not implemented everywhere, so
// every call is guarded rather than assumed.
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "larsa:badge") return;
  const count = Number(data.count) || 0;
  try {
    if (count > 0 && self.navigator.setAppBadge) self.navigator.setAppBadge(count);
    else if (self.navigator.clearAppBadge) self.navigator.clearAppBadge();
  } catch { /* badging unsupported on this platform */ }
});
