"use strict";

/*
 * Slipstream web proxy server.
 *
 * Engines (all run in the visitor's browser as a service worker except "classic"):
 *   - Scramjet (default, fastest): talks to the server over Wisp (one websocket)
 *     when the host supports websockets (Render, your own server), or over the
 *     "bare" HTTP protocol when it doesn't (Vercel).
 *   - Ultraviolet: older engine, kept as a backup.
 *   - Classic: node-unblocker's server-side rewriting proxy at /proxy/.
 *
 * Websocket handling (Wisp) is wired up in server.js, because serverless hosts
 * like Vercel can't accept websockets.
 */

const fs = require("fs");
const dns = require("dns");
const path = require("path");
const express = require("express");
const compression = require("compression");
const { createBareServer } = require("@tomphttp/bare-server-node");
const Unblocker = require("./lib/unblocker.js");

const allowLocal = process.env.ALLOW_LOCAL === "1"; // only for local testing

// ---------------------------------------------------------------------------
// DNS cache: big sites pull from dozens of hostnames, and Node does a fresh
// lookup for every new connection. Results are kept for a minute. Private and
// internal addresses are refused (same rule the bare server uses by default).
// ---------------------------------------------------------------------------
const ipaddr = require("ipaddr.js");
const dnsCache = new Map();
const DNS_TTL = 60 * 1000;

function isPublic(address) {
  try {
    return ipaddr.parse(address).range() === "unicast";
  } catch (e) {
    return false;
  }
}

function cachedLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const key = `${hostname}|${options.family || 0}|${options.all ? 1 : 0}`;
  const hit = dnsCache.get(key);
  if (hit && hit.expires > Date.now()) {
    return process.nextTick(callback, null, hit.address, hit.family);
  }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address)
      ? address.map((a) => a.address)
      : [address];
    if (!allowLocal && !list.every(isPublic)) {
      return callback(new RangeError("Forbidden IP"), "", -1);
    }
    if (dnsCache.size > 2000) dnsCache.clear();
    dnsCache.set(key, { address, family, expires: Date.now() + DNS_TTL });
    callback(null, address, family);
  });
}

// ---------------------------------------------------------------------------
// Bare server (HTTP fallback transport for Scramjet and Ultraviolet)
// ---------------------------------------------------------------------------
const bare = createBareServer("/bare/", {
  // Only the v3 protocol is used by the browser side; no database needed.
  legacySupport: false,
  // Block requests to private/internal addresses.
  blockLocal: !allowLocal,
  lookup: cachedLookup,
  // IPv4 only: hosting providers often can't reach IPv6, and Node tries it first,
  // waiting up to 250 ms per new connection before falling back.
  family: 4,
  // The default limit (10 per IP per minute) breaks big sites that make
  // hundreds of requests per page, so it is effectively turned off.
  connectionLimiter: {
    maxConnectionsPerIP: 1000000,
    windowDuration: 1,
    blockDuration: 1,
  },
});

// ---------------------------------------------------------------------------
// Classic engine (node-unblocker)
// ---------------------------------------------------------------------------

// Headers that would reveal the visitor's real IP or the hosting platform
// to the sites being visited. Removed from every outgoing request.
const PRIVATE_HEADER = /^(x-forwarded-|x-real-ip$|forwarded$|via$|x-vercel-|x-render-|rndr-|cf-|true-client-ip$|x-client-ip$)/i;

function stripPrivateHeaders(data) {
  Object.keys(data.headers).forEach((name) => {
    if (PRIVATE_HEADER.test(name)) {
      delete data.headers[name];
    }
  });
}

const unblocker = Unblocker({
  prefix: "/proxy/",
  requestMiddleware: [stripPrivateHeaders],
});

// ---------------------------------------------------------------------------
// Static files. Each is read with a literal path so Vercel bundles it.
// ---------------------------------------------------------------------------
const JS = "application/javascript; charset=utf-8";

// Ultraviolet login fix: cookies set by a page's own response (like a login
// page's anti-forgery cookie) were saved in the background and left out of
// that page, so its script couldn't read them until a reload. Logins that copy
// that cookie into the form were then refused as "unauthorized". The worker
// now waits for the cookies to be saved and gives the page the fresh list.
function patchUvWorker(code) {
  const fixes = [
    [
      'Promise.resolve(t.cookie.setCookies(r.headers["set-cookie"],w,t.meta))',
      'Promise.resolve(await t.cookie.setCookies(r.headers["set-cookie"],w,t.meta))',
    ],
    [
      "t.cookie.serialize(f,t.meta,!0)",
      "t.cookie.serialize((await t.cookie.getCookies(w))||[],t.meta,!0)",
    ],
  ];
  for (const [from] of fixes) {
    if (!code.includes(from)) {
      console.warn("Ultraviolet cookie fix not applied (new version?)");
      return code;
    }
  }
  for (const [from, to] of fixes) code = code.split(from).join(to);
  return code;
}
const ASSETS = {
  "/scram/scramjet.all.js": [
    JS,
    fs.readFileSync(
      path.join(
        __dirname,
        "node_modules",
        "@mercuryworkshop",
        "scramjet",
        "dist",
        "scramjet.all.js"
      )
    ),
  ],
  "/scram/scramjet.sync.js": [
    JS,
    fs.readFileSync(
      path.join(
        __dirname,
        "node_modules",
        "@mercuryworkshop",
        "scramjet",
        "dist",
        "scramjet.sync.js"
      )
    ),
  ],
  "/scram/scramjet.wasm.wasm": [
    "application/wasm",
    fs.readFileSync(
      path.join(
        __dirname,
        "node_modules",
        "@mercuryworkshop",
        "scramjet",
        "dist",
        "scramjet.wasm.wasm"
      )
    ),
  ],
  "/epoxy/index.mjs": [
    JS,
    fs.readFileSync(
      path.join(
        __dirname,
        "node_modules",
        "@mercuryworkshop",
        "epoxy-transport",
        "dist",
        "index.mjs"
      )
    ),
  ],
  "/baremod/base.mjs": [
    JS,
    fs.readFileSync(
      path.join(
        __dirname,
        "node_modules",
        "@mercuryworkshop",
        "bare-as-module3",
        "dist",
        "index.mjs"
      )
    ),
  ],
  "/baremod/index.mjs": [
    JS,
    fs.readFileSync(path.join(__dirname, "static", "baremod.mjs")),
  ],
  "/baremux/index.mjs": [
    JS,
    fs.readFileSync(
      path.join(
        __dirname,
        "node_modules",
        "@mercuryworkshop",
        "bare-mux",
        "dist",
        "index.mjs"
      )
    ),
  ],
  "/baremux/worker-base.js": [
    JS,
    fs.readFileSync(
      path.join(
        __dirname,
        "node_modules",
        "@mercuryworkshop",
        "bare-mux",
        "dist",
        "worker.js"
      )
    ),
  ],
  "/baremux/worker.js": [
    JS,
    fs.readFileSync(path.join(__dirname, "static", "baremux-worker.js")),
  ],
  "/uv/uv.bundle.js": [
    JS,
    fs.readFileSync(
      path.join(
        __dirname,
        "node_modules",
        "@titaniumnetwork-dev",
        "ultraviolet",
        "dist",
        "uv.bundle.js"
      )
    ),
  ],
  "/uv/uv.client.js": [
    JS,
    fs.readFileSync(
      path.join(
        __dirname,
        "node_modules",
        "@titaniumnetwork-dev",
        "ultraviolet",
        "dist",
        "uv.client.js"
      )
    ),
  ],
  "/uv/uv.handler.js": [
    JS,
    fs.readFileSync(
      path.join(
        __dirname,
        "node_modules",
        "@titaniumnetwork-dev",
        "ultraviolet",
        "dist",
        "uv.handler.js"
      )
    ),
  ],
  "/uv/uv.sw.js": [
    JS,
    patchUvWorker(
      fs.readFileSync(
        path.join(
          __dirname,
          "node_modules",
          "@titaniumnetwork-dev",
          "ultraviolet",
          "dist",
          "uv.sw.js"
        ),
        "utf8"
      )
    ),
  ],
  "/uv/uv.config.js": [
    JS,
    fs.readFileSync(path.join(__dirname, "static", "uv", "uv.config.js")),
  ],
  "/uv/sw.js": [
    JS,
    fs.readFileSync(path.join(__dirname, "static", "uv", "sw.js")),
  ],
  "/sw.js": [JS, fs.readFileSync(path.join(__dirname, "static", "sw.js"))],
  "/swcache.js": [
    JS,
    fs.readFileSync(path.join(__dirname, "static", "swcache.js")),
  ],
  "/pagefix.js": [
    JS,
    fs.readFileSync(path.join(__dirname, "static", "pagefix.js")),
  ],
  "/proxy/client/unblocker-client.js": [
    JS,
    fs.readFileSync(
      path.join(__dirname, "lib", "client", "unblocker-client.js")
    ),
  ],
  "/public_suffix_list.dat": [
    "text/plain; charset=utf-8",
    fs.readFileSync(path.join(__dirname, "static", "public_suffix_list.dat")),
  ],
  "/fonts/inter.woff2": [
    "font/woff2",
    fs.readFileSync(path.join(__dirname, "static", "fonts", "inter.woff2")),
  ],
  "/logo.svg": [
    "image/svg+xml",
    fs.readFileSync(path.join(__dirname, "static", "logo.svg")),
  ],
  "/icon-192.png": [
    "image/png",
    fs.readFileSync(path.join(__dirname, "static", "icon-192.png")),
  ],
  "/icon-512.png": [
    "image/png",
    fs.readFileSync(path.join(__dirname, "static", "icon-512.png")),
  ],
  "/manifest.webmanifest": [
    "application/manifest+json",
    fs.readFileSync(path.join(__dirname, "static", "manifest.webmanifest")),
  ],
};
const HOME_PAGE_TEMPLATE = fs.readFileSync(
  path.join(__dirname, "static", "index.html"),
  "utf8"
);
// The page is told up front whether this server accepts websockets (server.js
// sets app.wispEnabled), so it doesn't waste time testing.
const homePages = {};
function homePage() {
  const wisp = Boolean(app.wispEnabled);
  if (!homePages[wisp]) {
    homePages[wisp] = HOME_PAGE_TEMPLATE.replace(
      "<!--SLIP_CONFIG-->",
      `<script>window.__SLIP=${JSON.stringify({ wisp })}</script>`
    );
  }
  return homePages[wisp];
}

// Files that must always be checked for updates (service workers, the page itself).
const NO_CACHE = new Set([
  "/sw.js",
  "/uv/sw.js",
  "/swcache.js",
  "/pagefix.js",
  "/manifest.webmanifest",
  "/baremux/worker.js",
  "/baremod/index.mjs",
  "/uv/uv.sw.js",
]);

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();

// Hosts like Render and Vercel sit behind a reverse proxy; trust it so https links are right.
app.set("trust proxy", true);
app.disable("x-powered-by");

// Bare server requests go first, before anything else touches them.
app.use((req, res, next) => {
  if (bare.shouldRoute(req)) {
    // The bare server passes each site's Cache-Control through, but the
    // browser (and Vercel's CDN) store the answer under one address per site
    // URL, ignoring the visitor's cookies, the site's "Vary" header and
    // fetch(..., { cache: "no-store" }). So after logging in, sites got the
    // saved logged-out answer back and acted as if you weren't signed in.
    // Static files are still cached by the service worker (swcache.js).
    const writeHead = res.writeHead;
    res.writeHead = function (status, ...rest) {
      const headers = rest.find((h) => h && typeof h === "object");
      if (headers) {
        delete headers["cache-control"];
        delete headers.etag;
        headers["cache-control"] = "no-store";
      }
      return writeHead.call(this, status, ...rest);
    };
    bare.routeRequest(req, res);
  } else {
    next();
  }
});

app.get("/healthz", (req, res) => {
  res.type("text").send("ok");
});

// gzip our own files (big JS/wasm bundles shrink a lot); proxied traffic is not touched
app.use(
  compression({
    // skip fonts and images: they're already compressed
    filter: (req) =>
      req.path === "/" ||
      (Object.prototype.hasOwnProperty.call(ASSETS, req.path) &&
        !/\.(woff2|png)$/.test(req.path)),
  })
);

app.get("/", (req, res) => {
  res.type("html").set("Cache-Control", "no-cache").send(homePage());
});

app.get(Object.keys(ASSETS), (req, res) => {
  const [type, body] = ASSETS[req.path];
  res
    .type(type)
    .set(
      "Cache-Control",
      NO_CACHE.has(req.path)
        ? "no-cache"
        : // s-maxage lets Vercel's CDN serve these from a server near the visitor
          "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800"
    )
    .send(body);
});

// Proxied pages are normally answered by the service worker in the browser.
// If one reaches the server, the worker isn't running yet: send the visitor home.
app.get(["/scramjet/*splat", "/uv/service/*splat"], (req, res) => {
  res.redirect("/");
});

app.use(unblocker);

app.use((req, res) => {
  res.redirect("/");
});

// Friendly error page, e.g. when a site can't be reached.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) {
    return res.end();
  }
  const msg = String((err && err.code) || "Unknown error").replace(
    /[<>&"]/g,
    ""
  );
  res
    .status(502)
    .type("html")
    .send(
      `<!DOCTYPE html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Couldn't load site</title>` +
        `<body style="font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;text-align:center;background:#07080d;color:#eee">` +
        `<h1 style="font-size:24px">Couldn't load that site</h1>` +
        `<p style="color:#999">The site didn't respond or blocked the proxy (${msg}).</p>` +
        `<p><a href="/" target="_top" style="color:#a78bfa;font-weight:600">Back to home</a></p></body>`
    );
});

app.unblocker = unblocker;
app.bare = bare;
app.allowLocal = allowLocal;

module.exports = app;
