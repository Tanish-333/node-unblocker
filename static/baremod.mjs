/*
 * HTTP fallback transport (used when the server can't take websockets).
 *
 * The original sends form data (like a login form's email and password) as a
 * stream. Browsers only allow streamed uploads over HTTP/2, so on HTTP/1.1
 * every form submit failed with "Failed to fetch". Form bodies are small, so
 * they are read in full first and sent normally.
 */
// eslint-disable-next-line node/no-missing-import -- served by app.js
import Base from "/baremod/base.mjs";

export default class BareTransport extends Base {
  async request(remote, method, body, headers, signal) {
    if (body instanceof ReadableStream) {
      body = await new Response(body).arrayBuffer();
    }
    return super.request(remote, method, body, headers, signal);
  }
}

export { BareTransport as BareClient };
