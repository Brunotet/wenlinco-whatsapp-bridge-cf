# Cloudflare Workers WhatsApp bridge — prototype test guide

## What this is, honestly

This is a working prototype, not a finished product. Here's exactly what's
been verified and what hasn't:

**Verified, in the real Cloudflare runtime (not a simulation):**
- Baileys imports and bundles cleanly for Workers (1.5MB gzipped, well
  under the size limit)
- The custom Durable Object storage adapter (replacing the filesystem
  Baileys normally needs) works
- The `ws`-package shim (mapping Baileys' hardcoded Node WebSocket calls
  onto Workers' native WebSocket) works mechanically — with it in place,
  the code gets all the way to Baileys attempting a real WebSocket
  handshake with WhatsApp's actual server. Without it, the connection
  died instantly on import.

**Not verified, and can't be from where I'm running:** whether that
handshake actually completes and stays open. My sandbox can't reach
WhatsApp's servers at all (its network is locked to a short allowlist of
developer domains), so the furthest I got was a same-shaped connection
attempt that failed for network-access reasons on my end, not
confirmation it works end to end. That's the one thing only a real
deploy from your side can answer.

## Steps to actually test it

1. **Install Wrangler locally** (or use it via `npx` as below) and sign in:
   ```bash
   npm install
   npx wrangler login
   ```
   Opens a browser to authorize — free Cloudflare account, no card
   required to sign up.

2. **Set secrets** (not committed to the repo):
   ```bash
   npx wrangler secret put API_KEY
   npx wrangler secret put N8N_WEBHOOK_URL
   ```
   Paste each value when prompted.

3. **Deploy:**
   ```bash
   npx wrangler deploy
   ```
   This prints your Worker's URL — something like
   `https://wenlinco-whatsapp-bridge.<your-subdomain>.workers.dev`.

4. **Check status:**
   ```
   https://<your-worker-url>/health
   ```
   Expect `"status":"starting"` briefly, then either `"awaiting_qr_scan"`
   (good — means it reached WhatsApp's server successfully) or an
   `"error: ..."` message (tells us exactly where it broke for real).

5. **If you see `awaiting_qr_scan`**, visit:
   ```
   https://<your-worker-url>/qr
   ```
   and scan it with the dedicated SIM's WhatsApp (Linked Devices → Link a
   Device). If it connects and `/health` flips to `"connected"`, this
   approach is confirmed working — genuinely free, no VPS, no prepayment.

6. **Report back exactly what `/health` shows** at each stage, especially
   any `"error: ..."` text — that pinpoints precisely what (if anything)
   still needs fixing, rather than more guessing.

## Known rough edges (not yet handled, only matters if step 5 succeeds)

- No reconnect backoff tuning yet — it retries immediately on drop, which
  is fine for a test but should get proper spacing before real use.
- `/send` pacing (the human-like delay before sending) is in place and
  unchanged from the VPS version.
- Durable Object cost math (from earlier): should land well inside the
  free 400K GB-seconds/month allowance for continuous operation, but this
  hasn't been measured against real usage yet.
