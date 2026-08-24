// The reader is mounted under a configurable base path, so every URL here is
// resolved against this script's own location instead of being hardcoded.
// A service worker's default scope is its directory, which is exactly the
// reader root (`/` locally, `/tsumego/` in production).

// v2 abandons the v1 caches on purpose: v1 kept a separate install-time shell
// cache, and because caches.match() searches every cache in creation order it
// returned that first copy forever. A deployed app.css never reached the
// browser again. One cache, written through on every successful fetch, cannot
// develop a stale corner like that.
const CACHE_VERSION = "tsumego-sw-v2";
const CACHE_NAME = `${CACHE_VERSION}-assets`;

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
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)));
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

// The origin sends Cache-Control: no-cache, but a worker's plain fetch() still
// went to the browser HTTP cache and came back with a superseded app.css.
// Asking for revalidation on the request itself is not advisory, so the network
// is always consulted. Navigation requests cannot be reconstructed this way.
function revalidating(request) {
  if (request.mode === "navigate") return request;
  // Built from the URL rather than the Request: a no-cors subresource request
  // cannot be reconstructed with an init, and silently falling back to it was
  // enough to keep serving a superseded app.css.
  return new Request(request.url, { cache: "reload", credentials: "same-origin" });
}

// Everything is network-first: the assets carry no content hash, so the only
// way to guarantee a deploy is visible is to ask. The cache exists to keep the
// reader usable offline, not to shave a round trip off a warm launch.
async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(revalidating(request));
    if (isCacheable(response)) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw error;
  }
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

  event.respondWith(networkFirst(request));
});
