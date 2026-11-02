"use strict";

// Run locally with: npm start
const app = require("./app.js");

const port = process.env.PORT || 8080;
const server = app.listen(port);

// websockets (only work when running on your own server, not on Vercel)
server.on("upgrade", (req, socket, head) => {
  if (app.bare.shouldRoute(req)) {
    app.bare.routeUpgrade(req, socket, head);
  } else {
    app.unblocker.onUpgrade(req, socket, head);
  }
});

console.log(`proxy running at http://localhost:${port}/`);
