/*global $scramjetLoadWorker, slipCached*/
importScripts("/scram/scramjet.all.js", "/swcache.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

// take over right away after install/update instead of waiting for a reload
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim())
);

self.addEventListener("fetch", (event) => {
  event.respondWith(
    (async () => {
      await scramjet.loadConfig();
      if (scramjet.route(event)) {
        return slipCached(event, () => scramjet.fetch(event));
      }
      return fetch(event.request);
    })()
  );
});
