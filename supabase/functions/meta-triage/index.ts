// Doc'O Clock AI Triage & Care Assistant — Meta AI step.
//
// PRIVACY CONTRACT (CEO rule, 2026-10-27 — hard requirements):
//   1. The client sends SYMPTOMS AND SYMPTOM CONTEXT ONLY. The request
//      schema below has no field for a name, email, phone, ID number,
//      address or any other identifier, and unknown fields are stripped.
//   2. The payload forwarded to the Meta Model API is ANONYMISED: it is
//      rebuilt field-by-field from the validated symptom fields. No user
//      id, no profile data, no account metadata and no session identifier
//      is ever attached. The caller's Supabase credentials authenticate
//      the caller to THIS function only; the Meta request carries a fresh
//      header set containing only the Meta key, so nothing about the
//      caller can leak upstream.
//   3. NOTHING is stored server-side: this function performs no database
//      reads or writes of any kind, emits no analytics events, and never
//      logs request or response bodies — operational logs carry coarse
//      stage/outcome words only. Rate limiting is an in-isolate memory
//      counter keyed by caller id (never persisted, never logged), chosen
//      deliberately over the shared Postgres limiter so that not even
//      usage metadata about a triage session lands in a table.
//   4. If the Meta key is not configured, the function answers
//      { aiAvailable: false } and the client completes triage with its
//      built-in safety rules. There is NO fallback to any other model
//      provider — the AI step is Meta or it is honestly absent.
//
// SAFETY: a deterministic red-flag screen re-runs here over the
// anonymised symptom fields before any model call (defence in depth —
// the canonical screen already ran on the patient's device). A hit
// short-circuits the model entirely. Model output is validated against
// the platform's profession taxonomy and merged client-side, where the
// rules floor can raise but never lower the urgency.
//
// Secrets (set by the CEO; never committed):
//   META_API_KEY      — required for the AI step.
//   META_API_BASE_URL — optional, defaults to the Meta Llama API base.
//   META_MODEL        — optional, defaults to the Llama 4 Maverick model.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { screenRedFlagsServer } from "../_shared/triage-red-flags.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-requested-with",
};

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Symptom/context fields ONLY — there is deliberately no identifier field.
// .strict() rejects any extra key (e.g. an email or user id) outright, and
// the handler rebuilds the Meta payload field-by-field regardless.
const RequestSchema = z
  .object({
    // May be empty: a patient who only tapped symptom chips has no free
    // text. The refine below still requires at least one symptom signal.
    chiefComplaint: z.string().max(500),
    symptoms: z.array(z.string().max(120)).max(30).default([]),
    dangerSigns: z.array(z.string().max(60)).max(8).default([]),
    bodyArea: z.string().max(40).nullable().default(null),
    duration: z.string().max(40).nullable().default(null),
    severity: z.number().int().min(0).max(10),
    ageBand: z.string().max(40).nullable().default(null),
    pregnant: z.enum(["yes", "no", "not-applicable"]).nullable().default(null),
    answers: z
      .array(z.object({ question: z.string().max(200), answer: z.string().max(500) }))
      .max(8)
      .default([]),
  })
  .strict()
  .refine(
    (v) =>
      v.chiefComplaint.trim().length > 0 ||
      v.symptoms.length > 0 ||
      v.dangerSigns.length > 0,
    { message: "at least one symptom signal is required" },
  );

// The platform's 27 provider professions (mirrors ALL_CLINICIAN_ROLES in
// src/config/roleConfig.ts). The model may only recommend from this list.
const PROFESSIONS = [
  "doctor", "specialist", "medical_licentiate", "clinical_officer", "dentist",
  "dental_therapist", "nurse", "registered_nurse", "enrolled_nurse", "midwife",
  "pharmacist", "pharmacy_technologist", "radiologist", "radiographer",
  "pathologist", "lab_technician", "phlebotomist", "physiotherapist",
  "occupational_therapist", "nutritionist", "optometrist", "optician",
  "psychologist", "environmental_health_officer", "community_health_worker",
  "traditional_practitioner", "health_personnel",
] as const;

const FollowUpSchema = z.object({
  stage: z.literal("followup"),
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        text: z.string().min(3).max(200),
        options: z.array(z.string().min(1).max(80)).min(2).max(4),
      }),
    )
    .min(1)
    .max(3),
});

const AssessmentSchema = z.object({
  stage: z.literal("assessment"),
  urgency: z.enum(["emergency", "urgent", "routine"]),
  professionRole: z.enum(PROFESSIONS),
  timeframe: z.string().max(80).optional(),
  summary: z.string().max(400).optional(),
});

const ModelOutputSchema = z.union([FollowUpSchema, AssessmentSchema]);

const SYSTEM_PROMPT = `You are the triage assistant inside Doc'O Clock, a Zambian healthcare platform. You receive ANONYMISED symptom information only — never ask for, infer, or mention identity, names, contacts, addresses or records.

Your job: either ask a few follow-up questions OR produce a structured care-routing assessment. This is NOT a diagnosis. Respond with ONLY a JSON object, no prose, no code fences.

If follow-ups would materially change the routing and none have been answered yet, return:
{"stage":"followup","questions":[{"id":"q1","text":"...","options":["...","..."]}]}
- At most 3 questions, each with 2-4 short answer options.
- Ask about onset, course, associated symptoms, fever, and danger signs relevant to the complaint.

Otherwise return:
{"stage":"assessment","urgency":"emergency"|"urgent"|"routine","professionRole":"<one of the allowed roles>","timeframe":"<short, e.g. Within 24 hours>","summary":"<1-2 plain-language sentences, no diagnosis>"}

Allowed professionRole values: ${PROFESSIONS.join(", ")}.

Safety rules:
- Prefer caution: when in doubt between two urgency levels, choose the higher.
- Chest pain/pressure, breathing difficulty, stroke signs, severe bleeding, unconsciousness, seizures, severe allergic reaction, suicidal thoughts, pregnancy danger signs, severe dehydration in children, or fever in a baby under 3 months MUST be "emergency".
- Never state or imply a definitive diagnosis. Never invent findings that were not provided.`;

// In-isolate rate limiting (see privacy contract point 3): caller-id
// timestamps held in memory only, discarded with the isolate.
const callLog = new Map<string, number[]>();
function overLimit(callerId: string): boolean {
  const now = Date.now();
  const recent = (callLog.get(callerId) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  callLog.set(callerId, recent);
  return recent.length > 12;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  // Authenticate the caller to THIS function (gateway verify_jwt is also
  // on). The verified id is used only for the in-memory rate limit; it is
  // never stored, never logged and never sent upstream.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "Unauthorized" });
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authHeader } } },
  );
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !user) return json(401, { error: "Unauthorized" });
  if (overLimit(user.id)) {
    return json(429, { error: "Too many requests. Please wait a moment and try again." });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, { error: "Invalid request" });
  }
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) return json(400, { error: "Invalid request" });
  const intake = parsed.data;

  // Deterministic red-flag re-screen over the anonymised fields. A hit
  // short-circuits everything — the model is never consulted.
  const redFlags = screenRedFlagsServer(intake);
  const metaKey = Deno.env.get("META_API_KEY");
  if (redFlags.length > 0) {
    console.log("meta-triage: stage=emergency source=server-screen");
    return json(200, { aiAvailable: Boolean(metaKey), stage: "emergency", redFlags });
  }

  // Honest degradation: no Meta key → the client completes with rules.
  if (!metaKey) return json(200, { aiAvailable: false });

  const baseUrl = (Deno.env.get("META_API_BASE_URL") ?? "https://api.llama.com/v1").replace(/\/+$/, "");
  const model = Deno.env.get("META_MODEL") ?? "Llama-4-Maverick-17B-128E-Instruct-FP8";

  // Anonymised upstream payload: rebuilt field-by-field from the
  // validated symptom fields — nothing else is attached.
  const anonymised = {
    chiefComplaint: intake.chiefComplaint,
    symptoms: intake.symptoms,
    bodyArea: intake.bodyArea,
    duration: intake.duration,
    severity: intake.severity,
    ageBand: intake.ageBand,
    pregnant: intake.pregnant,
    answers: intake.answers,
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        // Fresh header set: only the Meta key. The caller's Supabase
        // credentials are never forwarded upstream.
        Authorization: `Bearer ${metaKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(anonymised) },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    console.error("meta-triage: upstream unreachable");
    return json(200, { aiAvailable: false });
  }
  if (!upstream.ok) {
    console.error("meta-triage: upstream status", upstream.status);
    return json(200, { aiAvailable: false });
  }

  try {
    const data = await upstream.json();
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const output = ModelOutputSchema.parse(JSON.parse(cleaned));
    console.log("meta-triage: stage=" + output.stage + " source=model");
    return json(200, { aiAvailable: true, ...output });
  } catch {
    console.error("meta-triage: upstream output invalid");
    return json(200, { aiAvailable: false });
  }
});
