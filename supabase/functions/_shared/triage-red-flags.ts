/**
 * Server-side copy of the triage red-flag screen (defence in depth).
 *
 * The canonical screen runs on the patient's device in
 * src/lib/triage/redFlags.ts BEFORE any network call. This copy runs
 * again inside the meta-triage edge function over the anonymised payload,
 * so a danger sign escalates even if a client is old, modified, or buggy.
 * KEEP THE RULES IN SYNC with src/lib/triage/redFlags.ts.
 *
 * Pure functions only: no I/O, no storage, no logging.
 */

export interface ScreenIntake {
  chiefComplaint: string;
  symptoms: string[];
  dangerSigns: string[];
  ageBand: string | null;
  pregnant: string | null;
  answers: Array<{ question: string; answer: string }>;
}

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

export function screenRedFlagsServer(intake: ScreenIntake): string[] {
  const hits = new Set<string>();
  for (const id of intake.dangerSigns) hits.add(id);

  const text = [
    intake.chiefComplaint,
    ...intake.symptoms,
    ...intake.answers.map((a) => a.answer),
  ]
    .join(" \n ")
    .toLowerCase()
    .replace(/\s+/g, " ");

  for (const rule of TEXT_RULES) {
    if (rule.patterns.some((p) => p.test(text))) hits.add(rule.id);
  }

  const hasFever = FEVER.test(text) || intake.symptoms.some((s) => /fever/i.test(s));

  const pregnancyDanger =
    /(bleeding|severe (abdominal|stomach|pelvic|belly) pain|baby (is )?not moving|reduced (fetal )?movement|not feeling the baby|severe headache|blurred vision|vision (changes|problems)|fluid leaking|waters? (broke|broken|leaking)|seizure|convulsion)/;
  if (intake.pregnant === "yes" && pregnancyDanger.test(text)) hits.add("pregnancy-emergency");
  if (/(i am|i'm|being) pregnant|pregnant (and|with)/.test(text) && pregnancyDanger.test(text)) {
    hits.add("pregnancy-emergency");
  }

  if (intake.ageBand === "under-3-months" && hasFever) hits.add("infant-fever");

  const dehydration =
    /(no urine|not (urinating|peeing|passing urine)|no tears|sunken eyes|very drowsy|won'?t (drink|feed|breastfeed)|not (drinking|feeding|breastfeeding)|severe dehydration|severely dehydrated)/;
  if (
    (intake.ageBand !== null && CHILD_BANDS.includes(intake.ageBand) && dehydration.test(text)) ||
    /severe dehydration|severely dehydrated/.test(text)
  ) {
    hits.add("child-dehydration");
  }

  const nonBlanching = /(rash|spots)[^.]{0,40}(doesn'?t|does not|won'?t|will not) fade|non[- ]blanching|purple (rash|spots)/;
  const neckOrLight = /(stiff neck|neck stiffness|stiffens|painful to look at (bright )?light|sensitivity to light|photophobia)/;
  if (nonBlanching.test(text) || (hasFever && neckOrLight.test(text))) hits.add("meningitis-signs");

  return [...hits];
}
