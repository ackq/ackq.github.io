# transcribe-proxy — deploy runbook

Cloudflare Worker backend for https://ackq.github.io/transcribe/. It holds the
Sarvam API key as a secret and checks the shared family password on every call.

## 1. Sarvam API key (one time, ~2 minutes)

1. Sign in at https://dashboard.sarvam.ai (₹100 free credits on signup).
2. Left sidebar → **API Keys** → **Create key** (any name, e.g. `transcribe`).
3. Copy the key immediately — it is shown only once.
4. Pricing lives under Billing. A 60-minute tape ≈ ~120 speech-to-text calls
   plus ~10 chat (proofreading) calls. Recharge there when credits run low.

## 2. Deploy the Worker (from this folder)

```bash
cd worker
npx wrangler login              # opens browser once, authorize Cloudflare
npx wrangler deploy             # prints https://transcribe-proxy.<account>.workers.dev
npx wrangler secret put SARVAM_API_KEY   # paste the Sarvam key
npx wrangler secret put APP_PASSWORD     # choose the family password
```

Rate limits: failed password guesses are capped at 5/min per IP (plus a
0.5 s delay per failure); authenticated traffic at 30/min per IP. If
`deploy` ever complains about the `[[ratelimits]]` blocks, delete them and
redeploy — the code works without them.

## 3. Wire up the page

Paste the printed `workers.dev` URL into the `WORKER_URL` constant near the top
of the `<script>` in `../transcribe/index.html`, commit, push. GitHub Pages
serves it within a minute.

## Changing things later

- **Change the password**: `npx wrangler secret put APP_PASSWORD` (new value),
  then tell the family. No redeploy needed.
- **Tweak the proofreading prompt**: edit `REVIEW_PROMPT` in `src/index.js`,
  then `npx wrangler deploy`.
- **Smoke test** (replace URL/password):

```bash
# wrong password → {"error":"unauthorized"} 401
curl -s -X POST https://transcribe-proxy.<account>.workers.dev/auth \
  -H "Origin: https://ackq.github.io" -H "X-App-Password: wrong" -i
# right password → {"ok":true}
curl -s -X POST https://transcribe-proxy.<account>.workers.dev/auth \
  -H "Origin: https://ackq.github.io" -H "X-App-Password: <password>" -i
```
