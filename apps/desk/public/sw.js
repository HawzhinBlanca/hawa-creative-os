// Hawa Desk PWA — public shell and font caching only
// Provides zero-flicker Kurdish font precaching (Vazirmatn & Noto Sans Arabic)
// and resilient offline app shell caching.

// v4 (ADR-102): private API evidence must never be cached or replayed across sessions.
const CACHE_VERSION = 'v4';
const FONTS_CACHE = `hawa-fonts-${CACHE_VERSION}`;
const SHELL_CACHE = `hawa-shell-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// Precache app shell on install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('Precache failed for some URLs:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Clean up stale caches on activate
self.addEventListener('activate', (event) => {
  const allowedCaches = new Set([FONTS_CACHE, SHELL_CACHE]);
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (!allowedCaches.has(name) && name.startsWith('hawa-')) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Intercept fetch requests
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Strictly bypass real-time SSE stream & non-GET requests
  if (url.pathname.includes('/events/stream') || request.method !== 'GET') {
    return;
  }

  // Authenticated data stays on the network. Cache Storage has no office/session scope,
  // and a stored success must never conceal offline status or a revoked permission.
  if (url.origin === self.location.origin && /^\/(?:v1|api)(?:\/|$)/.test(url.pathname)) return;

  // 2. Kurdish & Latin Webfonts: Cache-First (eliminates FOIT/FOUT)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONTS_CACHE).then(async (cache) => {
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
          return cachedResponse;
        }
        try {
          const networkResponse = await fetch(request);
          if (networkResponse.ok) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          return new Response('', { status: 408, statusText: 'Font unavailable offline' });
        }
      })
    );
    return;
  }

  // 3. HTML Navigation: Network-First with Cache Fallback for instant updates
  if (url.origin === self.location.origin && (url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith(
      fetch(request)
        .then(async (networkResponse) => {
          if (networkResponse.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          const cached = await cache.match(request);
          if (cached) return cached;
          return new Response('Offline', { status: 503 });
        })
    );
    return;
  }

  // 4. Hashed Static Assets: Cache-First with Network Fallback
  if (url.origin === self.location.origin && (url.pathname.startsWith('/assets/') || url.pathname === '/manifest.json')) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((networkResponse) => {
          if (networkResponse.ok) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        });
      })
    );
    return;
  }

});
