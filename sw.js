// Mia's Almanac service worker: caches the app so it opens with no signal. The last forecast is kept by the page itself.
const VERSION = "ma-v28";
const SHELL = ["./", "index.html", "almanac-core.js", "beaver-portrait.png", "icon-64.png", "icon-180.png", "icon-512.png", "manifest.json"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Weather data and Firestore always go to the network.
  const cacheable = url.origin === location.origin || url.hostname === "www.gstatic.com" || url.hostname === "cdnjs.cloudflare.com" || url.hostname.startsWith("fonts.");
  if (!cacheable) return;
  // The app's own page and code: always try the network first so updates show up on the next open.
  const ownPage = url.origin === location.origin && /(\/|\.html|\.js|\.json)$/.test(url.pathname);
  e.respondWith(ownPage
    ? fetch(e.request, { cache: "no-cache" }).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
    : caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); } return r; })));
});
