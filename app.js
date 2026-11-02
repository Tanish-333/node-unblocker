"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const { createBareServer } = require("@tomphttp/bare-server-node");
const Unblocker = require("./lib/unblocker.js");

// ---------------------------------------------------------------------------
// Main engine: Ultraviolet (runs in the browser as a service worker) talking to
// a "bare" server here. This handles JavaScript-heavy sites far better than
// the classic rewriting proxy below.
// ---------------------------------------------------------------------------
const bare = createBareServer("/bare/", {
  // Only the v3 protocol is used by the browser side; no database needed.
  legacySupport: false,
  // Block requests to private/internal addresses, except when testing locally.
  blockLocal: process.env.BARE_ALLOW_LOCAL !== "1",
  // The default limit (10 per IP per minute) breaks big sites that make
  // hundreds of requests per page, so it is effectively turned off.
  connectionLimiter: {
    maxConnectionsPerIP: 1000000,
    windowDuration: 1,
    blockDuration: 1,
  },
});

// Headers that would reveal the visitor's real IP or the hosting platform
// to the sites being visited. Removed from every outgoing request.
const PRIVATE_HEADER = /^(x-forwarded-|x-real-ip$|forwarded$|via$|x-vercel-|cf-|true-client-ip$|x-client-ip$)/i;

function stripPrivateHeaders(data) {
  Object.keys(data.headers).forEach((name) => {
    if (PRIVATE_HEADER.test(name)) {
      delete data.headers[name];
    }
  });
}

// Adds a small "home" button to proxied HTML pages so you can get back to the start page.
function homeButton(data) {
  if (!Unblocker.contentTypes.html.includes(data.contentType)) {
    return;
  }
  const { Transform } = require("stream");
  let done = false;
  const button =
    '<a href="/" target="_top" id="__ub_home" title="Back to proxy home" style="all:initial;position:fixed;z-index:2147483647;' +
    "right:14px;bottom:14px;width:44px;height:44px;border-radius:50%;background:#4f46e5;color:#fff;" +
    "display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3);" +
    'font:600 20px/1 system-ui,sans-serif;opacity:.85">&#8962;</a>';
  data.stream = data.stream.pipe(
    new Transform({
      decodeStrings: false,
      transform(chunk, encoding, next) {
        let str = chunk.toString();
        if (!done && /<body[^>]*>/i.test(str)) {
          str = str.replace(/(<body[^>]*>)/i, "$1" + button);
          done = true;
        }
        this.push(str, "utf8");
        next();
      },
    })
  );
}

const unblocker = Unblocker({
  prefix: "/proxy/",
  requestMiddleware: [stripPrivateHeaders],
  responseMiddleware: [homeButton],
});

const app = express();

// Vercel (and most hosts) sit behind a reverse proxy; trust it so https links are generated correctly.
app.set("trust proxy", true);
app.disable("x-powered-by");

// Bare server requests go first, before anything else touches them.
app.use((req, res, next) => {
  if (bare.shouldRoute(req)) {
    bare.routeRequest(req, res);
  } else {
    next();
  }
});

// Read these files with literal paths so Vercel bundles them with the server.
const HOME_PAGE = fs.readFileSync(path.join(__dirname, "static", "index.html"));
const CLIENT_SCRIPT = fs.readFileSync(
  path.join(__dirname, "lib", "client", "unblocker-client.js")
);
const ASSETS = {
  "/uv/uv.bundle.js": fs.readFileSync(
    path.join(
      __dirname,
      "node_modules",
      "@titaniumnetwork-dev",
      "ultraviolet",
      "dist",
      "uv.bundle.js"
    )
  ),
  "/uv/uv.client.js": fs.readFileSync(
    path.join(
      __dirname,
      "node_modules",
      "@titaniumnetwork-dev",
      "ultraviolet",
      "dist",
      "uv.client.js"
    )
  ),
  "/uv/uv.handler.js": fs.readFileSync(
    path.join(
      __dirname,
      "node_modules",
      "@titaniumnetwork-dev",
      "ultraviolet",
      "dist",
      "uv.handler.js"
    )
  ),
  "/uv/uv.sw.js": fs.readFileSync(
    path.join(
      __dirname,
      "node_modules",
      "@titaniumnetwork-dev",
      "ultraviolet",
      "dist",
      "uv.sw.js"
    )
  ),
  "/uv/uv.config.js": fs.readFileSync(
    path.join(__dirname, "static", "uv", "uv.config.js")
  ),
  "/uv/sw.js": fs.readFileSync(path.join(__dirname, "static", "uv", "sw.js")),
  "/baremux/index.mjs": fs.readFileSync(
    path.join(
      __dirname,
      "node_modules",
      "@mercuryworkshop",
      "bare-mux",
      "dist",
      "index.mjs"
    )
  ),
  "/baremux/worker.js": fs.readFileSync(
    path.join(
      __dirname,
      "node_modules",
      "@mercuryworkshop",
      "bare-mux",
      "dist",
      "worker.js"
    )
  ),
  "/baremod/index.mjs": fs.readFileSync(
    path.join(
      __dirname,
      "node_modules",
      "@mercuryworkshop",
      "bare-as-module3",
      "dist",
      "index.mjs"
    )
  ),
};

app.get("/", (req, res) => {
  res.type("html").set("Cache-Control", "no-cache").send(HOME_PAGE);
});

app.get(Object.keys(ASSETS), (req, res) => {
  res
    .type("js")
    // the service worker script must not be cached long or updates get stuck
    .set(
      "Cache-Control",
      req.path === "/uv/sw.js"
        ? "no-cache"
        : "public, max-age=3600, s-maxage=86400"
    )
    .send(ASSETS[req.path]);
});

// Pages under /uv/service/ are normally answered by the service worker in the
// browser. If one reaches the server, the worker isn't running yet: send the
// visitor home so it can start.
app.get("/uv/service/*splat", (req, res) => {
  res.redirect("/");
});

app.get("/proxy/client/unblocker-client.js", (req, res) => {
  res
    .type("js")
    .set("Cache-Control", "public, max-age=600")
    .send(CLIENT_SCRIPT);
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
        `<body style="font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;text-align:center">` +
        `<h1 style="font-size:24px">Couldn't load that site</h1>` +
        `<p style="color:#777">The site didn't respond or blocked the proxy (${msg}).</p>` +
        `<p><a href="/" style="color:#4f46e5;font-weight:600">Back to home</a></p></body>`
    );
});

app.unblocker = unblocker;
app.bare = bare;

module.exports = app;
