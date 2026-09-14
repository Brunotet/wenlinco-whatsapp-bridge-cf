// Baileys hardcodes `import WebSocket from 'ws'` and uses it with a
// Node-style EventEmitter API (.on(), readyState, static OPEN/CLOSED/etc).
// Workers has no 'ws' package — it has a native WebSocket global instead.
// This shim wraps the native WebSocket so Baileys' code runs unmodified;
// wrangler.toml aliases the 'ws' import to this file at build time.

export default class WebSocketShim {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, options = {}) {
    // Workers' native WebSocket constructor doesn't accept Node-style
    // options (headers/agent/handshakeTimeout) — those aren't supported
    // for outbound client connections in workerd today, so they're
    // intentionally dropped rather than silently ignored elsewhere.
    this._ws = new WebSocket(url);
    // WhatsApp's protocol is binary (protobuf frames). Native WebSocket
    // defaults to delivering binary messages as Blob; Baileys' parser
    // expects Node Buffer-like data. Without this, frames arrive in a
    // shape Baileys can't read, and the connection stalls silently
    // instead of erroring — which is what "stuck on starting" pointed to.
    this._ws.binaryType = 'arraybuffer';
    this._listeners = {};

    const forward = (type, mapArgs) => {
      this._ws.addEventListener(type, (ev) => {
        const args = mapArgs ? mapArgs(ev) : [];
        for (const cb of this._listeners[type] || []) cb(...args);
      });
    };

    forward('open');
    forward('message', (ev) => {
      const data =
        ev.data instanceof ArrayBuffer
          ? Buffer.from(ev.data)
          : typeof ev.data === 'string'
            ? ev.data
            : Buffer.from(ev.data); // fallback for any other typed array
      return [data];
    });
    forward('close', (ev) => [ev.code, ev.reason]);
    forward('error', (ev) => [ev.error || new Error('WebSocket error')]);
    // Note: native WebSocket doesn't surface 'ping'/'pong'/'upgrade' at the
    // JS level — those are handled transparently by the runtime. Baileys
    // manages its own application-level keepalive separately, so this is
    // expected to be a no-op gap, not a functional blocker.
  }

  on(event, cb) {
    (this._listeners[event] ||= []).push(cb);
    return this;
  }

  send(data, cb) {
    try {
      this._ws.send(data);
      if (cb) cb();
    } catch (err) {
      if (cb) cb(err);
    }
  }

  close(code, reason) {
    this._ws.close(code, reason);
  }

  setMaxListeners() {
    // no-op — Node EventEmitter API surface, not needed on the native impl
  }

  get readyState() {
    return this._ws.readyState;
  }
}
