/*
 * Small fixes added to the top of every proxied page.
 *
 * FedCM: Chrome's built-in "Sign in with Google" prompt talks to Google
 * directly, outside the proxy, so through a proxy it always fails and the
 * sign-in button can get stuck. Hiding it makes Google's sign-in script fall
 * back to its normal pop-up / redirect flow, which goes through the proxy.
 *
 * Staying in the tab: login buttons and forms often use target="_top" (or
 * "_parent"), which replaced the whole Slipstream page with the site. When the
 * page is a Slipstream tab, those now open in the tab itself, which is what
 * the site means by "_top" there anyway.
 */
// slipPageFix is used by the service workers that importScripts() this file
const SLIP_PAGE_SCRIPT =
  "<script>(function(){try{delete window.IdentityCredential}catch(e){}" +
  "try{var c=navigator.credentials;if(c&&c.get){var g=c.get.bind(c);" +
  'c.get=function(o){if(o&&o.identity)return Promise.reject(new DOMException("FedCM is not available","NotAllowedError"));return g(o)}}}catch(e){}' +
  "})();" +
  "(function(){try{var p=window.parent;if(p===window||!p.__slipApp)return;" +
  'var T=/^_(top|parent)$/i,F="formtarget";' +
  "function base(){var b=document.querySelector('base[target]');return b&&T.test(b.getAttribute('target'))}" +
  "function fix(el,attr){if(!el||!el.getAttribute)return;var t=el.getAttribute(attr);" +
  "if(t?T.test(t):attr==='target'&&base())el.setAttribute(attr,'_self')}" +
  'addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href],area[href]");fix(a,"target");' +
  'var b=e.target&&e.target.closest&&e.target.closest("button,input");if(b)fix(b,F)},true);' +
  'addEventListener("submit",function(e){fix(e.target,"target");if(e.submitter)fix(e.submitter,F)},true);' +
  "var P=HTMLFormElement.prototype,s=P.submit;P.submit=function(){fix(this,'target');return s.apply(this,arguments)}" +
  "}catch(e){}})()</script>";
const SLIP_PAGE_BYTES = new TextEncoder().encode(SLIP_PAGE_SCRIPT);
const SLIP_SEARCH_LIMIT = 64 * 1024; // only look for <head> near the start

// Finds the end of the first "<head ...>" tag in ASCII bytes (case-insensitive).
function slipFindHeadEnd(bytes) {
  for (let i = 0; i + 5 < bytes.length; i++) {
    if (
      bytes[i] === 60 && // <
      (bytes[i + 1] | 32) === 104 && // h
      (bytes[i + 2] | 32) === 101 && // e
      (bytes[i + 3] | 32) === 97 && // a
      (bytes[i + 4] | 32) === 100 && // d
      (bytes[i + 5] === 62 ||
        bytes[i + 5] === 32 ||
        bytes[i + 5] === 9 ||
        bytes[i + 5] === 10 ||
        bytes[i + 5] === 13)
    ) {
      for (let j = i + 5; j < bytes.length; j++)
        if (bytes[j] === 62) return j + 1;
      return -1;
    }
  }
  return -1;
}

// Works on raw bytes (no text decoding), so pages in any encoding are untouched
// apart from the inserted script, and the page still streams in as it arrives.
// eslint-disable-next-line no-unused-vars
function slipPageFix(event, res) {
  try {
    return slipPageFixInner(event, res);
  } catch (e) {
    return res; // never break a page because of this fix
  }
}

function slipPageFixInner(event, res) {
  const dest = event.request.destination;
  const type = res.headers.get("content-type") || "";
  if (
    (dest !== "document" && dest !== "iframe") ||
    !/text\/html/i.test(type) ||
    !res.body
  ) {
    return res;
  }
  let pending = new Uint8Array(0);
  let done = false;
  const body = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (done) return controller.enqueue(chunk);
        const all = new Uint8Array(pending.length + chunk.length);
        all.set(pending);
        all.set(chunk, pending.length);
        const at = slipFindHeadEnd(all);
        if (at >= 0) {
          controller.enqueue(all.subarray(0, at));
          controller.enqueue(SLIP_PAGE_BYTES);
          controller.enqueue(all.subarray(at));
          done = true;
        } else if (all.length > SLIP_SEARCH_LIMIT) {
          controller.enqueue(all); // no <head> found early: leave the page alone
          done = true;
        } else {
          pending = all; // wait for more of the page
        }
      },
      flush(controller) {
        if (!done && pending.length) controller.enqueue(pending);
      },
    })
  );
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
