# Doc'O Clock AI Triage & Care Assistant

An AI symptom-triage assistant built **during the Meta Global AI Developer Hackathon (26–27 October 2026)** inside [Doc'O Clock](https://www.doc0clock.online), a live telehealth and hospital-management platform serving Zambia. It is live in production today at [`/triage`](https://www.doc0clock.online/triage).

A patient who feels unwell no longer has to guess which of the platform's 27 provider professions to book — or wait when they actually need an ambulance.

## What was newly built during the hackathon

Everything in this repository was created during the hackathon window, on top of the existing Doc'O Clock platform (a separate, live commercial product — the platform itself is not part of this repository):

- **`src/pages/TriageAssistant.tsx`** — the triage experience: entry from the patient dashboard and the public landing page, structured symptom intake (body-area and symptom chips, free text, duration, 0–10 severity, age band, pregnancy where relevant), follow-up questions, structured assessment, and a one-tap hand-off into the live booking flow with the recommended profession pre-filtered.
- **`src/lib/triage/`** — the client triage engine:
  - `redFlags.ts` — the deterministic red-flag screen that runs **first, on the device, before any AI call** (chest pain/pressure, breathing difficulty, stroke signs, severe bleeding, unconsciousness, seizures, severe allergic reaction, suicidal thoughts, pregnancy emergencies, infant fever, meningitis signs, poisoning, and more). A hit shows an emergency escalation screen immediately — tap-to-call 116 (ambulance) / 999 (police) / 993 (fire) — and never waits on the network or a model.
  - `recommend.ts` — the rules assessment and the merge rule: model output is merged with the rules floor; urgency can only escalate, never de-escalate; professions outside the 27-role taxonomy are rejected.
  - `payload.ts` — builds the anonymised, symptom-only payload.
  - `roleMode.ts` — role-wise, least-privilege behaviour for every platform role (patients may book; clinical roles guide without opening patient records; all other roles get own-symptoms guidance only). The acting role is decided on-device and is never sent upstream.
  - `types.ts` — shared types.
- **`supabase/functions/meta-triage/index.ts`** — a Supabase Edge Function that calls the **Meta Model API** (OpenAI-compatible chat completions; default model `Llama-4-Maverick-17B-128E-Instruct-FP8`) with a strict-JSON system prompt: either up to 3 targeted follow-up questions or a final care-routing assessment (urgency, profession from the 27-role list, timeframe, plain-language summary). Output is schema-validated; anything malformed is discarded. The server re-runs the red-flag screen before any model call (defence in depth).
- **`supabase/functions/_shared/triage-red-flags.ts`** — the server-side red-flag screen.
- **`src/test/`** — the test suites pinning the red-flag categories (multiple phrasings each, plus benign controls that must *not* escalate), the privacy contract, the recommendation merge rule, and the role modes.

## Safety architecture — rules first, and AI that collects nothing

This is **care navigation, not diagnosis**. The assistant never states or implies a diagnosis; it routes a person to the right kind of professional, in the right timeframe — or to emergency services, instantly, when danger signs are present.

1. **Symptom-only intake.** The flow never asks for a name, email, phone, national ID, address or any identifier. Age is asked only as a band, because danger signs are age-dependent.
2. **Anonymised payload.** The edge function rebuilds the Meta request field-by-field from a strict whitelist (symptom fields only). A strict schema rejects any request containing identifier keys outright. The caller's platform credentials authenticate them to the function only and are never forwarded; the Meta request carries a fresh header set containing only the Meta key.
3. **Nothing is stored.** The function has no database client and performs no writes; there are no triage-history tables in the flow, no analytics events carrying symptom text, and logs never contain request bodies. Verified live: after end-to-end QA, the platform's AI-history and triage-session tables held **0 rows**.
4. **Honest degradation.** If the Meta key is not configured or the API does not answer, the function returns `{ "aiAvailable": false }` and the app completes triage on the built-in rules path, plainly labelled in the UI. No other provider is ever silently substituted, and no model output is ever fabricated.
5. **Rules override the model.** Even when the model answers, the deterministic screen and the client-side merge have the final word on urgency and escalation.

## Running the Meta step

The edge function reads its configuration from environment secrets (never committed):

- `META_API_KEY` — required for the AI step.
- `META_API_BASE_URL` — optional, defaults to `https://api.llama.com/v1`.
- `META_MODEL` — optional, defaults to `Llama-4-Maverick-17B-128E-Instruct-FP8`.

## Licence

MIT — see `LICENSE`.

## Contact

Mabvuto Banda — founder, Doc'O Clock · mabvutobanda@proton.me · Lusaka, Zambia
