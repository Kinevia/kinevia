/**
 * Kinévia — Service Worker v13
 * Stratégie :
 *   - Cache-first : assets statiques (CSS, JS, images, icônes, fonts)
 *   - Network-first + cache fallback : pages HTML
 *   - API GET /api/patient/:lien : network-first, cache fallback (offline mode)
 *   - API POST /api/patient/:lien/sync : network-only (sync endpoint)
 *   - SSE /stream : exclu du SW (pas de timeout, pas de cache)
 *   - Timeout réseau normal : 5s   Timeout mode dégradé (offline) : 3s
 *   - Background Sync : tag 'kinevia-seance-sync' → notifie les clients
 *   - Push notifications : showNotification()
 *   - Mise à jour : notifie les clients (SW_UPDATED) — uniquement si ancienne version détectée
 * v13: Fix SW_UPDATED toast — conditionnel (vraie MAJ seulement, pas premier install)
 */

const CACHE_NAME = 'kinevia-v13';
const OFFLINE_URL = '/offline.html';
const NETWORK_TIMEOUT_MS = 5000;         // timeout normal
const DEGRADED_TIMEOUT_MS = 3000;        // timeout quand connexion dégradée
const PATIENT_API_RE = /^\/api\/patient\/[^/]+\/?$/; // GET /api/patient/:lien

// Assets pré-cachés à l'installation
const PRECACHE_ASSETS = [
  '/',
  '/offline.html',
  '/manifest.json',
  '/favicon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/offline-db.js',
];

// ============================================================
// INSTALL — pré-cache les ressources essentielles
// ============================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Precache partial failure:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ============================================================
// ACTIVATE — nettoie les anciens caches, notifie les clients
// ============================================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      // Detect if this is an actual update (old cache versions existed)
      const oldCacheKeys = keys.filter((key) => key !== CACHE_NAME);
      const isUpdate = oldCacheKeys.length > 0;

      return Promise.all(oldCacheKeys.map((key) => caches.delete(key)))
        .then(() => self.clients.claim())
        .then(() => {
          // Only notify clients when this SW replaced an older version
          if (isUpdate) {
            self.clients.matchAll({ type: 'window' }).then((clients) => {
              clients.forEach((client) => {
                client.postMessage({ type: 'SW_UPDATED', version: CACHE_NAME });
              });
            });
          }
        });
    })
  );
});

// ============================================================
// BACKGROUND SYNC — rejoue les séances en attente
// ============================================================
self.addEventListener('sync', (event) => {
  if (event.tag === 'kinevia-seance-sync') {
    event.waitUntil(
      // Notify all windows to trigger their own sync logic
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SW_SYNC_READY', tag: event.tag });
        });
      })
    );
  }
});

// ============================================================
// PUSH — affichage de la notification
// ============================================================
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Kinévia', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Kinévia';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/icon-192.png',
    data: data.data || {},
    tag: data.tag || 'kinevia-notification',
    renotify: false,
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ============================================================
// NOTIFICATION CLICK
// ============================================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : '/app.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.navigate(targetUrl);
          return;
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// ============================================================
// FETCH — stratégie selon le type de requête
// ============================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (!url.protocol.startsWith('http')) return;

  const isSameOrigin = url.origin === self.location.origin;

  // SSE : exclure du SW entièrement
  if (isSameOrigin && (
    url.pathname.includes('/stream') ||
    request.headers.get('Accept') === 'text/event-stream'
  )) {
    return;
  }

  // POST /api/patient/:lien/sync — always network-only, never cache
  if (isSameOrigin && request.method === 'POST' && url.pathname.endsWith('/sync')) {
    event.respondWith(networkOnly(request));
    return;
  }

  // GET /api/patient/:lien — network-first with 3s degraded timeout, cache fallback
  if (isSameOrigin && request.method === 'GET' && PATIENT_API_RE.test(url.pathname)) {
    event.respondWith(patientApiHandler(request));
    return;
  }

  // Other API calls — network-only (never serve stale for mutations)
  if (isSameOrigin && url.pathname.startsWith('/api/')) {
    event.respondWith(networkOnly(request));
    return;
  }

  // Static assets — cache-first
  if (isStaticAsset(request)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // HTML pages — network-first with timeout, fallback offline
  if (isSameOrigin && request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }

  // Everything else — network with cache backup
  if (isSameOrigin) {
    event.respondWith(networkFirst(request));
  }
});

// ============================================================
// Helpers
// ============================================================

function isStaticAsset(request) {
  const url = new URL(request.url);
  const ext = url.pathname.split('.').pop().toLowerCase();
  const staticExtensions = ['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'otf'];
  return staticExtensions.includes(ext);
}

/**
 * Fetch avec timeout AbortController.
 */
function fetchWithTimeout(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('SW fetch timeout'));
    }, timeoutMs);

    fetch(request, { signal: controller.signal })
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Patient API handler : network-first (3s degraded timeout), then cache.
 * Caches successful responses so offline mode can use them.
 */
async function patientApiHandler(request) {
  const cacheKey = request.url;
  try {
    const response = await fetchWithTimeout(request, DEGRADED_TIMEOUT_MS);
    if (response && response.ok) {
      // Clone + cache
      const cache = await caches.open(CACHE_NAME);
      cache.put(cacheKey, response.clone());
    }
    return response;
  } catch {
    // Network failed / timeout — try cache
    const cached = await caches.match(request);
    if (cached) {
      // Add a custom header so the client knows this is cached data
      const cachedData = await cached.json();
      return new Response(JSON.stringify({ ...cachedData, _from_cache: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Offline-Cache': '1',
        },
      });
    }
    return new Response(JSON.stringify({ error: 'Hors-ligne', _offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Cache-first with stale-while-revalidate for images.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    const url = new URL(request.url);
    const ext = url.pathname.split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
      fetchWithTimeout(request, NETWORK_TIMEOUT_MS)
        .then(async (response) => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response);
          }
        })
        .catch(() => {});
    }
    return cached;
  }

  try {
    const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (response && response.status === 200 && response.type !== 'opaque') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Asset non disponible hors-ligne.', { status: 503 });
  }
}

/**
 * Network-only — never cache, return offline JSON on failure.
 */
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(JSON.stringify({ error: 'Hors-ligne' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Network-first with 5s timeout, cache fallback.
 */
async function networkFirst(request) {
  try {
    const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (response && response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'Hors-ligne' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Navigation (pages HTML) : Network-first, fallback /offline.html.
 */
async function navigationHandler(request) {
  try {
    const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (response && response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;

    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;

    return new Response('<h1>Hors-ligne</h1><p>Reconnectez-vous pour accéder à Kinévia.</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}
