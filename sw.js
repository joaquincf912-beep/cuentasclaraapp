const CACHE_NAME = 'cuentaclara-v1';

const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  'https://unpkg.com/vue@3/dist/vue.global.prod.js',
  'https://unpkg.com/tesseract.js@5.0.3/dist/tesseract.min.js',
  'https://unpkg.com/lucide@latest'
];

const CDN_HOSTS = [
  'unpkg.com',
  'jsdelivr.net',
  'cloudflare.com',
  'projectnaptha.com',
  'github.io',
  'githubusercontent.com',
  'flaticon.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('Some precache assets could not be cached immediately:', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

function isCdnUrl(url) {
  return CDN_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith('.' + host));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only handle GET requests
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCdn = isCdnUrl(url);

  // Cache-First strategy for static and allowed CDN assets
  if (isSameOrigin || isCdn) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        return fetch(request).then((networkResponse) => {
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return networkResponse;
        }).catch((error) => {
          // If offline and requesting navigation, return index.html if available
          if (request.mode === 'navigate') {
            return caches.match('./index.html') || caches.match('./');
          }
          throw error;
        });
      })
    );
  }
});
