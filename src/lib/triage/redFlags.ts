/**
 * Deterministic red-flag screen for the AI Triage & Care Assistant.
 *
 * This engine runs FIRST — synchronously, on the patient's device, before
 * any network call and before any AI involvement. If it fires, the patient
 * is shown the emergency escalation screen immediately; that path never
 * waits on a model, a network, or a sign-in round-trip. The same screen
 * also re-runs over follow-up answers, so a danger sign revealed later
 * still escalates.
 *
 * The list is deliberately clinically conservative (CEO safety rule):
 * chest pain/pressure, breathing difficulty, stroke signs (FAST), severe
 * bleeding, loss of consciousness, seizures, severe allergic reaction,
 * suicidal thoughts, pregnancy emergencies, severe dehydration in
 * children, and high fever in young infants are always escalations, and
 * these rules ALWAYS override any model output (see recommend.ts merge).
 *
 * Matching is intentionally plain: explicit "danger sign" chips the
 * patient taps, keyword patterns over the patient's own symptom words,
 * and structured combinations (e.g. pregnant + bleeding). No personal
 * data is involved — the input is symptoms and context only.
 */
import type { RedFlagHit, TriageIntake } from "./types";

/** Chips shown in the intake as "Are you experiencing any of these now?" */
export const DANGER_SIGNS: Array<{ id: string; label: string }> = [
  { id: "chest-pain", label: "Chest pain or pressure" },
  { id: "breathing-difficulty", label: "Trouble breathing" },
  { id: "stroke-signs", label: "Face drooping, arm weakness or speech difficulty" },
  { id: "severe-bleeding", label: "Severe bleeding that won't stop" },
  { id: "unconsciousness", label: "Fainted, collapsed or hard to wake" },
  { id: "seizure", label: "Seizure or convulsion" },
  { id: "severe-allergy", label: "Severe allergic reaction (throat/tongue swelling)" },
  { id: "suicidal-thoughts", label: "Thoughts of harming myself" },
];

const LABELS: Record<string, string> = {
  "chest-pain": "Chest pain or pressure",
  "breathing-difficulty": "Trouble breathing",
  "stroke-signs": "Possible stroke signs",
  "severe-bleeding": "Severe bleeding",
  unconsciousness: "Fainted, collapsed or unresponsive",
  seizure: "Seizure or convulsion",
  "severe-allergy": "Severe allergic reaction",
  "suicidal-thoughts": "Thoughts of self-harm",
  "pregnancy-emergency": "A pregnancy emergency sign",
  "infant-fever": "Fever in a baby under 3 months old",
  "child-dehydration": "Signs of severe dehydration in a child",
  "meningitis-signs": "Possible meningitis signs",
  "thunderclap-headache": "Sudden 'worst ever' headache",
  "poisoning-overdose": "Possible poisoning or overdose",
  "severe-burns": "A severe burn",
};

/** Patient-facing label for a rule id (used for server-returned ids too). */
export function redFlagLabel(id: string): string {
  return LABELS[id] ?? "A possible emergency sign";
}

/** Free-text patterns per rule. Tested against the normalised corpus. */
const TEXT_RULES: Array<{ id: string; patterns: RegExp[] }> = [
  {
    id: "chest-pain",
    patterns: [
      /chest (pain|pressure|tightness|discomfort|heaviness|burning)/,
      /pain (in|across|to) (my |the )?chest/,
      /crushing (pain|feeling) in (my |the )?chest/,
      /tight(ness)? (in|across) (my |the )?chest/,
    ],
  },
  {
    id: "breathing-difficulty",
    patterns: [
      /can'?t breathe|cannot breathe|can hardly breathe/,
      /(struggling|hard|difficult|unable) to breathe/,
      /(difficulty|trouble|struggling|hard) (with )?breathing/,
      /shortness of breath|short of breath/,
      /gasping (for )?(air|breath)/,
      /breathing (is )?(very )?(difficult|hard|laboured|labored)/,
    ],
  },
  {
    id: "stroke-signs",
    patterns: [
      /face (is )?(drooping|drooped|droops)/,
      /drooping (face|mouth|side)/,
      /(arm|leg|one side)[^.]{0,30}(weak|numb|paralys)/,
      /(weakness|numbness) on one side/,
      /slurred speech|speech (is )?(slurred|unclear|difficult)/,
      /can'?t speak (properly|clearly)/,
      /sudden (numbness|weakness|confusion|loss of vision|vision loss)/,
    ],
  },
  {
    id: "severe-bleeding",
    patterns: [
      /severe bleeding|heavy bleeding|bleeding (a lot|heavily)/,
      /bleeding (won'?t|will not|doesn'?t|does not|can'?t|cannot) stop/,
      /(vomiting|vomited|throwing up|coughing|coughed) (up )?blood/,
      /losing (a lot of |lots of )?blood/,
      /blood (gushing|spurting|pooling)/,
    ],
  },
  {
    id: "unconsciousness",
    patterns: [
      /unconscious|unresponsive/,
      /passed out|blacked out|blacking out/,
      /won'?t wake|will not wake|can'?t wake|cannot wake|hard to wake/,
      /\bcollapsed\b/,
      /\bfainted\b|\bfainting\b/,
    ],
  },
  {
    id: "seizure",
    patterns: [/seizure|convulsion|epileptic fit|having a fit|body (is )?jerking/],
  },
  {
    id: "severe-allergy",
    patterns: [
      /anaphyla/,
      /severe allergic|serious allergic/,
      /throat (is )?(closing|swelling|tight|swollen)/,
      /tongue (is )?(swelling|swollen)/,
      /swollen (tongue|lips and tongue)/,
      /allergic reaction[^.]{0,40}(throat|tongue|swell|breathe)/,
    ],
  },
  {
    id: "suicidal-thoughts",
    patterns: [
      /suicid/,
      /kill myself|end(ing)? my (own )?life|take my (own )?life|ending it all/,
      /want to die|wish i was dead|no reason to (live|go on)/,
      /(harm|hurt|cut) myself|self[- ]harm/,
    ],
  },
  {
    id: "thunderclap-headache",
    patterns: [
      /worst headache/,
      /thunderclap/,
      /sudden (severe|terrible|explosive) headache/,
      /headache[^.]{0,30}worst/,
    ],
  },
  {
    id: "poisoning-overdose",
    patterns: [
      /overdose|took too (many|much) (pills|tablets|medicine|medication)/,
      /swallowed (poison|chemicals?|paraffin|kerosene|bleach|pesticide)/,
      /drank (poison|chemicals?|paraffin|kerosene|bleach|pesticide)/,
      /been poisoned|was poisoned|child[^.]{0,30}swallowed/,
    ],
  },
  {
    id: "severe-burns",
    patterns: [
      /severe burn|serious burn|badly (burned|burnt|scalded)/,
      /burn (covering|over) (a large|most|the whole)/,
      /large burn|extensive burn/,
    ],
  },
];

const FEVER = /(fever|temperature|hot body|body (is )?hot|feeling hot)/;
const CHILD_BANDS = ["under-3-months", "3-12-months", "1-5-years"];

/** Build the screened corpus: the patient's own symptom words only. */
export function triageCorpus(intake: TriageIntake): string {
  const parts: string[] = [
    intake.chiefComplaint,
    ...intake.symptoms,
    // Follow-up ANSWERS are screened (never the question text — the bank's
    // questions name danger signs, so screening questions would escalate
    // every "No"). The bank's danger-probe options are self-describing
    // ("Yes, I have bleeding…"), so a concerning answer carries the words
    // that fire the rule and a reassuring one does not.
    ...intake.answers.map((a) => a.answer),
  ];
  return parts.join(" \n ").toLowerCase().replace(/\s+/g, " ");
}

/**
 * Run the full deterministic red-flag screen. Pure and synchronous.
 * Returns every rule that fired; an empty array means "no red flag found"
 * (NOT "safe" — the assessment copy always says this is not a diagnosis).
 */
export function screenRedFlags(intake: TriageIntake): RedFlagHit[] {
  const hits = new Map<string, RedFlagHit>();
  const add = (id: string) => {
    if (!hits.has(id)) hits.set(id, { id, label: LABELS[id] ?? id });
  };

  // 1. Explicit danger-sign chips — the strongest signal there is.
  for (const id of intake.dangerSigns) add(id);

  // 2. Keyword patterns over the patient's symptom words.
  const text = triageCorpus(intake);
  for (const rule of TEXT_RULES) {
    if (rule.patterns.some((p) => p.test(text))) add(rule.id);
  }

  // 3. Structured combinations.
  const hasFever = FEVER.test(text) || intake.symptoms.some((s) => /fever/i.test(s));

  // Pregnancy emergency: pregnant + any danger co-sign.
  const pregnancyDanger =
    /(bleeding|severe (abdominal|stomach|pelvic|belly) pain|baby (is )?not moving|reduced (fetal )?movement|not feeling the baby|severe headache|blurred vision|vision (changes|problems)|fluid leaking|waters? (broke|broken|leaking)|seizure|convulsion)/;
  if (intake.pregnant === "yes" && pregnancyDanger.test(text)) {
    add("pregnancy-emergency");
  }
  // Also fire when the words say pregnant even if the chip was skipped.
  if (/(i am|i'm|being) pregnant|pregnant (and|with)/.test(text) && pregnancyDanger.test(text)) {
    add("pregnancy-emergency");
  }

  // High fever in a baby under 3 months is always an emergency.
  if (intake.ageBand === "under-3-months" && hasFever) add("infant-fever");

  // Severe dehydration in a young child.
  const dehydration =
    /(no urine|not (urinating|peeing|passing urine)|no tears|sunken eyes|very drowsy|won'?t (drink|feed|breastfeed)|not (drinking|feeding|breastfeeding)|severe dehydration|severely dehydrated)/;
  if (
    (intake.ageBand !== null && CHILD_BANDS.includes(intake.ageBand) && dehydration.test(text)) ||
    /severe dehydration|severely dehydrated/.test(text)
  ) {
    add("child-dehydration");
  }

  // Meningitis pattern: fever + stiff neck / light sensitivity, or a
  // rash that does not fade under pressure at any time.
  const nonBlanching = /(rash|spots)[^.]{0,40}(doesn'?t|does not|won'?t|will not) fade|non[- ]blanching|purple (rash|spots)/;
  const neckOrLight = /(stiff neck|neck stiffness|stiffens|painful to look at (bright )?light|sensitivity to light|photophobia)/;
  if (nonBlanching.test(text) || (hasFever && neckOrLight.test(text))) {
    add("meningitis-signs");
  }

  return [...hits.values()];
}
