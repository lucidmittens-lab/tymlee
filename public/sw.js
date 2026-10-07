// Offline loading: keeps a copy of the site's own files so tymlee opens with
// no signal (the log itself is already on this device, in IndexedDB).
// Network first, so every deploy shows up at once; the saved copy is used
// only when the network fails or takes too long. Supabase calls go to
// another site and are never touched here.
'use strict';

const CACHE = 'tymlee-shell';
const FILES = [
  './', 'index.html', 'style.css', 'config.js', 'build.js', 'core.js', 'vault.js', 'idb.js',
  'ai.js', 'store.js', 'commands.js', 'timeline.js', 'gui.js', 'app.js', 'vendor/supabase.js',
  'fonts/inter.woff2', 'fonts/jetbrains-mono.woff2',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
];
const WAIT_MS = 4000; // a weak signal falls back to the saved copy after this

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const key = req.mode === 'navigate' ? './' : req;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fresh = fetch(req).then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    });
    const saved = await cache.match(key, { ignoreSearch: true });
    if (!saved) return fresh;
    const late = new Promise((resolve) => setTimeout(() => resolve(saved), WAIT_MS));
    return Promise.race([fresh.catch(() => saved), late]);
  })());
});
