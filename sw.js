// アプリ本体と Firebase SDK を端末にキャッシュして、電波がなくても起動できるようにする。
// 自分のファイルはネット優先(更新がすぐ反映される)。3 秒で応答がなければキャッシュを使う。
// Firebase SDK(gstatic)はキャッシュ優先。
const CACHE = 'bunkasai-register-v1';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'firebase-config.js',
  'js/app.js', 'js/store.js', 'js/store-local.js', 'js/store-firebase.js', 'js/util.js',
  'icons/icon-180.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch(req, { signal: ctl.signal });
    clearTimeout(timer);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) ||
      (req.mode === 'navigate' ? await cache.match('index.html') : Response.error());
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) e.respondWith(networkFirst(req));
  else if (url.hostname === 'www.gstatic.com') e.respondWith(cacheFirst(req));
});
