const CACHE_NAME = 'cuentaclara-v5';

// Recursos críticos para pre-cachear en la instalación
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon.png',
  'https://unpkg.com/vue@3.5.13/dist/vue.global.prod.js',
  'https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
];

// Hostnames de CDNs para cachear dinámicamente en el primer uso (Estrategia Cache-First)
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

/**
 * Función auxiliar: Realiza una petición de red con un límite de tiempo (timeout).
 * @param {Request} request - La petición a realizar.
 * @param {number} timeoutMs - Tiempo límite en milisegundos.
 * @returns {Promise<Response>}
 */
async function networkWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error; // Propagar el error si falla la red o por el timeout
  }
}

// Evento de instalación: Pre-cachear recursos críticos
self.addEventListener('install', (event) => {
  // Saltar la fase de espera inmediatamente
  self.skipWaiting();
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[ServiceWorker] Pre-cacheando recursos críticos');
        return cache.addAll(PRECACHE_URLS);
      })
  );
});

// Evento de activación: Limpiar cachés antiguos y reclamar clientes
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[ServiceWorker] Eliminando caché antiguo:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[ServiceWorker] Reclamando clientes');
      return self.clients.claim();
    })
  );
});

// Escuchar mensajes desde la aplicación principal
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Evento de intercepción de peticiones
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Llamadas a las APIs de tasa (dolarapi / dolarvzla): Network-First con 5s de timeout
  if (url.hostname === 've.dolarapi.com' || url.hostname === 'rates.dolarvzla.com') {
    event.respondWith(
      networkWithTimeout(event.request, 5000)
        .then((response) => {
          // Si la petición a red es exitosa, guardar en caché
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
          return response;
        })
        .catch(() => {
          // Si la red falla o hace timeout, servir desde el caché
          return caches.match(event.request);
        })
    );
    return;
  }

  // 2. Peticiones de navegación: Si estamos sin conexión, servir index.html cacheado
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(() => {
          return caches.match('./index.html');
        })
    );
    return;
  }

  // 3. Archivos de CDN, fuentes y recursos de Tesseract (Cache-First)
  if (CDN_HOSTS.some(host => url.hostname.includes(host))) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          // Si está en el caché, servir de inmediato
          return cachedResponse;
        }
        
        // Si no está, buscar en la red, cachear y devolver
        return fetch(event.request).then((response) => {
          // Asegurarse de que la respuesta sea válida para cachear
          if (!response || response.status !== 200 || (response.type !== 'basic' && response.type !== 'cors' && response.type !== 'opaque')) {
            return response;
          }
          
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
          
          return response;
        });
      })
    );
    return;
  }

  // 4. Recursos estáticos del mismo origen (Stale-while-revalidate)
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        // Iniciar la petición de red para actualizar el caché de fondo
        const fetchPromise = fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        }).catch(() => {
          // Capturar errores de red para no romper el flujo
        });

        // Devolver lo del caché si existe, o esperar a la red
        return cachedResponse || fetchPromise;
      })
    );
    return;
  }
});
