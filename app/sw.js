const CACHE_NAME = 'plinglist-app-v20';
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
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => undefined),
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
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/join/')) {
    return;
  }
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => cached ?? fetch(event.request)),
  );
});
