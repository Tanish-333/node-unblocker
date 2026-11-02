"use strict";

// Start with: npm start   (this is what Render runs)
const http = require("http");
// eslint-disable-next-line node/no-missing-require -- package "exports" path, resolves fine
const { server: wisp } = require("@mercuryworkshop/wisp-js/server");
const app = require("./app.js");

// ---- Wisp (fast websocket transport used by the Scramjet engine) ----
wisp.options.allow_udp_streams = false; // only TCP is needed for websites
wisp.options.dns_result_order = "ipv4first"; // avoid slow IPv6 attempts on hosts without IPv6
// Only web ports: blocks mail (25/465/587), SSH (22) and other low ports so the
// server can't be used to send spam or attack other services.
wisp.options.port_blacklist = [
  [1, 79],
  [81, 442],
  [444, 1023],
];
if (app.allowLocal) {
  wisp.options.allow_loopback_ips = true;
  wisp.options.allow_private_ips = true;
}

// tell the page this server accepts websockets, so it uses the fast transport
app.wispEnabled = true;

const server = http.createServer(app);

// Keep connections open longer than Render's load balancer so they get reused.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/wisp/")) {
    wisp.routeRequest(req, socket, head);
  } else if (app.bare.shouldRoute(req)) {
    app.bare.routeUpgrade(req, socket, head);
  } else {
    app.unblocker.onUpgrade(req, socket, head);
  }
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Slipstream running at http://localhost:${port}/`);
});
