// RackPilot Service Worker — cache-first for shell, network-first for API
const CACHE = 'rackpilot-shell-v1';
const SHELL = ['/', '/app.js', '/styles.css', '/data.js', '/manifest.json'];
const API_PREFIX = '/api/';

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const { request } = ev;
  const url = new URL(request.url);

  // API: network-first, no cache
  if (url.pathname.startsWith(API_PREFIX)) {
    ev.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: { message: 'Offline' } }), {
          status: 503, headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Shell: cache-first, fall back to '/'
  ev.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(resp => {
        if (resp.ok && request.method === 'GET') {
          caches.open(CACHE).then(c => c.put(request, resp.clone()));
        }
        return resp;
      }).catch(() => caches.match('/'));
    })
  );
});

// Background sync for write outbox (triggered by app when online)
self.addEventListener('sync', ev => {
  if (ev.tag === 'rackpilot-outbox') {
    ev.waitUntil(self.clients.matchAll().then(clients =>
      clients.forEach(c => c.postMessage({ type: 'FLUSH_OUTBOX' }))
    ));
  }
});
