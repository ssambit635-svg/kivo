/* MedTwin AI service worker — offline app shell.
 *
 * Caches ONLY the static UI (HTML/CSS/JS/icons) so the app cold-starts and
 * renders with no network. /api is deliberately NEVER cached: health data and
 * auth tokens must always hit the live server, and stale auth offline would be
 * a security footgun. On-device OCR (when enabled) still needs the camera,
 * which obviously works offline.
 *
 * The doctor console at /doctor is intentionally outside this scope: it is a
 * separate frontend for a separate role, and clinical screens should never be
 * served stale from a cache.
 */
const VERSION = 'medtwin-v2';
const SHELL = [
  '/app/',
  '/app/index.html',
  '/app/styles.css',
  '/app/care.css',
  '/app/app.js',
  '/app/care.js',
  '/app/icons.js',
  '/app/manifest.webmanifest',
  '/app/icons/icon-192.png',
  '/app/icons/icon-512.png',
  '/app/icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept the API or auth — always live, always same-origin fresh.
  if (url.pathname.startsWith('/api')) return;
  // Only handle same-origin GET navigation/asset requests.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // App-shell: cache-first with network backfill (fast cold start, offline).
  if (url.pathname.startsWith('/app')) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(event.request, copy));
            return res;
          }),
      ),
    );
  }
});
