"use strict";

// Run locally with: npm start
const app = require("./app.js");

const port = process.env.PORT || 8080;
app.listen(port).on("upgrade", app.unblocker.onUpgrade);

console.log(`proxy running at http://localhost:${port}/`);
