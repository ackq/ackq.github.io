# श्रुतलेख (Shrutlekh) — Project Documentation

*Hindi cassette-to-text for a poet who writes with his voice.*

Live: **https://ackq.github.io/transcribe/** · Backend: Cloudflare Worker `transcribe-proxy` · Built July 13, 2026.

---

## 1. Purpose & motivation

My uncle is vision-impaired. He composes poems and novels — but he cannot see a
screen, so no writing app, no phone keyboard, no dictation software with visual
menus works for him. What *does* work is a cassette recorder: a machine with
tactile buttons, no screen, no menus, that he can operate entirely by touch. He
speaks his poetry onto tape, the way he always has.

The gap was everything after the tape. A family member digitizes the cassette
audio to a computer file — and then someone had to transcribe hours of spoken
Hindi by hand. That bottleneck meant most of his work stayed trapped on tape.

**Shrutlekh closes that gap.** A family member opens one web page, picks the
audio file, and a few minutes later has clean, proofread Hindi Devanagari text
— ready to copy into a document or download as a file. The author keeps his
cassette recorder and his craft; the machine does only the clerical work.

Design principles that follow from the user:

- **Zero-install** — it's a web page; nothing to set up on any family member's device.
- **One action** — enter the shared family password once, then it's literally: choose file → wait → text.
- **Listenable** — the end beneficiary is blind. The page announces progress aloud
  (via screen readers), speaks Hindi (`lang="hi"`), and moves focus to the finished
  text so it reads out automatically. A narrated Hindi demo video explains the whole flow.
- **Respect the author** — the AI proofreading pass fixes hearing mistakes and matras,
  but is explicitly forbidden from rewriting words, style, dialect, or verse line breaks.

## 2. The indigenous-AI angle (for the blog)

This project is only possible because of **Sarvam AI** — an Indian foundation-model
company building specifically for Indian languages:

- **saaras:v3** (speech-to-text) transcribes spoken Hindi directly to native
  Devanagari — not romanized, not translated — and handled a real cassette-style
  recording essentially verbatim in our live tests.
- **sarvam-105b** (chat model) does the proofreading pass *with instructions written
  in Hindi* — the system prompt itself is Hindi, and the model follows nuanced
  editorial constraints (fix अनुस्वार/नुक़्ता errors; never "purify" Urdu-Persian
  vocabulary; never touch verse).
- One API key, one vendor, ₹100 free signup credit; a 60-minute cassette side costs
  a few tens of rupees to transcribe and correct.

Story beat for the blog: *a man who writes in Hindi on magnetic tape is brought
into the digital age by an LLM built in India, for Indian languages — and the
entire pipeline speaks his language, from the UI labels to the system prompt to
the output.* Western STT APIs treat Hindi as a checkbox; Sarvam treats it as the
product. That difference is why this works well enough for literature.

## 3. Architecture

```
Browser (ackq.github.io/transcribe/)          Cloudflare Worker              Sarvam AI
┌─────────────────────────────────┐   ┌──────────────────────────┐   ┌──────────────────┐
│ password gate (localStorage)    │   │ secrets: SARVAM_API_KEY, │   │ /speech-to-text  │
│ upload → decode → 16kHz mono    │──▶│          APP_PASSWORD    │──▶│ (saaras:v3,hi-IN)│
│ silence-aware ~28s WAV chunks   │   │ POST /auth /transcribe   │   │                  │
│ pool of 2 uploads + progress    │   │      /review             │──▶│ /v1/chat/        │
│ raw ⇄ corrected, copy/download  │   │ CORS: this site only     │   │  completions     │
└─────────────────────────────────┘   └──────────────────────────┘   └──────────────────┘
```

**Why this shape:**

- GitHub Pages is static-only and free — but can't keep secrets. The **Cloudflare
  Worker** (free tier) is the minimal backend: it holds the Sarvam key, checks the
  family password, and forwards requests. The key never appears in page source,
  network responses, or git.
- Sarvam's simple REST STT endpoint accepts **max ~30 s of audio per call**. Their
  Batch API (up to 2 h/file) exists but has a complex job/upload/poll flow. Instead,
  the browser splits audio into **~28 s chunks at silence boundaries** and streams
  them through the simple endpoint. (Batch API remains the escape hatch if ever needed.)
- The Worker owns all Sarvam parameters (`model`, `mode`, `language_code`) — the
  client only ever sends audio bytes and text, so even a leaked password can't be
  used with arbitrary/expensive parameters.

## 4. What was built (files)

| File | What it is |
|---|---|
| `transcribe/index.html` | The whole app — one self-contained page (~900 lines), no frameworks, no build step |
| `transcribe/demo-hindi.mp4` | Narrated Hindi demo video (screen walkthrough, macOS Lekha TTS voice) |
| `transcribe/demo-hindi.srt/.vtt` | Hindi subtitles for the demo |
| `transcribe/card.png` | 1200×630 social-preview card (WhatsApp/Telegram/Twitter) |
| `worker/src/index.js` | Cloudflare Worker: auth, rate limiting, CORS, `/transcribe` + `/review` proxies, Hindi proofreading prompt |
| `worker/wrangler.toml` | Worker config incl. `[[ratelimits]]` bindings |
| `worker/README.md` | Deploy/secrets runbook |
| `index.html` (hub) | Homepage card linking to the tool |

## 5. Key technical decisions

**Client-side audio pipeline** (all in the browser, Web Audio API):
- WAV files take a **low-memory fast path**: the RIFF container is parsed by hand,
  the data chunk streamed in 8 MB slices, downmixed to mono and linearly resampled
  to 16 kHz with a fractional cursor carried across block boundaries. A 60-minute
  44.1 kHz stereo WAV peaks at ~230 MB instead of ~1.3 GB. Handles 8/16/24-bit PCM,
  32-bit float, WAVE_FORMAT_EXTENSIBLE, and non-canonical chunk layouts (Audacity's LIST/INFO).
- Compressed formats (mp3/m4a/…) use `decodeAudioData` on an `OfflineAudioContext`
  at 16 kHz, with an explicit resample render pass for Safari (which decodes at the
  file's native rate).
- **Silence-aware chunking**: 25 ms RMS frame energies; cut targets 28 s but slides
  back up to 5 s to the earliest frame quieter than 0.25× the window median — so
  cuts land in pauses, not mid-word. No overlap (duplicated words are worse than
  seams; the LLM pass smooths seams).
- Chunks encoded as 16-bit WAV by a tiny hand-written encoder, uploaded by a pool
  of 2 concurrent workers, reassembled by index.

**Resilience** (a 45-minute upload must never be lost to one blip):
- Per-chunk retry ×3 with backoff+jitter on network/429/5xx errors.
- A chunk that fails permanently becomes a `[भाग N विफल]` marker; the run continues
  and a "Retry failed parts" button re-sends only the failures.
- Wrong password mid-run aborts cleanly and reopens the password panel; exhausted
  Sarvam credits produce a "recharge at dashboard.sarvam.ai" message (transcript so far preserved).
- Transcript mirrored to `sessionStorage` after every chunk — a tab reload restores the text.

**LLM proofreading**: raw transcript split into ≤2,500-char batches on line
boundaries → Worker `/review` → sarvam-105b at temperature 0.2 with a Hindi system
prompt (lives in the Worker so it can't be tampered with). Review failure never
blocks output — the raw transcript is always available.

**Accessibility** (audited via the browser accessibility tree):
`lang="hi"` page-wide; landmarks + heading hierarchy; screen-reader-only "three
easy steps" orientation; `aria-live` progress at ~10% milestones with time
remaining (never per-chunk spam); password errors as `role="alert"`; assertive
announcement instead of silent no-ops; focus moves to the finished text; 48 px+
targets; WCAG AA contrast throughout; keyboard-only operation; the demo video in a
native `<dialog>` (focus-trapped, Esc/backdrop/button close, auto-plays narration,
focus returns to trigger).

**Security**:
- Password checked in the Worker via SHA-256 + constant-time compare (no timing oracle).
- Failed guesses: **5/min per IP** (`[[ratelimits]]` binding) + 500 ms delay each;
  authenticated traffic 30/min per IP. Verified live: 5×401 then 429.
- CORS locked to `https://ackq.github.io` (+ localhost for dev); browsers can't
  call the Worker from other sites.
- Worst-case damage from any breach = the prepaid Sarvam balance. Keep top-ups modest.

## 6. Bugs found and fixed along the way (good blog material)

1. **Reasoning model, empty answers**: sarvam-105b thinks (`reasoning_content`)
   before answering; a proportional `max_tokens` cap was consumed entirely by
   reasoning, returning empty corrections. Fix: tier-max 4096 tokens + smaller
   batches (+ `reasoning_effort: "low"`).
2. **The rate limiter that wasn't**: the old `[[unsafe.bindings]]` syntax deployed
   as *inert metadata* — deploy succeeded, `env.RL.limit()` "worked", nothing was
   throttled. The official `[[ratelimits]]` syntax actually enforces. Lesson:
   verify security controls by attacking them, not by reading deploy output.
3. **Audio dropouts in the demo video**: 10 per-scene mp4s concatenated with
   `-c copy` accumulated AAC priming/rounding drift at every join → progressive
   audio muting after ~1 min of playback (seek resyncs, then it drifts again).
   Fix: one continuous WAV → single AAC stream → single encode.
4. **`[hidden]` that wasn't hidden**: `.btn{display:inline-block}` overrode the
   UA's `[hidden]{display:none}` (author styles beat UA styles regardless of
   specificity) — the retry button showed during normal runs. Fix:
   `[hidden]{display:none!important}`.
5. **Dialog opening top-left**: the `*{margin:0}` CSS reset killed the `margin:auto`
   that centers native `<dialog>`s.

## 7. Operations runbook (how to resume/maintain)

**Accounts**: Sarvam — dashboard.sarvam.ai (API key + credit top-ups).
Cloudflare — acku's personal Gmail (`npx wrangler whoami`), Worker `transcribe-proxy`.

```bash
cd worker
npx wrangler whoami                      # check login; `npx wrangler login` if needed
npx wrangler deploy                      # redeploy after editing src/index.js
npx wrangler secret put APP_PASSWORD     # change the family password (no redeploy needed)
npx wrangler secret put SARVAM_API_KEY   # rotate the Sarvam key
npx wrangler tail                        # live logs while debugging
```

- **Site changes**: edit `transcribe/index.html`, push to `main` — GitHub Pages
  serves it in ~1 minute. No build step.
- **Tweak the proofreading style**: edit `REVIEW_PROMPT` in `worker/src/index.js`, redeploy.
- **Test without spending credits**: the page reads
  `localStorage.shrutlekh_worker_override` as an alternate backend URL — point it
  at a local mock (the session used a ~90-line Python mock that validated chunk
  WAV headers and simulated failures).
- **Costs**: a 60-min tape ≈ ~120 STT calls + ~10 chat calls ≈ tens of ₹.
  Cloudflare free tier is ample (100k req/day).
- **Regenerating the demo video**: capture frames with a headless browser, narrate
  with `say -v Lekha -r 150` per scene, then build as **one continuous audio track
  + a single video encode** (see bug #3 — never concat per-scene AAC segments).

## 8. Current status & possible future work

**Status: complete and live.** Full pipeline verified end-to-end on the production
stack with real Hindi audio (transcription verbatim; proofreading fixed मात्रा,
punctuation, and mis-hearings while preserving wording).

Ideas if the family wants more later:

- **Record directly in the browser** (microphone button) — would let him dictate
  short pieces without the cassette→computer step, on a phone handed to him.
- **Sarvam Batch API** for 1–2 h files in one shot (removes chunking, adds job polling).
- **Resume across page reload** for the upload phase itself (currently only the
  finished transcript survives reload).
- **Export as .docx**, larger-print UI mode, or WhatsApp-share button for the final text.
- **Speaker diarization** (Batch API feature) if tapes ever contain conversation.
