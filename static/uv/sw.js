/*global UVServiceWorker, __uv$config, slipCached, slipPageFix*/
importScripts("/uv/uv.bundle.js");
importScripts("/uv/uv.config.js");
importScripts(__uv$config.sw);
importScripts("/swcache.js", "/pagefix.js");

const uv = new UVServiceWorker();

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
