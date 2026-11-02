"use strict";

const path = require("path");
const express = require("express");
const Unblocker = require("./lib/unblocker.js");

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
    '<a href="/" id="__ub_home" title="Back to proxy home" style="all:initial;position:fixed;z-index:2147483647;' +
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

app.use(unblocker);

// Vercel serves /public from its CDN; this is for running locally.
app.use(express.static(path.join(__dirname, "public")));

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

module.exports = app;
