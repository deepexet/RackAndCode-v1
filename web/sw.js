// RackPilot PWA Service Worker — offline shell + API passthrough
const CACHE_NAME = 'rackpilot-shell-v1';
const SHELL_ASSETS = ['/', '/app.js', '/styles.css', '/manifest.json'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API requests: network-first, no cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(() =>
      new Response(JSON.stringify({ error: { code: 'offline', message: 'Offline — request queued' } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } })
    ));
    return;
  }

  // Shell assets: cache-first
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok && request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => caches.match('/'));
    })
  );
});
