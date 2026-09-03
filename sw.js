const CACHE = 'cg-mtldjs5a';
const STATIC = [
  '/',
  '/cerca/',
  '/giochi/',
  '/come-funziona/',
  '/faq/',
  '/assets/style.css?v=mtldjs5a',
  '/assets/cerca.js?v=mtldjs5a',
  '/logo.png',
  '/favicon.svg',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never intercept API/SSE calls
  if (url.hostname !== location.hostname) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fresh = fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => cached);
      return cached ?? fresh;
    })
  );
});
