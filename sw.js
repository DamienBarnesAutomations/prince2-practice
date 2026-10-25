// One version only: whatever is currently deployed.
// Every request goes to the network first and revalidates past the browser's HTTP cache,
// so a deploy is picked up on the next load. The copy kept in CACHE is only used offline.
const CACHE = 'prince2-practice';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './bank-logic.js',
  './progress.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './bank/index.json',
];

const fresh = (url) => new Request(url, { cache: 'no-cache' });

async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(SHELL.map(async (url) => {
    try {
      const response = await fetch(fresh(url));
      if (response.ok) await cache.put(url, response);
    } catch { /* offline install: the next online load fills it in */ }
  }));
  try {
    const index = await (await cache.match('./bank/index.json'))?.json();
    await Promise.all((index?.sets ?? []).map(async (set) => {
      try {
        const response = await fetch(fresh(`./${set.file}`));
        if (response.ok) await cache.put(`./${set.file}`, response);
      } catch { /* same */ }
    }));
  } catch { /* index unreadable: the bank is cached as it is used */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(new Request(request, { cache: 'no-cache' }));
      if (response.ok) cache.put(request, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(request, { ignoreSearch: true })
        ?? (request.mode === 'navigate' ? await cache.match('./index.html') : undefined);
      if (cached) return cached;
      throw error;
    }
  })());
});
