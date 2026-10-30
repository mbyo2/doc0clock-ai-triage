/**
 * Role-wise, least-privilege behaviour for the AI Triage & Care Assistant.
 *
 * CEO order (2026-10-27): the triage assistant is usable by ALL user
 * roles, it must act role-wise according to the role the user is
 * CURRENTLY acting as, and it must never do more than the least
 * privilege for that role.
 *
 * This module is pure and render-free so the whole contract is unit
 * testable: it decides (a) which mode a role gets and (b) which next
 * steps an assessment may offer that role. It performs NO data access
 * of any kind.
 *
 * PRIVACY: the mode and the acting role are presentation-only. They are
 * NEVER added to the anonymised payload sent to the meta-triage edge
 * function (see payload.ts — its key set is pinned by tests), because
 * a role is profile metadata and the privacy contract forbids sending
 * any of that upstream.
 *
 * LEAST PRIVILEGE, by mode:
 *  - "patient": the original flow, including the booking hand-off.
 *  - "clinical": a clinician checking their own symptoms, or guiding
 *    someone with them. No booking on the work account, no patient
 *    record is opened or created. Next steps are only routes the role
 *    ALREADY has (/opd, /emergency) — otherwise plain guidance text.
 *  - "self": every other role (ops, admin, business and platform
 *    roles). Own-symptoms guidance only — no booking, no clinical or
 *    admin target at all. super_admin lands here on purpose: triage
 *    gains NO admin powers whatsoever.
 */
import {
  ALL_CLINICIAN_ROLES,
  ROLE_PRIORITY,
  USER_ROLES,
} from "@/config/roleConfig";
import type { UserRole } from "@/config/roleConfig";
import type { TriageAssessment } from "./types";

export type TriageMode = "patient" | "clinical" | "self";

/**
 * Clinical mode set: the platform's 27 provider professions (the same
 * set the meta-triage edge function allows as PROFESSIONS, mirrored
 * here by ALL_CLINICIAN_ROLES — which already includes
 * health_personnel) plus the two facility roles whose job is triage /
 * emergency response in person.
 *
 * Deliberately NOT here: the pharmacy / wholesale-pharmacy / lab
 * BUSINESS roles ('pharmacy', 'wholesale_pharmacy', 'lab'). The
 * individual professionals ('pharmacist', 'pharmacy_technologist',
 * 'pathologist', 'lab_technician', 'phlebotomist') are clinical; the
 * business entities are "self" — they get no clinical surface from
 * triage.
 */
export const CLINICAL_TRIAGE_ROLES: ReadonlySet<string> = new Set<string>([
  ...(ALL_CLINICIAN_ROLES as unknown as string[]),
  USER_ROLES.TRIAGE_STAFF,
  USER_ROLES.AMBULANCE_STAFF,
]);

export interface ActingRoleInput {
  currentRole?: UserRole | string | null;
  primaryRole?: UserRole | string | null;
  availableRoles?: ReadonlyArray<UserRole | string> | null;
}

/**
 * Resolve the role the user is currently acting as: currentRole first,
 * then primaryRole, then the highest-priority available role (per
 * ROLE_PRIORITY). Returns null when nothing is known — callers treat
 * that as "self" (the least-privilege mode), never as patient.
 */
export function resolveActingRole(
  input: ActingRoleInput | UserRole | string | null | undefined,
): UserRole | null {
  if (input == null) return null;
  if (typeof input === "string") return input as UserRole;
  if (input.currentRole) return input.currentRole as UserRole;
  if (input.primaryRole) return input.primaryRole as UserRole;
  const available = input.availableRoles ?? [];
  for (const role of ROLE_PRIORITY) {
    if (available.includes(role)) return role;
  }
  return (available[0] as UserRole | undefined) ?? null;
}

/** Map an acting role (or the resolver input) to exactly one mode. */
export function getTriageMode(
  input: ActingRoleInput | UserRole | string | null | undefined,
): TriageMode {
  const role = resolveActingRole(input);
  if (role === USER_ROLES.PATIENT) return "patient";
  if (role != null && CLINICAL_TRIAGE_ROLES.has(role)) return "clinical";
  return "self";
}

/** One short, plain statement of the mode's limit — shown on the intro. */
export const TRIAGE_MODE_INTRO: Record<TriageMode, string> = {
  patient:
    "You are checking as a patient: at the end you can book the care the assistant points you to.",
  clinical:
    "You are checking on a clinical work account: use this to check your own symptoms, or to guide someone with you to the right care. It does not book on this account and it does not open or create any patient record.",
  self:
    "You are checking on a work account: this is for your own symptoms only, and this account cannot book care. To book, use a patient account.",
};

export interface TriageNextStep {
  kind: "link" | "guidance";
  /** Target route for kind === "link"; always a route the role already has. */
  route?: string;
  label: string;
  description?: string;
}

export interface TriageNextStepsInput {
  mode: TriageMode;
  /** The acting role's OWN permission list (ROLE_PERMISSIONS[role]). */
  permissions: ReadonlyArray<string>;
  assessment?: TriageAssessment | null;
}

const has = (permissions: ReadonlyArray<string>, route: string) =>
  permissions.includes(route);

/**
 * Least-privilege next steps for an assessment.
 *
 * The permission list is matched LITERALLY — the super_admin route-guard
 * bypass is never consulted here, so a super_admin in "self" mode gets
 * no links at all even though their permission handling elsewhere lets
 * them open everything.
 */
export function resolveTriageNextSteps({
  mode,
  permissions,
  assessment,
}: TriageNextStepsInput): TriageNextStep[] {
  if (mode === "patient") {
    if (!has(permissions, "/search")) {
      return [
        {
          kind: "guidance",
          label:
            "To book care, use a patient account — this account can't book.",
        },
      ];
    }
    const search = assessment?.profession.search;
    let route = "/search";
    if (search?.specialty) {
      route = `/search?specialty=${encodeURIComponent(search.specialty)}`;
    } else if (search?.q) {
      route = `/search?q=${encodeURIComponent(search.q)}`;
    }
    return [
      {
        kind: "link",
        route,
        label: assessment
          ? `Find & book a ${assessment.profession.label}`
          : "Find & book care",
      },
    ];
  }

  if (mode === "clinical") {
    const steps: TriageNextStep[] = [];
    if (has(permissions, "/opd")) {
      steps.push({
        kind: "link",
        route: "/opd",
        label: "Open the OPD queue",
        description: "Your own outpatient queue — for the person with you, in person.",
      });
    }
    if (has(permissions, "/emergency")) {
      steps.push({
        kind: "link",
        route: "/emergency",
        label: "Open the emergency page",
      });
    }
    steps.push({
      kind: "guidance",
      label:
        "This work account does not book and does not open or create a patient record. To book an appointment, advise the person to sign in as a patient and use the symptom check there.",
    });
    return steps;
  }

  // "self" — guidance only, whatever the role's permissions contain.
  return [
    {
      kind: "guidance",
      label:
        "To book care, use a patient account — this work account can't book.",
      description:
        "This result is guidance for your own symptoms only. Nothing was saved, and no record, booking or admin action was created.",
    },
  ];
}
