// Validation-only offline shell. Never cache API responses or private diary text here.
const CACHE = 'between-pages-validation-shell-v1';
self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE).then(cache => cache.addAll(['/', '/bundle.js'])).then(() => self.skipWaiting())
));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request).catch(() => caches.match('/')));
  else if (url.pathname === '/bundle.js') event.respondWith(fetch(event.request).catch(() => caches.match('/bundle.js')));
});
