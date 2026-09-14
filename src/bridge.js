import { DurableObject } from 'cloudflare:workers';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import { useDurableObjectAuthState } from './auth-state.js';

const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // re-check connection every 5 min

export class WhatsAppBridge extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sock = null;
    this.latestQR = null;
    this.connectionStatus = 'starting';

    // blockConcurrencyWhile ensures no request is served until the socket
    // has at least attempted to start — same pattern as a normal server's
    // startup sequence, just scoped to this Durable Object instance.
    this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
      await this.startSocket();
    });
  }

  async startSocket() {
    try {
      const { state, saveCreds } = await useDurableObjectAuthState(this.ctx.storage);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['Wenlinco Bridge', 'Chrome', '1.0'],
      });

      // Low-level visibility: does the raw transport ever open at all,
      // independent of whether Baileys' own handshake logic proceeds?
      this.sock.ws.on('open', () => console.log('[ws] raw socket opened'));
      this.sock.ws.on('close', (code, reason) =>
        console.log('[ws] raw socket closed', code, reason?.toString?.())
      );
      this.sock.ws.on('error', (err) => console.log('[ws] raw socket error:', err?.message || err));

      this.sock.ev.on('creds.update', saveCreds);

      // If nothing happens within 15s, stop sitting silently on "starting"
      // — report it so a stall is visible from /health without needing logs.
      setTimeout(() => {
        if (this.connectionStatus === 'starting') {
          this.connectionStatus = 'error: timed out waiting for the raw socket to open or fail (see dashboard Logs)';
        }
      }, 15000);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.latestQR = await QRCode.toDataURL(qr);
          this.connectionStatus = 'awaiting_qr_scan';
        }

        if (connection === 'open') {
          this.connectionStatus = 'connected';
          this.latestQR = null;
        }

        if (connection === 'close') {
          const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          this.connectionStatus = loggedOut ? 'logged_out' : 'reconnecting';
          if (loggedOut) {
            await this.ctx.storage.deleteAll();
          } else {
            // reconnect inline rather than waiting for the watchdog alarm,
            // so a dropped connection recovers within seconds, not minutes
            this.startSocket().catch(() => {});
          }
        }
      });

      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          if (!msg.message || msg.key.fromMe) continue;
          const from = msg.key.remoteJid;
          const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            '';
          if (!from || !text || !this.env.N8N_WEBHOOK_URL) continue;
          try {
            await fetch(this.env.N8N_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from, text, timestamp: msg.messageTimestamp }),
            });
          } catch (err) {
            console.error('[n8n] webhook forward failed:', err.message);
          }
        }
      });
    } catch (err) {
      console.error('[wa] startSocket failed:', err.message);
      this.connectionStatus = 'error: ' + err.message;
    }
  }

  // Runs even if the instance went idle — Cloudflare wakes the Durable
  // Object specifically to execute this, then it's free to go idle again.
  async alarm() {
    if (this.connectionStatus !== 'connected') {
      await this.startSocket();
    }
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: this.connectionStatus, time: new Date().toISOString() });
    }

    if (url.pathname === '/qr') {
      if (this.connectionStatus === 'connected') {
        return new Response('<h3>Already connected — no QR needed.</h3>', {
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (!this.latestQR) {
        return new Response('<h3>No QR yet — refresh in a few seconds.</h3>', {
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return new Response(
        `<html><body style="text-align:center;font-family:sans-serif">
          <h3>Scan with WhatsApp on the dedicated SIM (Linked Devices)</h3>
          <img src="${this.latestQR}" />
        </body></html>`,
        { headers: { 'Content-Type': 'text/html' } }
      );
    }

    if (url.pathname === '/send' && request.method === 'POST') {
      if (this.env.API_KEY && request.headers.get('x-api-key') !== this.env.API_KEY) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const { to, message } = await request.json();
      if (!to || !message) {
        return Response.json({ error: 'missing "to" or "message"' }, { status: 400 });
      }
      if (this.connectionStatus !== 'connected') {
        return Response.json(
          { error: `not connected (status: ${this.connectionStatus})` },
          { status: 503 }
        );
      }
      try {
        const jid = to.includes('@') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 3000));
        await this.sock.sendPresenceUpdate('composing', jid);
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
        await this.sock.sendMessage(jid, { text: message });
        return Response.json({ status: 'sent', to: jid });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    return new Response('not found', { status: 404 });
  }
}
