// 写真保管庫 Service Worker：アプリ本体をキャッシュしてオフラインでも開けるようにする
const VERSION = 'vault-shell-v1';
const SHELL = ['./', './index.html', './style.css', './app.js', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k.startsWith('vault-shell-') && k !== VERSION).map((k) => caches.delete(k))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // Google API 等は素通し
  // 自分のファイルはネットワーク優先、失敗したらキャッシュ（オフライン）
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res && res.ok) { const c = await caches.open(VERSION); c.put(e.request, res.clone()); }
      return res;
    } catch (err) {
      const cached = await caches.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      throw err;
    }
  })());
});
