// The reader is mounted under a configurable base path, so every URL here is
// resolved against this script's own location instead of being hardcoded.
// A service worker's default scope is its directory, which is exactly the
// reader root (`/` locally, `/tsumego/` in production).

const CACHE_VERSION = "tsumego-sw-v1";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const scopeUrl = new URL("./", self.location);
const shellUrl = scopeUrl.toString();
const SHELL_URLS = [
  "./",
  "./app.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
].map((path) => new URL(path, self.location).toString());

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((name) => !name.startsWith(CACHE_VERSION)).map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isCacheable(response) {
  return response && response.ok && response.type === "basic";
}

// Serving the cached copy first keeps launches instant; refreshing in the
// background means a deployed fix lands on the next launch without having to
// bump CACHE_VERSION by hand.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  // Read across every cache: the shell copies are written by install, and only
  // refreshed copies land in the runtime cache.
  const cached = await caches.match(request);
  const network = fetch(request)
    .then((response) => {
      if (isCacheable(response)) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  const response = cached || (await network);
  if (response) return response;
  throw new Error("Unavailable offline");
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw error;
  }
}

function isReaderPath(url, suffix) {
  return url.pathname === `${scopeUrl.pathname}${suffix}`;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Progress writes are PUTs; they are deliberately left to fail offline
  // rather than being queued, so the reader can report an honest error.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(scopeUrl.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, shellUrl));
    return;
  }

  if (url.pathname.startsWith(`${scopeUrl.pathname}api/`)) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (
    isReaderPath(url, "app.css") ||
    isReaderPath(url, "app.js") ||
    isReaderPath(url, "manifest.webmanifest") ||
    url.pathname.startsWith(`${scopeUrl.pathname}icons/`)
  ) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
