/**
 * Rules-based triage assessment + follow-up question bank.
 *
 * This is the always-available guidance path: it needs no network, no AI
 * key and no sign-in round-trip, and it is what the patient gets whenever
 * Meta AI is not configured or does not answer. It is also the SAFETY
 * FLOOR for the AI path — mergeAssessment() guarantees rules always
 * override a model that suggests something less urgent than the rules
 * require, and that a model can only recommend professions that exist in
 * the platform's 27-profession taxonomy.
 */
import { ALL_CLINICIAN_ROLES, ROLE_META, USER_ROLES } from "@/config/roleConfig";
import type { UserRole } from "@/config/roleConfig";
import { triageCorpus } from "./redFlags";
import type {
  FollowUpQuestion,
  ProfessionRecommendation,
  TriageAssessment,
  TriageIntake,
  UrgencyTier,
} from "./types";

const VALID_PROFESSIONS = new Set<string>(ALL_CLINICIAN_ROLES as unknown as string[]);

function prof(role: UserRole, search: { specialty?: string; q?: string }): ProfessionRecommendation {
  return { role, label: ROLE_META[role]?.label ?? role, search };
}

interface AreaRule {
  test: (intake: TriageIntake, text: string) => boolean;
  profession: ProfessionRecommendation;
  urgentFloor?: boolean;
  note: string;
}

/** Ordered — first match wins, most specific first. */
const AREA_RULES: AreaRule[] = [
  {
    test: (i, t) => i.bodyArea === "teeth-mouth" || /(tooth|teeth|gum|dental|jaw pain|mouth ulcer|wisdom tooth)/.test(t),
    profession: prof(USER_ROLES.DENTIST, { specialty: "General Dentistry" }),
    note: "Dental symptoms are best assessed by a dentist.",
  },
  {
    test: (i, t) => i.bodyArea === "eyes-vision" || /(eye|vision|seeing|blurry|blurred|glasses|conjunctiv|sore eye|red eye)/.test(t),
    profession: prof(USER_ROLES.OPTOMETRIST, { specialty: "Ophthalmology" }),
    note: "Eye and vision symptoms are best assessed by an eye-care professional.",
  },
  {
    test: (i, t) => i.bodyArea === "mind-mood" || /(anxiet|anxious|depress|low mood|panic|stress|can'?t sleep|insomnia|mental health|feeling down)/.test(t),
    profession: prof(USER_ROLES.PSYCHOLOGIST, { q: "Psychologist" }),
    note: "A psychologist can help you work through this safely and at your pace.",
  },
  {
    test: (i, t) =>
      i.bodyArea === "pregnancy" || i.pregnant === "yes" || /(antenatal|prenatal|pregnancy check|morning sickness)/.test(t),
    profession: prof(USER_ROLES.MIDWIFE, { q: "Midwife" }),
    note: "Pregnancy care is led by midwives on Doc'O Clock.",
  },
  {
    // Suspected fracture / cannot bear weight: orthopaedics, urgently.
    test: (_i, t) => /(broken|fracture|can'?t bear weight|cannot bear weight|bone (sticking|out)|deform)/.test(t),
    profession: prof(USER_ROLES.DOCTOR, { specialty: "Orthopedics" }),
    urgentFloor: true,
    note: "A possible broken bone needs an in-person assessment today.",
  },
  {
    test: (i, t) =>
      i.bodyArea === "back-joints" ||
      /(back pain|joint|muscle pain|sprain|strain|neck pain|shoulder pain|knee pain|ankle|stiff joint|sciatica)/.test(t),
    profession: prof(USER_ROLES.PHYSIOTHERAPIST, { q: "Physiotherapist" }),
    note: "Muscle, joint and back problems are usually assessed first by a physiotherapist.",
  },
  {
    test: (_i, t) => /(palpitation|heart (racing|fluttering|pounding)|racing heartbeat|irregular heartbeat)/.test(t),
    profession: prof(USER_ROLES.DOCTOR, { specialty: "Cardiology" }),
    urgentFloor: true,
    note: "Heart-rhythm symptoms should be checked the same day.",
  },
  {
    test: (i, t) => i.bodyArea === "skin" || /(rash|itch|eczema|acne|skin|boil|wound|ringworm|scabies|hives)/.test(t),
    profession: prof(USER_ROLES.DOCTOR, { specialty: "Dermatology" }),
    note: "Skin conditions are best assessed by a doctor with a dermatology focus.",
  },
  {
    test: (i, t) =>
      i.bodyArea === "child-health" ||
      i.ageBand === "under-3-months" ||
      i.ageBand === "3-12-months" ||
      i.ageBand === "1-5-years" ||
      i.ageBand === "6-12-years",
    profession: prof(USER_ROLES.DOCTOR, { specialty: "Pediatrics" }),
    note: "Children are best assessed by a doctor who specialises in child health.",
  },
  {
    test: (_i, t) => /(menstrual|period pain|periods|vaginal|pelvic pain|menopause|contraception|family planning)/.test(t),
    profession: prof(USER_ROLES.DOCTOR, { specialty: "Gynecology" }),
    note: "These symptoms are best assessed by a doctor with a gynaecology focus.",
  },
  {
    test: (_i, t) => /(migraine)/.test(t),
    profession: prof(USER_ROLES.DOCTOR, { specialty: "Neurology" }),
    note: "Recurring migraines are best assessed by a doctor with a neurology focus.",
  },
  {
    test: (_i, t) => /(nutrition|diet|weight (loss|gain) plan|healthy eating|diabetes diet|meal plan)/.test(t),
    profession: prof(USER_ROLES.NUTRITIONIST, { q: "Nutritionist" }),
    note: "A nutritionist can build a plan around your health goals.",
  },
];

const GENERAL = prof(USER_ROLES.DOCTOR, { specialty: "General Practice" });

/** The rules engine's urgency floor from structured signals alone. */
export function rulesUrgencyFloor(intake: TriageIntake): Exclude<UrgencyTier, "emergency"> {
  const text = triageCorpus(intake);
  const hasFever = /(fever|temperature|hot body|feeling hot)/.test(text);
  const gettingWorse = intake.answers.some((a) => /worse|worser|deteriorat/i.test(a.answer));
  if (intake.severity >= 8) return "urgent";
  if (intake.severity >= 6 && (intake.duration === "under-1-hour" || intake.duration === "today")) return "urgent";
  if (hasFever && intake.ageBand === "65-plus-years") return "urgent";
  if (hasFever && intake.ageBand === "3-12-months") return "urgent";
  if (gettingWorse && intake.severity >= 5) return "urgent";
  return "routine";
}

/** Full rules-based assessment (used standalone and as the AI floor). */
export function rulesAssessment(intake: TriageIntake): TriageAssessment {
  const text = triageCorpus(intake);
  const rule = AREA_RULES.find((r) => r.test(intake, text));
  const profession = rule?.profession ?? GENERAL;
  let urgency = rulesUrgencyFloor(intake);
  if (rule?.urgentFloor) urgency = "urgent";
  const timeframe =
    urgency === "urgent"
      ? "Within 24 hours — today if you can"
      : intake.severity >= 5 || intake.duration === "today" || intake.duration === "under-1-hour"
        ? "Within the next 2–3 days"
        : "Within the next week";
  const summary = rule
    ? rule.note
    : "A general practice doctor is the safest first step for these symptoms — they can refer you on if a specialist is needed.";
  return { urgency, profession, timeframe, summary, source: "rules" };
}

const URGENCY_RANK: Record<UrgencyTier, number> = { routine: 0, urgent: 1, emergency: 2 };

export interface AiAssessmentLike {
  urgency: UrgencyTier;
  professionRole: string;
  timeframe?: string;
  summary?: string;
}

/**
 * Merge a Meta AI assessment over the rules assessment. Rules ALWAYS win
 * on urgency (a model may escalate, never de-escalate) and a model may
 * only name professions that exist in the platform taxonomy.
 * Returns null when the AI assessment claims "emergency" — the caller
 * must show the emergency screen instead of an assessment.
 */
export function mergeAssessment(
  rules: TriageAssessment,
  ai: AiAssessmentLike,
): TriageAssessment | null {
  if (ai.urgency === "emergency") return null;
  const urgency =
    URGENCY_RANK[ai.urgency] > URGENCY_RANK[rules.urgency] ? ai.urgency : rules.urgency;
  const profession = VALID_PROFESSIONS.has(ai.professionRole)
    ? {
        role: ai.professionRole,
        label: ROLE_META[ai.professionRole as UserRole]?.label ?? rules.profession.label,
        search: rules.profession.role === ai.professionRole ? rules.profession.search : { q: ROLE_META[ai.professionRole as UserRole]?.label ?? ai.professionRole },
      }
    : rules.profession;
  return {
    urgency,
    profession,
    timeframe: ai.timeframe?.trim() ? ai.timeframe : rules.timeframe,
    summary: ai.summary?.trim() ? ai.summary : rules.summary,
    source: "meta-ai",
  };
}

/** Static follow-up bank used when Meta AI is unavailable. */
const GENERIC_FOLLOWUPS: FollowUpQuestion[] = [
  {
    id: "course",
    text: "Is it getting better, worse, or staying the same?",
    options: ["Getting better", "Getting worse", "Staying the same", "Not sure"],
  },
  {
    id: "fever",
    text: "Do you have a fever or feel hot?",
    options: ["Yes, I have a fever", "No", "Not sure"],
  },
  {
    id: "medication",
    text: "Have you taken any medicine for this?",
    options: ["Yes", "No"],
  },
];

const AREA_FOLLOWUPS: Partial<Record<string, FollowUpQuestion[]>> = {
  "chest-breathing": [
    { id: "cough-type", text: "Is the cough dry or bringing up mucus?", options: ["Dry", "Bringing up mucus", "No cough", "Not sure"] },
    { id: "course", text: "Is your breathing getting better, worse, or staying the same?", options: ["Getting better", "Getting worse", "Staying the same", "Not sure"] },
  ],
  "stomach-digestion": [
    { id: "gi-course", text: "Have you vomited or had diarrhoea?", options: ["Vomited", "Diarrhoea", "Both", "Neither"] },
    { id: "fluids", text: "Can you keep fluids down?", options: ["Yes", "No", "Not sure"] },
  ],
  "head-neck": [
    { id: "onset", text: "Did it start suddenly or gradually?", options: ["Suddenly", "Gradually", "Not sure"] },
    { id: "vision", text: "Have you noticed any vision changes?", options: ["Yes", "No"] },
  ],
  skin: [
    { id: "spreading", text: "Is the area hot, swollen or spreading?", options: ["Yes", "No", "Not sure"] },
  ],
  "teeth-mouth": [
    { id: "swelling", text: "Is there swelling in your face, gum or jaw?", options: ["Yes", "No"] },
  ],
  "mind-mood": [
    { id: "impact", text: "Is it affecting your sleep or daily activities?", options: ["Yes, a lot", "A little", "No"] },
  ],
  pregnancy: [
    // Danger probes: follow-up answers are re-screened by screenRedFlags
    // and the options are self-describing, so a concerning answer carries
    // the words that escalate ("bleeding", "baby is not moving") and a
    // reassuring one does not.
    { id: "preg-bleeding", text: "Any bleeding or leaking fluid?", options: ["Yes, I have bleeding or leaking fluid", "No"] },
    { id: "preg-movement", text: "Is the baby moving as usual?", options: ["Yes, moving as usual", "No, the baby is not moving as usual", "Not sure", "Too early to feel movement"] },
  ],
};

export function rulesFollowUps(intake: TriageIntake): FollowUpQuestion[] {
  const byArea = intake.bodyArea ? AREA_FOLLOWUPS[intake.bodyArea] : undefined;
  if (byArea && byArea.length > 0) return byArea;
  if (intake.pregnant === "yes") return AREA_FOLLOWUPS["pregnancy"]!;
  return GENERIC_FOLLOWUPS;
}
