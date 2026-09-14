// Baileys hardcodes `import WebSocket from 'ws'` and uses it with a
// Node-style EventEmitter API (.on(), readyState, static OPEN/CLOSED/etc).
// Workers has no 'ws' package, and — critically — cannot open outbound
// WebSockets via `new WebSocket(url)` at all; that constructor form is for
// browser-style client sockets, which workerd does not implement for
// outbound connections. The documented way to open one is a fetch()
// request with an Upgrade header, which hands back the socket on the
// response. This shim bridges that into the synchronous, EventEmitter-
// style interface Baileys expects, via wrangler.toml's alias for 'ws'.

export default class WebSocketShim {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this._listeners = {};
    this._readyState = WebSocketShim.CONNECTING;
    this._sendQueue = [];
    this._ws = null;

    // Baileys passes a URL object here, not a plain string.
    const urlStr = typeof url === 'string' ? url : url.href;
    const httpUrl = urlStr.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

    fetch(httpUrl, { headers: { Upgrade: 'websocket' } })
      .then((resp) => {
        if (!resp.webSocket) {
          throw new Error(`WebSocket upgrade failed: server responded with HTTP ${resp.status}`);
        }
        this._ws = resp.webSocket;
        this._ws.accept();
        this._readyState = WebSocketShim.OPEN;

        const forward = (type, mapArgs) => {
          this._ws.addEventListener(type, (ev) => {
            const args = mapArgs ? mapArgs(ev) : [];
            for (const cb of this._listeners[type] || []) cb(...args);
          });
        };

        forward('message', (ev) => {
          const data =
            ev.data instanceof ArrayBuffer
              ? Buffer.from(ev.data)
              : typeof ev.data === 'string'
                ? ev.data
                : Buffer.from(ev.data);
          return [data];
        });
        forward('close', (ev) => {
          this._readyState = WebSocketShim.CLOSED;
          return [ev.code, ev.reason];
        });
        forward('error', (ev) => [ev.error || new Error('WebSocket error')]);

        for (const { data, cb } of this._sendQueue) this.send(data, cb);
        this._sendQueue = [];

        for (const cb of this._listeners['open'] || []) cb();
      })
      .catch((err) => {
        this._readyState = WebSocketShim.CLOSED;
        for (const cb of this._listeners['error'] || []) cb(err);
        for (const cb of this._listeners['close'] || []) cb(1006, err.message);
      });
  }

  on(event, cb) {
    (this._listeners[event] ||= []).push(cb);
    return this;
  }

  send(data, cb) {
    if (!this._ws) {
      this._sendQueue.push({ data, cb });
      return;
    }
    try {
      this._ws.send(data);
      if (cb) cb();
    } catch (err) {
      if (cb) cb(err);
    }
  }

  close(code, reason) {
    this._readyState = WebSocketShim.CLOSING;
    this._ws?.close(code, reason);
  }

  setMaxListeners() {
    // no-op — Node EventEmitter API surface, not needed here
  }

  get readyState() {
    return this._readyState;
  }
}
