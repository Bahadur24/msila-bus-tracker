/* Cache only the public app shell. Never cache credentials, API responses or map tiles. */
var CACHE = 'msila-tracker-v9-stop-icons-20261031';
var ASSETS = ['./index.html', './src/styles.css', './src/pro.css', './src/fonts.css', './src/app.js', './vendor/leaflet.css', './vendor/leaflet.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './msila_routes.json', './data/observed_stops.json', './expected_stops.json'];
self.addEventListener('install', function(event) {
  event.waitUntil(caches.open(CACHE).then(function(cache) { return cache.addAll(ASSETS); }).then(function() { return self.skipWaiting(); }));
});
self.addEventListener('activate', function(event) {
  event.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(key) { return key.indexOf('msila-tracker-') === 0 && key !== CACHE; }).map(function(key) { return caches.delete(key); }));
  }).then(function() { return self.clients.claim(); }));
});
self.addEventListener('fetch', function(event) {
  var request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  var base = new URL('./', self.location.href);
  var relative = './' + url.pathname.slice(base.pathname.length);
  if (!ASSETS.includes(relative) && request.mode !== 'navigate') return;
  event.respondWith(fetch(request).then(function(response) {
    if (response.ok && ASSETS.includes(relative)) {
      var copy = response.clone();
      caches.open(CACHE).then(function(cache) { cache.put(request, copy); }).catch(function() {});
    }
    return response;
  }).catch(function() {
    return caches.match(request, {ignoreSearch: true}).then(function(cached) {
      return cached || (request.mode === 'navigate' ? caches.match('./index.html') : Response.error());
    });
  }));
});
