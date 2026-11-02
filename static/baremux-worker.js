/*
 * Wrapper around bare-mux's shared worker (it carries every proxied request).
 *
 * The browser shuts this worker down when the Slipstream page goes away, for
 * example when a site's login button opens in the whole window instead of in
 * the tab. The worker then started again without knowing which connection to
 * use, so every request failed ("No BareTransport was set") and the page
 * stayed blank. The connection settings are now saved, and put back
 * automatically when a fresh worker gets a request before being set up.
 */

importScripts("/baremux/worker-base.js");

const SLIP_DB = "slip-baremux";
let slipIsSet = false;
let slipRestoring = null;

function slipDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SLIP_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function slipSave(client) {
  try {
    const db = await slipDb();
    db.transaction("kv", "readwrite")
      .objectStore("kv")
      .put(client, "transport");
  } catch (e) {
    // storage blocked (private mode etc.): nothing to restore later
  }
}

async function slipLoad() {
  try {
    const db = await slipDb();
    return await new Promise((resolve) => {
      const req = db.transaction("kv").objectStore("kv").get("transport");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

// replays the saved "set transport" message into bare-mux's own handler
function slipRestore(handler) {
  if (!slipRestoring) {
    slipRestoring = (async () => {
      const client = await slipLoad();
      if (!client || slipIsSet) return;
      const channel = new MessageChannel();
      const done = new Promise((resolve) => {
        channel.port2.onmessage = () => resolve();
        setTimeout(resolve, 5000);
      });
      handler({
        data: { message: { type: "set", client }, port: channel.port1 },
      });
      await done;
      slipIsSet = true;
    })().finally(() => {
      slipRestoring = null;
    });
  }
  return slipRestoring;
}

// Scramjet downloads the Public Suffix List (~250 KB) from publicsuffix.org
// the first time a login redirects between subdomains (login.site.com ->
// app.site.com). If that download was slow or failed, the login crashed with
// an error page. A copy ships with Slipstream and is answered from here.
const SLIP_PSL = "https://publicsuffix.org/list/public_suffix_list.dat";
let slipPslBody = null;

async function slipAnswerPsl(port) {
  try {
    if (!slipPslBody) {
      const res = await fetch("/public_suffix_list.dat");
      if (!res.ok) throw new Error("status " + res.status);
      slipPslBody = await res.text();
    }
    const body = new TextEncoder().encode(slipPslBody).buffer;
    port.postMessage(
      {
        type: "fetch",
        fetch: {
          body,
          headers: { "content-type": "text/plain; charset=utf-8" },
          status: 200,
          statusText: "OK",
        },
      },
      [body]
    );
    return true;
  } catch (e) {
    return false; // let the normal request try instead
  }
}

const slipOriginalConnect = self.onconnect;
self.onconnect = (event) => {
  const port = event.ports[0];
  slipOriginalConnect(event); // bare-mux sets port.onmessage here
  const handler = port.onmessage;
  port.onmessage = async (e) => {
    const msg = e.data && e.data.message;
    if (
      msg &&
      msg.type === "fetch" &&
      msg.fetch &&
      msg.fetch.remote === SLIP_PSL &&
      (await slipAnswerPsl(e.data.port))
    ) {
      return;
    }
    if (msg && msg.type === "set") {
      slipIsSet = true;
      // a transport handed over as a MessagePort can't be stored
      if (
        msg.client &&
        typeof msg.client.function === "string" &&
        msg.client.function !== "bare-mux-remote"
      ) {
        slipSave(msg.client);
      }
    } else if (
      msg &&
      (msg.type === "fetch" || msg.type === "websocket") &&
      !slipIsSet
    ) {
      await slipRestore(handler);
    }
    handler(e);
  };
};
