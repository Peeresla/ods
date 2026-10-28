'use strict';

// Меняйте версию, если нужно принудительно сбросить кэш у всех пользователей.
const CACHE = 'ods-trainer-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './questions.enc.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];
const NETWORK_TIMEOUT_MS = 5000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/questions.enc.json')) {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(event));
  }
});

// Банк вопросов: сначала сеть (чтобы замена файла сразу доходила), без сети — кэш.
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetchWithTimeout(req, NETWORK_TIMEOUT_MS);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await cache.put(req.url.split('?')[0], res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req, { ignoreSearch: true });
    return cached || Response.error();
  }
}

// Остальные файлы: сразу из кэша, а в фоне обновляем кэш — новая версия подхватится при следующем запуске.
async function staleWhileRevalidate(event) {
  const req = event.request;
  const cache = await caches.open(CACHE);
  let cached = await cache.match(req, { ignoreSearch: true });
  if (!cached && req.mode === 'navigate') cached = await cache.match('./index.html');

  const network = fetch(req)
    .then((res) => {
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}

function fetchWithTimeout(req, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(req, { signal: controller.signal }).finally(() => clearTimeout(timer));
}
