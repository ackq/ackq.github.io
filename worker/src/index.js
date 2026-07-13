/*
 * transcribe-proxy — minimal backend for https://ackq.github.io/transcribe/
 *
 * Keeps the Sarvam API key server-side and gates every call behind a shared
 * password. Two routes:
 *   POST /auth        — verifies the password (fast feedback at "login")
 *   POST /transcribe  — raw WAV chunk (≤30 s) → Sarvam speech-to-text
 *   POST /review      — { text } → Sarvam chat completions (Hindi proofreading)
 *
 * Secrets (wrangler secret put): SARVAM_API_KEY, APP_PASSWORD
 */

const ALLOWED_ORIGINS = [
  "https://ackq.github.io",
  "http://localhost:8000", // local testing: python3 -m http.server
];

const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";
const SARVAM_CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";
const REVIEW_MODEL = "sarvam-105b";

const MAX_CHUNK_BYTES = 4 * 1024 * 1024; // ~28 s of 16 kHz 16-bit WAV is ~900 KB
const MAX_REVIEW_CHARS = 20000;

// Instructions in Hindi: primes Devanagari output and Sarvam models follow it
// well. The hard constraint is "fix errors, never rewrite the author".
const REVIEW_PROMPT = `आप एक अनुभवी हिंदी प्रूफ़रीडर हैं। नीचे एक वरिष्ठ हिंदी कवि/उपन्यासकार की कैसेट रिकॉर्डिंग का मशीन-ट्रांसक्रिप्शन (ASR) है। आपका काम केवल त्रुटियाँ सुधारना है, लेखन बदलना नहीं।

सुधारें:
- ASR की सुनने की ग़लतियाँ (मिलते-जुलते शब्द, जैसे "समान/सामान", "कहा/कहाँ")
- मात्रा, अनुस्वार, चंद्रबिंदु और नुक़्ते की त्रुटियाँ
- ग़लत जुड़े या टूटे शब्द
- विराम-चिह्न: पूर्ण विराम (।), अल्पविराम, प्रश्नचिह्न, उद्धरण-चिह्न
- वाक्य और अनुच्छेद की सीमाएँ

कभी न करें:
- लेखक के शब्द, शैली, बोली या पुराने/साहित्यिक प्रयोग न बदलें
- उर्दू-फ़ारसी शब्दों का "शुद्धिकरण" न करें
- कुछ भी जोड़ें, हटाएँ या संक्षेप न करें; व्याख्या न लिखें
- यदि पंक्तियाँ कविता जैसी हों, तो पंक्ति-विभाजन वैसा ही रखें और छंद/शब्द-चयन को बिल्कुल न छेड़ें
- जहाँ अर्थ अस्पष्ट हो, वहाँ अनुमान से नया शब्द न गढ़ें — मूल शब्द ही रहने दें

उत्तर में केवल सुधारा हुआ पाठ दें, कोई भूमिका या टिप्पणी नहीं।`;

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowedOrigin = ALLOWED_ORIGINS.find((o) => origin === o || (o === "http://localhost:8000" && origin.startsWith("http://localhost:")));

    if (req.method === "OPTIONS") return preflight(allowedOrigin);
    if (!allowedOrigin) return json({ error: "forbidden" }, 403);

    const cors = (resp) => withCors(resp, allowedOrigin);

    if (!(await passwordOk(req, env))) {
      // Failed guesses consume their own strict bucket (5/min/IP) so a
      // brute-force attempt stalls almost immediately; the delay makes even
      // those five guesses slow. Successful logins never touch this bucket.
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      if (env.RL_FAIL) {
        const { success } = await env.RL_FAIL.limit({ key: ip });
        if (!success) return cors(json({ error: "too_many_attempts" }, 429));
      }
      await new Promise((r) => setTimeout(r, 500));
      return cors(json({ error: "unauthorized" }, 401));
    }

    if (env.RL) {
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return cors(json({ error: "rate_limited" }, 429));
    }

    const path = new URL(req.url).pathname;
    try {
      if (req.method === "POST" && path === "/auth") return cors(json({ ok: true }));
      if (req.method === "POST" && path === "/transcribe") return cors(await handleTranscribe(req, env));
      if (req.method === "POST" && path === "/review") return cors(await handleReview(req, env));
    } catch (e) {
      return cors(json({ error: "worker_error", detail: String(e && e.message || e) }, 500));
    }
    return cors(json({ error: "not_found" }, 404));
  },
};

async function passwordOk(req, env) {
  const given = req.headers.get("X-App-Password");
  if (!given || !env.APP_PASSWORD) return false;
  // Hash both sides so lengths are equal, then compare in constant time.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(env.APP_PASSWORD)),
  ]);
  const va = new Uint8Array(a), vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function handleTranscribe(req, env) {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > MAX_CHUNK_BYTES) return json({ error: "chunk_too_large" }, 413);

  const wav = await req.arrayBuffer();
  if (wav.byteLength === 0) return json({ error: "empty_body" }, 400);
  if (wav.byteLength > MAX_CHUNK_BYTES) return json({ error: "chunk_too_large" }, 413);

  // The Worker owns all Sarvam parameters — the client only sends audio bytes,
  // so a stolen password can't be used with arbitrary models/modes.
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
  form.append("model", "saaras:v3");
  form.append("mode", "transcribe");
  form.append("language_code", "hi-IN");

  const upstream = await fetch(SARVAM_STT_URL, {
    method: "POST",
    headers: { "api-subscription-key": env.SARVAM_API_KEY },
    body: form, // fetch sets the multipart boundary itself
  });

  if (!upstream.ok) return upstreamError(upstream, await safeText(upstream));

  const data = await upstream.json();
  return json({ transcript: data.transcript || "", request_id: data.request_id });
}

async function handleReview(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json({ error: "empty_text" }, 400);
  if (text.length > MAX_REVIEW_CHARS) return json({ error: "text_too_long" }, 413);

  const upstream = await fetch(SARVAM_CHAT_URL, {
    method: "POST",
    headers: {
      "api-subscription-key": env.SARVAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: REVIEW_MODEL,
      temperature: 0.2,
      // sarvam-105b is a reasoning model: it spends tokens thinking before
      // answering, so the cap must cover reasoning + the full corrected text.
      // 4096 is the max on the starter tier; the client keeps batches small
      // (~2500 chars) so both always fit.
      max_tokens: 4096,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: REVIEW_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });

  if (!upstream.ok) return upstreamError(upstream, await safeText(upstream));

  const data = await upstream.json();
  const corrected = data?.choices?.[0]?.message?.content;
  if (!corrected) {
    return json({ error: "empty_completion", detail: data?.choices?.[0]?.finish_reason || "" }, 502);
  }
  return json({ corrected: corrected.trim() });
}

// Map Sarvam errors so the client's retry logic can key off status codes:
// 429/5xx pass through (retryable); anything that smells of billing → 402;
// a bad server-side key → 502 (the family user can't fix that, we can).
function upstreamError(upstream, detail) {
  const s = upstream.status;
  const lower = (detail || "").toLowerCase();
  if (s === 402 || lower.includes("credit") || lower.includes("quota") || lower.includes("insufficient")) {
    return json({ error: "credits_exhausted", detail }, 402);
  }
  if (s === 401 || s === 403) return json({ error: "server_key_invalid", detail }, 502);
  if (s === 429) return json({ error: "rate_limited_upstream", detail }, 429);
  if (s >= 500) return json({ error: "upstream_error", detail }, 502);
  return json({ error: "upstream_rejected", detail }, 400);
}

async function safeText(resp) {
  try {
    return (await resp.text()).slice(0, 500);
  } catch {
    return "";
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCors(resp, origin) {
  const r = new Response(resp.body, resp);
  r.headers.set("Access-Control-Allow-Origin", origin);
  r.headers.set("Vary", "Origin");
  return r;
}

function preflight(origin) {
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-App-Password",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    },
  });
}
