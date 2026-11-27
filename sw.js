/* CTViewer service worker — makes the complete viewer available offline. */
const VERSION = 'ctviewer-v2.19.1';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/config.js',
  './js/catalog.js',
  './js/parts.js',
  './js/paint.js',
  './js/viewer.js',
  './js/main.js',
  './vendor/three/three.module.js',
  './vendor/three/addons/controls/OrbitControls.js',
  './vendor/three/addons/loaders/GLTFLoader.js',
  './vendor/three/addons/loaders/DRACOLoader.js',
  './vendor/three/addons/libs/meshopt_decoder.module.js',
  './vendor/three/addons/utils/BufferGeometryUtils.js',
  './vendor/draco/draco_decoder.js',
  './vendor/draco/draco_decoder.wasm',
  './vendor/draco/draco_wasm_wrapper.js',
  './assets/models/catalog.json',
  './js/sky.js',
  './js/city.js',
  './vendor/three/addons/loaders/RGBELoader.js',
  './assets/scenes/garage.glb',
  './assets/scenes/garage/plate_color.jpg',
  './assets/scenes/garage/plate_normal.jpg',
  './assets/scenes/garage/plate_rough.jpg',
  './assets/scenes/garage/plate_metal.jpg',
  './assets/scenes/neon_studio.hdr',
  './assets/scenes/city/city.glb',
  './assets/models/ferrari-f430.glb',
  './assets/models/ferrari-f430.lod.glb',
  './js/drive.js',
  './js/photo.js',
  './js/characters.js',
  './js/character-clips.js',
  './assets/characters/characters.json',
  './assets/characters/ground.json',
  './assets/characters/animations.glb',
  './assets/characters/colphne.glb',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(APP_SHELL)).catch((err) => {
      console.warn('[CTViewer SW] precache partially failed', err);
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html')),
    );
    return;
  }

  const isCode = /\.(js|css|html)$/.test(url.pathname);
  if (isCode) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req)),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && (url.pathname.includes('/assets/') || url.pathname.includes('/vendor/') || /\.(js|css|html)$/.test(url.pathname))) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req));
    }),
  );
});
