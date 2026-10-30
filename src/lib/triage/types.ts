/**
 * Doc'O Clock AI Triage & Care Assistant — shared types.
 *
 * PRIVACY CONTRACT (CEO rule, 2026-10-27): this flow collects SYMPTOMS AND
 * SYMPTOM CONTEXT ONLY. There is deliberately no field for a name, email,
 * phone number, NRC/ID, address, user id, or any other identifier anywhere
 * in these types — the intake cannot carry personal data because there is
 * nowhere to put it. Age is an age BAND (never a date of birth or exact
 * age) and is asked only because infant-fever and pregnancy red-flag
 * rules are clinically meaningless without it.
 */

export type AgeBand =
  | "under-3-months"
  | "3-12-months"
  | "1-5-years"
  | "6-12-years"
  | "13-17-years"
  | "18-64-years"
  | "65-plus-years";

export type DurationBand =
  | "under-1-hour"
  | "today"
  | "2-3-days"
  | "4-7-days"
  | "over-1-week";

export type PregnancyStatus = "yes" | "no" | "not-applicable";

export type BodyArea =
  | "head-neck"
  | "chest-breathing"
  | "stomach-digestion"
  | "back-joints"
  | "skin"
  | "teeth-mouth"
  | "eyes-vision"
  | "ears-hearing"
  | "mind-mood"
  | "pregnancy"
  | "child-health"
  | "general";

export interface TriageAnswer {
  question: string;
  answer: string;
}

/** Everything the patient is ever asked. Symptoms + context, nothing else. */
export interface TriageIntake {
  chiefComplaint: string;
  /** Labels of symptom chips the patient picked. */
  symptoms: string[];
  /** Rule ids of the explicit "danger sign" chips the patient picked. */
  dangerSigns: string[];
  bodyArea: BodyArea | null;
  duration: DurationBand | null;
  /** 0–10 self-rated severity. */
  severity: number;
  ageBand: AgeBand | null;
  pregnant: PregnancyStatus | null;
  answers: TriageAnswer[];
}

export const EMPTY_INTAKE: TriageIntake = {
  chiefComplaint: "",
  symptoms: [],
  dangerSigns: [],
  bodyArea: null,
  duration: null,
  severity: 3,
  ageBand: null,
  pregnant: null,
  answers: [],
};

export interface RedFlagHit {
  /** Stable rule id, e.g. "chest-pain". */
  id: string;
  /** Patient-facing label of what was detected. */
  label: string;
}

export type UrgencyTier = "emergency" | "urgent" | "routine";

export interface ProfessionRecommendation {
  /** A role value from the platform's provider-profession taxonomy. */
  role: string;
  /** Display label, e.g. "Dentist". */
  label: string;
  /** Real booking-flow hand-off: /search honours ?specialty= and ?q=. */
  search: { specialty?: string; q?: string };
}

export interface TriageAssessment {
  urgency: Exclude<UrgencyTier, "emergency">;
  profession: ProfessionRecommendation;
  /** e.g. "Within 24 hours". */
  timeframe: string;
  /** Plain-language explanation of the recommendation. */
  summary: string;
  /** Where the guidance came from — always shown honestly in the UI. */
  source: "meta-ai" | "rules";
}

export interface FollowUpQuestion {
  id: string;
  text: string;
  options: string[];
}
