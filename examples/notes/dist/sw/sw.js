
self.addEventListener('install', event => event.waitUntil(caches.open('old-app').then(cache => cache.addAll(['/', '/app.js', '/dataset.json'])).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => { if (['/', '/app.js', '/dataset.json'].includes(new URL(event.request.url).pathname)) event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request))); });
