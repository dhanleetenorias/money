/**
 * BUMP `V` ON EVERY DEPLOY. No exceptions.
 *
 * `activate` deletes every cache whose key isn't V, so the version string is
 * the ONLY thing that evicts stale assets. index.html and everything under
 * /js/ are network-first and self-heal, but app.css is CACHE-FIRST: leave V
 * alone and an installed home-screen app keeps serving the stylesheet it
 * first installed, forever, no matter how many times the file changes.
 */
const V = "money-2026-07-27g";

const PRECACHE = [
  "./",
  "./index.html",
  "./app.css",
  "./js/main.js",
  "./js/money.js",
  "./js/budget.js",
  "./js/store.js",
  "./js/idb.js",
  "./js/sync.js",
  "./js/render.js",
  "./js/toast.js",
  "./js/sw-register.js",
  "./manifest.webmanifest",
  // 180 is index.html's apple-touch-icon — the iOS home-screen icon. Without
  // it here an offline install has no icon to fall back on. The larger sizes
  // are what the manifest offers; the OS picks. 1024 is deliberately NOT
  // precached: nothing requests it at install time and it's 60KB.
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./favicon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(V)
      .then((cache) =>
        Promise.allSettled(PRECACHE.map((url) => cache.add(url))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== V).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never intercept the Apps Script sync endpoint — cross-origin passes through.
  if (url.origin !== self.location.origin) return;

  const isFresh =
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/") ||
    url.pathname.includes("/js/");

  // Only cache real successes — a GH Pages 404/500 must never get pinned in
  // and re-served forever.
  const store = (res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(V).then((cache) => cache.put(req, copy));
    }
    return res;
  };

  // Offline fallback must never resolve to undefined: respondWith(undefined)
  // throws and the user gets a blank screen instead of the app.
  const fallback = () =>
    caches
      .match(req)
      .then((r) => r || caches.match("./index.html"))
      .then((r) => r || Response.error());

  if (isFresh) {
    event.respondWith(fetch(req).then(store).catch(fallback));
    return;
  }

  event.respondWith(
    caches
      .match(req)
      .then((cached) => cached || fetch(req).then(store).catch(fallback)),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
