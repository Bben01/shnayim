const CACHE_NAME_STATIC = 'shnayim-static-v14';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './manifest.json',
    './icon.png'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME_STATIC).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE.map((url) => new Request(url, { cache: 'reload' })));
        })
    );
});

// Re-downloads the app shell, bypassing the HTTP cache; resolves true if the page was refreshed.
async function refreshAssets() {
    const cache = await caches.open(CACHE_NAME_STATIC);
    const results = await Promise.all(ASSETS_TO_CACHE.map(async (url) => {
        const response = await fetch(url, { cache: 'reload' });
        if (!response.ok) return false;
        await cache.put(url, response);
        return url === './index.html';
    }));
    return results.some(Boolean);
}

self.addEventListener('message', (event) => {
    if (event.data?.type !== 'refresh-assets') return;
    event.waitUntil(refreshAssets()
        .catch(() => false)
        .then((refreshed) => event.ports[0]?.postMessage({ refreshed })));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
    event.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(keyList.map((key) => {
                if (key !== CACHE_NAME_STATIC) {
                    return caches.delete(key);
                }
            }));
        })
    );
});

self.addEventListener('fetch', (event) => {
    // Only handle static assets. API calls go directly to network (handled by client PersistentCache)
    const url = new URL(event.request.url);
    if (url.href.includes('sefaria.org/api')) {
        return; // Network only
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            const fetchPromise = fetch(event.request).then((networkResponse) => {
                if (networkResponse.ok) {
                    const copy = networkResponse.clone();
                    caches.open(CACHE_NAME_STATIC).then((cache) => cache.put(event.request, copy));
                }
                return networkResponse;
            }).catch((err) => cachedResponse || Promise.reject(err));
            return cachedResponse || fetchPromise;
        })
    );
});
