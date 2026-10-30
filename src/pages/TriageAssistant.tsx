import React, { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { useUserRoles } from "@/context/UserRolesContext";
import { ROLE_PERMISSIONS } from "@/utils/rolePermissions";
import {
  TRIAGE_MODE_INTRO,
  getTriageMode,
  resolveActingRole,
  resolveTriageNextSteps,
} from "@/lib/triage/roleMode";
import { LoadingScreen } from "@/components/LoadingScreen";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  Ambulance,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  Phone,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Stethoscope,
} from "lucide-react";
import { DANGER_SIGNS, redFlagLabel, screenRedFlags } from "@/lib/triage/redFlags";
import {
  mergeAssessment,
  rulesAssessment,
  rulesFollowUps,
} from "@/lib/triage/recommend";
import { buildAnonymisedPayload, type MetaTriageResponse } from "@/lib/triage/payload";
import {
  EMPTY_INTAKE,
  type AgeBand,
  type BodyArea,
  type DurationBand,
  type FollowUpQuestion,
  type PregnancyStatus,
  type RedFlagHit,
  type TriageAssessment,
  type TriageIntake,
} from "@/lib/triage/types";

/**
 * AI Triage & Care Assistant.
 *
 * Privacy by design (CEO rule, 2026-10-27): this page asks ONLY about
 * symptoms and symptom context — never a name, email, phone, ID or
 * address. It writes NOTHING to any database and stores NOTHING in web
 * storage: the whole flow lives in component state for the session, and
 * the only thing that leaves the device is the anonymised symptom
 * payload built by buildAnonymisedPayload() when the Meta AI step runs.
 *
 * Safety order of operations: the deterministic red-flag screen runs
 * FIRST, locally and synchronously. A hit shows the emergency screen
 * immediately — no network call is made on that path at all.
 *
 * Role-wise (CEO order, 2026-10-27): usable by every role, acting on
 * the CURRENT acting role via src/lib/triage/roleMode.ts — patients
 * may book; clinical roles guide without booking or touching any
 * patient record; every other role gets own-symptoms guidance only.
 * The role/mode is never sent upstream and unlocks no data access.
 */

const BODY_AREAS: Array<{ id: BodyArea; label: string }> = [
  { id: "head-neck", label: "Head & neck" },
  { id: "chest-breathing", label: "Chest & breathing" },
  { id: "stomach-digestion", label: "Stomach & digestion" },
  { id: "back-joints", label: "Back, muscles & joints" },
  { id: "skin", label: "Skin" },
  { id: "teeth-mouth", label: "Teeth & mouth" },
  { id: "eyes-vision", label: "Eyes & vision" },
  { id: "ears-hearing", label: "Ears & hearing" },
  { id: "mind-mood", label: "Mind & mood" },
  { id: "pregnancy", label: "Pregnancy" },
  { id: "child-health", label: "Child health" },
  { id: "general", label: "Whole body / not sure" },
];

const SYMPTOM_CHIPS = [
  "Fever", "Cough", "Headache", "Stomach pain", "Vomiting", "Diarrhoea",
  "Dizziness", "Rash", "Sore throat", "Body aches", "Tooth pain",
  "Back pain", "Tiredness", "Runny nose", "Nausea", "Joint pain",
];

const DURATIONS: Array<{ id: DurationBand; label: string }> = [
  { id: "under-1-hour", label: "Less than an hour" },
  { id: "today", label: "Started today" },
  { id: "2-3-days", label: "2–3 days" },
  { id: "4-7-days", label: "4–7 days" },
  { id: "over-1-week", label: "More than a week" },
];

const AGE_BANDS: Array<{ id: AgeBand; label: string }> = [
  { id: "under-3-months", label: "Under 3 months" },
  { id: "3-12-months", label: "3–12 months" },
  { id: "1-5-years", label: "1–5 years" },
  { id: "6-12-years", label: "6–12 years" },
  { id: "13-17-years", label: "13–17 years" },
  { id: "18-64-years", label: "18–64 years" },
  { id: "65-plus-years", label: "65 years or older" },
];

const PREGNANCY_OPTIONS: Array<{ id: PregnancyStatus; label: string }> = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No" },
  { id: "not-applicable", label: "Not applicable" },
];

type Step = "intro" | "intake" | "followup" | "emergency" | "assessment";

function Chip({
  selected,
  onClick,
  children,
  danger = false,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  const base =
    "px-3 py-2 rounded-full border text-xs font-semibold transition-all active:scale-95 text-left";
  const styles = danger
    ? selected
      ? "bg-error-500 border-error-500 text-white"
      : "bg-error-50 dark:bg-red-950/30 border-error-200 dark:border-red-900 text-error-700 dark:text-red-300 hover:border-error-400"
    : selected
      ? "bg-primary-500 border-primary-500 text-white"
      : "bg-white dark:bg-slate-800 border-graphite-300 dark:border-slate-700 text-graphite-700 dark:text-slate-200 hover:border-primary-400";
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} className={`${base} ${styles}`}>
      {children}
    </button>
  );
}

export default function TriageAssistant() {
  const { user, loading: authLoading } = useAuth();
  const {
    currentRole,
    primaryRole,
    availableRoles,
    loading: rolesLoading,
  } = useUserRoles();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [step, setStep] = useState<Step>("intro");
  const [intake, setIntake] = useState<TriageIntake>(() => {
    const area = searchParams.get("area") as BodyArea | null;
    const symptom = searchParams.get("s");
    return {
      ...EMPTY_INTAKE,
      bodyArea: area && BODY_AREAS.some((a) => a.id === area) ? area : null,
      symptoms: symptom ? [symptom] : [],
    };
  });
  const [hits, setHits] = useState<RedFlagHit[]>([]);
  const [questions, setQuestions] = useState<FollowUpQuestion[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [assessment, setAssessment] = useState<TriageAssessment | null>(null);
  const [aiMode, setAiMode] = useState<"meta" | "rules">("rules");
  const [busy, setBusy] = useState(false);

  const canContinue = useMemo(
    () =>
      intake.chiefComplaint.trim().length > 0 ||
      intake.symptoms.length > 0 ||
      intake.dangerSigns.length > 0,
    [intake],
  );

  // Role-wise, least-privilege behaviour (CEO order, 2026-10-27): the
  // mode follows the role the user is CURRENTLY acting as. The mode and
  // the role are presentation-only — they are never sent to the
  // meta-triage function (the anonymised payload is unchanged) and they
  // unlock no data access of any kind for any role.
  const actingRole = resolveActingRole({ currentRole, primaryRole, availableRoles });
  const triageMode = getTriageMode(actingRole);
  const actingPermissions = actingRole ? (ROLE_PERMISSIONS[actingRole] ?? []) : [];
  const nextSteps = assessment
    ? resolveTriageNextSteps({
        mode: triageMode,
        permissions: actingPermissions,
        assessment,
      })
    : [];

  React.useEffect(() => {
    if (!authLoading && !user) navigate("/auth", { replace: true });
  }, [authLoading, user, navigate]);

  if (authLoading || rolesLoading) return <LoadingScreen />;
  if (!user) return null;

  const patch = (partial: Partial<TriageIntake>) =>
    setIntake((prev) => ({ ...prev, ...partial }));

  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const escalate = (found: RedFlagHit[]) => {
    setHits(found);
    setStep("emergency");
  };

  /** Call the Meta triage step with the anonymised payload only. */
  const callMeta = async (payloadIntake: TriageIntake) => {
    const { data, error } = await supabase.functions.invoke<MetaTriageResponse>(
      "meta-triage",
      { body: buildAnonymisedPayload(payloadIntake) },
    );
    if (error) throw error;
    return data;
  };

  const submitIntake = async () => {
    // 1) Deterministic red-flag screen FIRST — local, synchronous.
    //    A hit never waits on the network or any AI call.
    const found = screenRedFlags(intake);
    if (found.length > 0) {
      escalate(found);
      return;
    }
    setBusy(true);
    try {
      const data = await callMeta(intake);
      if (data && data.aiAvailable) {
        if (data.stage === "emergency") {
          escalate(data.redFlags.map((id) => ({ id, label: redFlagLabel(id) })));
          return;
        }
        if (data.stage === "followup") {
          setAiMode("meta");
          setQuestions(data.questions);
          setPicked({});
          setStep("followup");
          return;
        }
        if (data.stage === "assessment") {
          const merged = mergeAssessment(rulesAssessment(intake), data);
          if (!merged) {
            escalate([{ id: "model-emergency", label: "A possible emergency sign" }]);
            return;
          }
          setAssessment(merged);
          setStep("assessment");
          return;
        }
      }
      throw new Error("ai-unavailable");
    } catch {
      // Honest degradation: Meta AI is not connected or did not answer —
      // the built-in safety rules carry the flow from here.
      setAiMode("rules");
      setQuestions(rulesFollowUps(intake));
      setPicked({});
      setStep("followup");
    } finally {
      setBusy(false);
    }
  };

  const submitFollowUps = async () => {
    const answers = questions
      .map((q) => ({ question: q.text, answer: picked[q.id] ?? "" }))
      .filter((a) => a.answer.trim().length > 0);
    const nextIntake: TriageIntake = { ...intake, answers };
    setIntake(nextIntake);

    // Re-screen with the answers included — a danger sign revealed in a
    // follow-up answer escalates before any assessment is shown.
    const found = screenRedFlags(nextIntake);
    if (found.length > 0) {
      escalate(found);
      return;
    }
    const floor = rulesAssessment(nextIntake);

    if (aiMode !== "meta") {
      setAssessment(floor);
      setStep("assessment");
      return;
    }
    setBusy(true);
    try {
      const data = await callMeta(nextIntake);
      if (data && data.aiAvailable && data.stage === "assessment") {
        const merged = mergeAssessment(floor, data);
        if (!merged) {
          escalate([{ id: "model-emergency", label: "A possible emergency sign" }]);
          return;
        }
        setAssessment(merged);
        setStep("assessment");
        return;
      }
      if (data && data.aiAvailable && data.stage === "emergency") {
        escalate(data.redFlags.map((id) => ({ id, label: redFlagLabel(id) })));
        return;
      }
      // Model gave no usable assessment — show the rules guidance and say so.
      setAiMode("rules");
      setAssessment(floor);
      setStep("assessment");
    } catch {
      setAiMode("rules");
      setAssessment(floor);
      setStep("assessment");
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setIntake(EMPTY_INTAKE);
    setHits([]);
    setQuestions([]);
    setPicked({});
    setAssessment(null);
    setAiMode("rules");
    setStep("intro");
  };

  const goToNextStep = (route?: string) => {
    if (route) navigate(route);
  };

  const stepNumber = step === "intro" ? 1 : step === "intake" ? 2 : 3;

  return (
    <div className="min-h-screen bg-canvas text-midnight font-sans transition-colors pb-16">
      {/* Header — same chrome as the rest of the app */}
      <div className="doc-page-header px-4 sm:px-6 py-4 shadow-xs">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary-500 text-white flex items-center justify-center shadow-xs shrink-0">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">AI Symptom Triage</h1>
            <p className="text-xs text-graphite-500 dark:text-slate-400 font-medium">
              {triageMode === "patient"
                ? "Tell us how you feel — we'll point you to the right care and help you book"
                : "Tell us how you feel — we'll point you to the right care"}
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-6 space-y-6">
        {/* Progress */}
        {step !== "emergency" && (
          <div className="flex items-center gap-2" aria-label={`Step ${stepNumber} of 3`}>
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className={`h-1.5 flex-1 rounded-full ${n <= stepNumber ? "bg-primary-500" : "bg-graphite-200 dark:bg-slate-700"}`}
              />
            ))}
          </div>
        )}

        {step === "intro" && (
          <div className="rounded-2xl border border-canvas-silk dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs space-y-4">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <Stethoscope className="h-5 w-5 text-primary-500" /> Before you start
            </h2>
            <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 font-medium">
              This is not a diagnosis. The assistant helps you find the right kind of
              care — only a health professional who examines you can diagnose.
              If you are in an emergency right now, call <strong>116</strong> immediately
              instead of using this tool.
            </div>
            <div className="rounded-xl bg-primary-50 dark:bg-blue-950/40 border border-primary-100 dark:border-blue-900 px-4 py-3 text-sm text-graphite-700 dark:text-slate-200 flex gap-3">
              <ShieldCheck className="h-5 w-5 text-primary-500 shrink-0 mt-0.5" />
              <p>
                <strong>Private by design.</strong> We only ask about your symptoms —
                never your name, phone number, ID or address — and nothing you enter
                here is saved. Your answers stay on this device except for the
                anonymous symptom summary used by the AI step.
              </p>
            </div>
            <p className="text-sm font-medium text-graphite-700 dark:text-slate-200">
              {TRIAGE_MODE_INTRO[triageMode]}
            </p>
            <button
              type="button"
              onClick={() => setStep("intake")}
              className="w-full py-3 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.99]"
            >
              Start symptom check <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {step === "intake" && (
          <div className="rounded-2xl border border-canvas-silk dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs space-y-6">
            {/* Danger signs FIRST — selecting one escalates on continue */}
            <div className="space-y-2">
              <h2 className="font-semibold text-sm flex items-center gap-2 text-error-600 dark:text-red-400">
                <AlertTriangle className="h-4 w-4" /> Are you experiencing any of these right now?
              </h2>
              <p className="text-xs text-graphite-500 dark:text-slate-400 font-medium">
                If yes, tap them — we will tell you to get emergency help straight away.
              </p>
              <div className="flex flex-wrap gap-2">
                {DANGER_SIGNS.map((sign) => (
                  <Chip
                    key={sign.id}
                    danger
                    selected={intake.dangerSigns.includes(sign.id)}
                    onClick={() => patch({ dangerSigns: toggleIn(intake.dangerSigns, sign.id) })}
                  >
                    {sign.label}
                  </Chip>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <h2 className="font-semibold text-sm">Where is the problem?</h2>
              <div className="flex flex-wrap gap-2">
                {BODY_AREAS.map((area) => (
                  <Chip
                    key={area.id}
                    selected={intake.bodyArea === area.id}
                    onClick={() => patch({ bodyArea: intake.bodyArea === area.id ? null : area.id })}
                  >
                    {area.label}
                  </Chip>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <h2 className="font-semibold text-sm">What are you feeling?</h2>
              <div className="flex flex-wrap gap-2">
                {SYMPTOM_CHIPS.map((label) => (
                  <Chip
                    key={label}
                    selected={intake.symptoms.includes(label)}
                    onClick={() => patch({ symptoms: toggleIn(intake.symptoms, label) })}
                  >
                    {label}
                  </Chip>
                ))}
              </div>
              <textarea
                value={intake.chiefComplaint}
                onChange={(e) => patch({ chiefComplaint: e.target.value.slice(0, 500) })}
                placeholder="Describe how you feel in your own words — e.g. 'Sharp pain in my lower right belly since this morning'"
                rows={3}
                maxLength={500}
                className="w-full mt-1 p-3 rounded-xl border border-graphite-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-medium placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>

            <div className="space-y-2">
              <h2 className="font-semibold text-sm">How long has this been going on?</h2>
              <div className="flex flex-wrap gap-2">
                {DURATIONS.map((d) => (
                  <Chip
                    key={d.id}
                    selected={intake.duration === d.id}
                    onClick={() => patch({ duration: intake.duration === d.id ? null : d.id })}
                  >
                    {d.label}
                  </Chip>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <h2 className="font-semibold text-sm">
                How bad is it? <span className="text-primary-500">{intake.severity}/10</span>
              </h2>
              <Slider
                value={[intake.severity]}
                onValueChange={(v) => patch({ severity: v[0] ?? 3 })}
                min={0}
                max={10}
                step={1}
                aria-label="Severity from 0 to 10"
              />
              <div className="flex justify-between text-[11px] font-semibold text-graphite-400">
                <span>Mild</span><span>Moderate</span><span>Severe</span>
              </div>
            </div>

            <div className="space-y-2">
              <h2 className="font-semibold text-sm">Who is this for?</h2>
              <p className="text-xs text-graphite-500 dark:text-slate-400 font-medium">
                Age group only — some danger signs depend on age, like fever in a young baby.
              </p>
              <div className="flex flex-wrap gap-2">
                {AGE_BANDS.map((band) => (
                  <Chip
                    key={band.id}
                    selected={intake.ageBand === band.id}
                    onClick={() => patch({ ageBand: intake.ageBand === band.id ? null : band.id })}
                  >
                    {band.label}
                  </Chip>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <h2 className="font-semibold text-sm">Are you pregnant?</h2>
              <p className="text-xs text-graphite-500 dark:text-slate-400 font-medium">
                Asked only because some pregnancy symptoms need urgent care.
              </p>
              <div className="flex flex-wrap gap-2">
                {PREGNANCY_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.id}
                    selected={intake.pregnant === opt.id}
                    onClick={() => patch({ pregnant: intake.pregnant === opt.id ? null : opt.id })}
                  >
                    {opt.label}
                  </Chip>
                ))}
              </div>
            </div>

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setStep("intro")}
                className="px-4 py-3 rounded-xl border border-graphite-300 dark:border-slate-700 font-semibold text-sm flex items-center gap-2"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <button
                type="button"
                disabled={!canContinue || busy}
                onClick={submitIntake}
                className="flex-1 py-3 rounded-xl bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.99]"
              >
                {busy ? "Checking…" : <>Continue <ArrowRight className="h-4 w-4" /></>}
              </button>
            </div>
            {!canContinue && (
              <p className="text-xs text-graphite-400 font-medium -mt-2">
                Pick at least one symptom, a danger sign, or describe how you feel to continue.
              </p>
            )}
          </div>
        )}

        {step === "followup" && (
          <div className="rounded-2xl border border-canvas-silk dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs space-y-5">
            <div>
              <h2 className="font-semibold text-sm flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary-500" /> A few more questions
              </h2>
              <p className="text-xs text-graphite-500 dark:text-slate-400 font-medium mt-0.5">
                {aiMode === "meta"
                  ? "Asked by Meta AI to understand your symptoms better."
                  : "From Doc'O Clock's built-in safety rules."}{" "}
                Nothing here is saved.
              </p>
            </div>
            {questions.map((q) => (
              <div key={q.id} className="space-y-2">
                <p className="text-sm font-semibold">{q.text}</p>
                <div className="flex flex-wrap gap-2">
                  {q.options.map((opt) => (
                    <Chip
                      key={opt}
                      selected={picked[q.id] === opt}
                      onClick={() => setPicked((prev) => ({ ...prev, [q.id]: opt }))}
                    >
                      {opt}
                    </Chip>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setStep("intake")}
                className="px-4 py-3 rounded-xl border border-graphite-300 dark:border-slate-700 font-semibold text-sm flex items-center gap-2"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={submitFollowUps}
                className="flex-1 py-3 rounded-xl bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.99]"
              >
                {busy ? "Checking…" : <>See my guidance <ArrowRight className="h-4 w-4" /></>}
              </button>
            </div>
          </div>
        )}

        {step === "emergency" && (
          <div
            role="alert"
            className="rounded-2xl border-2 border-error-500 bg-error-50 dark:bg-red-950/40 p-5 shadow-xs space-y-4"
          >
            <h2 className="font-bold text-lg text-error-700 dark:text-red-300 flex items-center gap-2">
              <Ambulance className="h-6 w-6" /> Get emergency help now
            </h2>
            {hits.length > 0 && (
              <div className="text-sm font-medium text-error-700 dark:text-red-200">
                You mentioned: {hits.map((h) => h.label.toLowerCase()).join("; ")}.
                These can be signs of an emergency.
              </div>
            )}
            <p className="text-sm font-medium text-graphite-700 dark:text-slate-200">
              Do not wait for an online consultation. Call an ambulance now, or go to
              the nearest hospital immediately. If someone is with you, ask them to
              stay with you until help arrives.
            </p>
            {hits.some((h) => h.id === "suicidal-thoughts") && (
              <p className="text-sm font-semibold text-graphite-800 dark:text-slate-100">
                You are not alone, and help is available right now. Please call 116 or
                go to the nearest hospital — or tell someone you trust what you are
                feeling and ask them to stay with you.
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <a
                href="tel:116"
                className="py-3.5 rounded-xl bg-error-500 hover:bg-error-600 text-white font-bold text-base flex items-center justify-center gap-2 transition-all active:scale-[0.99]"
              >
                <Phone className="h-5 w-5" /> Call 116 — Ambulance
              </a>
              <a
                href="tel:999"
                className="py-3.5 rounded-xl bg-white dark:bg-slate-900 border-2 border-error-500 text-error-600 dark:text-red-400 font-bold text-base flex items-center justify-center gap-2 transition-all active:scale-[0.99]"
              >
                <Phone className="h-5 w-5" /> Call 999 — Police
              </a>
            </div>
            <p className="text-xs font-medium text-graphite-500 dark:text-slate-400">
              Zambia emergency numbers: ambulance 116 · police 999 · fire 993. You can
              also open the{" "}
              <button type="button" onClick={() => navigate("/emergency")} className="underline font-semibold">
                Doc&apos;O Clock emergency page
              </button>{" "}
              to alert your emergency contacts.
            </p>
            <button
              type="button"
              onClick={restart}
              className="text-xs font-semibold text-graphite-500 dark:text-slate-400 underline"
            >
              Start again
            </button>
          </div>
        )}

        {step === "assessment" && assessment && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-canvas-silk dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold text-white ${
                    assessment.urgency === "urgent" ? "bg-warning-500" : "bg-primary-500"
                  }`}
                >
                  {assessment.urgency === "urgent" ? (
                    <><AlertTriangle className="h-3.5 w-3.5" /> Urgent — see a clinician soon</>
                  ) : (
                    <><CheckCircle2 className="h-3.5 w-3.5" /> Routine — book a visit</>
                  )}
                </span>
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-canvas-bone dark:bg-slate-800 text-graphite-600 dark:text-slate-300">
                  <Clock className="h-3.5 w-3.5" /> {assessment.timeframe}
                </span>
              </div>

              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-graphite-400">Recommended care</p>
                <p className="text-lg font-semibold mt-1 flex items-center gap-2">
                  <Stethoscope className="h-5 w-5 text-primary-500" /> {assessment.profession.label}
                </p>
                <p className="text-sm text-graphite-600 dark:text-slate-300 font-medium mt-1">
                  {assessment.summary}
                </p>
              </div>

              {assessment.source === "meta-ai" ? (
                <p className="text-xs font-medium text-graphite-500 dark:text-slate-400 flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-primary-500" />
                  Guided by Meta AI (Llama), checked against Doc&apos;O Clock&apos;s safety rules —
                  the rules always win if the two disagree.
                </p>
              ) : (
                <p className="text-xs font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                  Meta AI assist is not connected right now, so this guidance comes from
                  Doc&apos;O Clock&apos;s built-in safety rules.
                </p>
              )}

              {nextSteps.map((stepDef, idx) =>
                stepDef.kind === "link" ? (
                  <button
                    key={`${stepDef.route ?? stepDef.label}-${idx}`}
                    type="button"
                    onClick={() => goToNextStep(stepDef.route)}
                    className="w-full py-3.5 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.99]"
                  >
                    {stepDef.label} <ArrowRight className="h-4 w-4" />
                  </button>
                ) : (
                  <p
                    key={`${stepDef.label}-${idx}`}
                    className="text-sm font-medium text-graphite-600 dark:text-slate-300"
                  >
                    {stepDef.label}
                    {stepDef.description ? <> {stepDef.description}</> : null}
                  </p>
                ),
              )}
              <p className="text-xs text-graphite-400 font-medium">
                This is guidance, not a diagnosis. If your symptoms get worse at any
                point — especially any of the danger signs — call 116 or go to the
                nearest hospital immediately.
              </p>
            </div>
            <button
              type="button"
              onClick={restart}
              className="text-xs font-semibold text-graphite-500 dark:text-slate-400 underline flex items-center gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Start again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
