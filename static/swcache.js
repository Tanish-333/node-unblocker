/*
 * Cache for proxied static files (scripts, styles, fonts, images).
 *
 * Everything a proxied site loads goes through the service worker, so the
 * browser's normal cache never sees it and big sites re-download all of their
 * JavaScript on every visit. This keeps a copy of files the site itself says
 * may be cached (Cache-Control max-age / immutable), already rewritten, so
 * repeat visits load them instantly.
 */
// slipCached is used by the service workers that importScripts() this file
const SLIP_CACHE = "slip-cache-v1";
const SLIP_TYPES = new Set(["script", "style", "font", "image"]);
const SLIP_MIN_AGE = 300; // only cache files allowed to live at least 5 minutes
const SLIP_MAX_AGE = 7 * 24 * 3600; // never keep anything longer than a week
const SLIP_MAX_SIZE = 8 * 1024 * 1024; // skip files over 8 MB
let slipPuts = 0;

function slipLifetime(headers) {
  const cc = (headers.get("cache-control") || "").toLowerCase();
  if (/no-store|no-cache/.test(cc)) return 0;
  if (cc.includes("immutable")) return SLIP_MAX_AGE;
  const m = cc.match(/(?:^|[,\s])max-age=(\d+)/);
  if (m) return Math.min(Number(m[1]), SLIP_MAX_AGE);
  const expires = Date.parse(headers.get("expires") || "");
  if (expires)
    return Math.min(Math.max(0, (expires - Date.now()) / 1000), SLIP_MAX_AGE);
  return 0;
}

async function slipTrim(cache) {
  const keys = await cache.keys();
  if (keys.length > 1500) {
    await Promise.all(
      keys.slice(0, keys.length - 1200).map((k) => cache.delete(k))
    );
  }
}

async function slipStore(cache, url, res, lifetime) {
  const body = await res.blob();
  if (body.size > SLIP_MAX_SIZE) return;
  const headers = new Headers(res.headers);
  headers.delete("vary");
  // the stored body is already decoded and complete; drop size/encoding labels
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set("x-slip-expires", String(Date.now() + lifetime * 1000));
  await cache.put(
    url,
    new Response(body, { status: 200, statusText: res.statusText, headers })
  );
  if (++slipPuts % 50 === 0) await slipTrim(cache);
}

// handler() produces the proxied response when there is no usable cached copy
// eslint-disable-next-line no-unused-vars
async function slipCached(event, handler) {
  const req = event.request;
  if (
    req.method !== "GET" ||
    !SLIP_TYPES.has(req.destination) ||
    req.headers.has("range")
  ) {
    return handler();
  }
  let cache;
  try {
    cache = await caches.open(SLIP_CACHE);
    const hit = await cache.match(req.url, {
      ignoreVary: true,
      ignoreSearch: false,
    });
    if (hit) {
      if (Number(hit.headers.get("x-slip-expires")) > Date.now()) return hit;
      cache.delete(req.url);
    }
  } catch (e) {
    return handler(); // storage unavailable (private mode etc.)
  }
  const res = await handler();
  if (res.status === 200 && res.type !== "opaque") {
    const lifetime = slipLifetime(res.headers);
    const size = Number(res.headers.get("content-length")) || 0;
    if (lifetime >= SLIP_MIN_AGE && size <= SLIP_MAX_SIZE) {
      event.waitUntil(
        slipStore(cache, req.url, res.clone(), lifetime).catch(() => {})
      );
    }
  }
  return res;
}
