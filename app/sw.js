const CACHE_NAME = 'plinglist-app-v0.1.22';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './favicon.svg',
  './og-image.png',
  './manifest.webmanifest',
  './app/src/web-app.js',
  './app/src/store.js',
  './app/src/i18n.js',
  './app/src/config.js',
  './app/src/audio.js',
  './packages/core/src/index.js',
  './packages/core/src/types.js',
  './packages/core/src/hlc.js',
  './packages/core/src/views.js',
  './packages/core/src/importer/index.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          ASSETS.map((asset) =>
            fetch(new Request(asset, { cache: 'no-cache' })).then((res) => {
              if (res.ok) return cache.put(asset, res);
              return undefined;
            }),
          ),
        ),
      )
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/join/') ||
    url.pathname.startsWith('/.well-known/')
  ) {
    return;
  }
  event.respondWith(
    (async () => {
      try {
        const networkResponse = await fetch(event.request, { cache: 'no-cache' });
        if (networkResponse.ok && !url.searchParams.has('pair') && !url.searchParams.has('join')) {
          const cache = await caches.open(CACHE_NAME);
          const cacheKey = url.pathname === '/' ? './' : event.request;
          void cache.put(cacheKey, networkResponse.clone());
        }
        return networkResponse;
      } catch {
        const cached = await caches.match(event.request, { ignoreSearch: true });
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
        }
        throw new Error('Network error and no cached response');
      }
    })(),
  );
});
