const CACHE = 'tsunami-lab-v5';
const APP_SHELL = [
  './', './index.html', './styles.css', './app.js', './simulation.js', './simulation-worker.js', './scenario.js',
  './privacy.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png',
  './data/bathymetry.bin', './data/land.geojson',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok && new URL(event.request.url).origin === location.origin) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
    }
    return response;
  })));
});
