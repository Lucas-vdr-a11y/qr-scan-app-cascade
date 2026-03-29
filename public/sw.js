const CACHE_NAME = 'qr-scan-v8';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/login.html',
    '/styles.css',
    '/app.js',
    '/manifest.json',
    '/img/rederij-cascade-logo.png',
    'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&family=Baloo+Thambi+2:wght@400;700&display=swap',
    'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'
];

// Install event
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache');
                return cache.addAll(ASSETS_TO_CACHE);
            })
    );
    self.skipWaiting();
});

// Activate event (cleanup old caches)
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

// Fetch event (network first, fallback to cache)
self.addEventListener('fetch', event => {
    // We only cache GET requests
    if (event.request.method !== 'GET') return;

    // Exclude API calls from service worker caching - these need custom IndexedDB logic in app.js
    if (event.request.url.includes('/api/')) return;

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Build new cache clone if network successful
                const resClone = response.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, resClone);
                });
                return response;
            })
            .catch(() => {
                // Network failed, serve from cache
                return caches.match(event.request);
            })
    );
});
