/**
 * Anonymised payload builder for the Meta triage edge function.
 *
 * PRIVACY CONTRACT (CEO rule, 2026-10-27): what leaves the patient's
 * device for the AI step is built FIELD BY FIELD from a whitelist —
 * symptoms and symptom context only. The intake object itself is never
 * spread or serialised wholesale, so no identifier can leak by accident
 * if the intake type ever grows: there is no name, email, phone, ID,
 * address, user id, profile field or session metadata in this payload,
 * and the unit tests pin the exact key set.
 */
import type { TriageAnswer, TriageIntake } from "./types";

export interface AnonymisedTriagePayload {
  chiefComplaint: string;
  symptoms: string[];
  dangerSigns: string[];
  bodyArea: string | null;
  duration: string | null;
  severity: number;
  ageBand: string | null;
  pregnant: string | null;
  answers: TriageAnswer[];
}

export function buildAnonymisedPayload(intake: TriageIntake): AnonymisedTriagePayload {
  return {
    chiefComplaint: intake.chiefComplaint.trim().slice(0, 500),
    symptoms: intake.symptoms.slice(0, 30).map((s) => s.slice(0, 120)),
    dangerSigns: intake.dangerSigns.slice(0, 8),
    bodyArea: intake.bodyArea,
    duration: intake.duration,
    severity: intake.severity,
    ageBand: intake.ageBand,
    pregnant: intake.pregnant,
    answers: intake.answers.slice(0, 8).map((a) => ({
      question: a.question.slice(0, 200),
      answer: a.answer.slice(0, 500),
    })),
  };
}

/** Wire shapes returned by the meta-triage edge function. */
export type MetaTriageResponse =
  | { aiAvailable: false }
  | { aiAvailable: true; stage: "emergency"; redFlags: string[] }
  | {
      aiAvailable: true;
      stage: "followup";
      questions: Array<{ id: string; text: string; options: string[] }>;
    }
  | {
      aiAvailable: true;
      stage: "assessment";
      urgency: "emergency" | "urgent" | "routine";
      professionRole: string;
      timeframe?: string;
      summary?: string;
    };
