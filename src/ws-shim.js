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
    console.log('[ws-shim] connecting to', httpUrl);

    fetch(httpUrl, { headers: { Upgrade: 'websocket' } })
      .then((resp) => {
        console.log('[ws-shim] fetch resolved, status', resp.status, 'has webSocket:', !!resp.webSocket);
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

        forward('close', (ev) => {
          this._readyState = WebSocketShim.CLOSED;
          return [ev.code, ev.reason];
        });
        forward('error', (ev) => [ev.error || new Error('WebSocket error')]);

        // Message handling is separate from forward() because Blob data
        // needs an async read — confirmed by logging: Workers' fetch-
        // upgrade WebSocket delivers binary frames as Blob, not ArrayBuffer.
        this._ws.addEventListener('message', async (ev) => {
          let data = ev.data;
          if (typeof data === 'string') {
            // keep as-is
          } else if (data instanceof ArrayBuffer) {
            data = Buffer.from(data);
          } else if (ArrayBuffer.isView(data)) {
            data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          } else if (data && typeof data.arrayBuffer === 'function') {
            data = Buffer.from(await data.arrayBuffer());
          } else {
            console.log('[ws-shim] unexpected message data type:', typeof data, data?.constructor?.name);
            return;
          }
          for (const cb of this._listeners['message'] || []) cb(data);
        });

        for (const { data, cb } of this._sendQueue) this.send(data, cb);
        this._sendQueue = [];

        for (const cb of this._listeners['open'] || []) cb();
      })
      .catch((err) => {
        console.log('[ws-shim] connection attempt failed:', err.message);
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
      // Workers' native send() doesn't accept the nodejs_compat-polyfilled
      // Buffer type directly, even though Buffer is conceptually a
      // Uint8Array — convert explicitly to a real Uint8Array first.
      const payload = Buffer.isBuffer(data) ? new Uint8Array(data) : data;
      this._ws.send(payload);
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
