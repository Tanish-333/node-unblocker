/*global UVServiceWorker, __uv$config, slipCached, slipPageFix*/
importScripts("/uv/uv.bundle.js");
importScripts("/uv/uv.config.js");
importScripts(__uv$config.sw);
importScripts("/swcache.js", "/pagefix.js");

const uv = new UVServiceWorker();

// Chrome sends an Origin header with every POST/PUT/DELETE, even to the same
// site. Ultraviolet only adds it for cross-site requests, so logins done with
// fetch() ("Continue with email") were refused as forged. Add it like Chrome.
uv.on("request", (event) => {
  const req = event.data;
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || req.headers.origin) return;
  try {
    req.headers.origin = new URL(req.headers.referer || req.url.href).origin;
  } catch (e) {
    // leave it out if the address can't be read
  }
});

// take over right away after install/update instead of waiting for a reload
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim())
);

self.addEventListener("fetch", (event) => {
  event.respondWith(
    (async () => {
      if (uv.route(event)) {
        const res = await slipCached(event, () => uv.fetch(event));
        return slipPageFix(event, res);
      }
      return await fetch(event.request);
    })()
  );
});
