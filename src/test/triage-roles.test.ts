import { describe, expect, it } from "vitest";
import { USER_ROLES } from "@/config/roleConfig";
import type { UserRole } from "@/config/roleConfig";
import { ROLE_PERMISSIONS, hasRoutePermission } from "@/utils/rolePermissions";
import {
  CLINICAL_TRIAGE_ROLES,
  getTriageMode,
  resolveActingRole,
  resolveTriageNextSteps,
} from "@/lib/triage/roleMode";
import type { TriageAssessment } from "@/lib/triage/types";

const ALL_ROLES = Object.values(USER_ROLES) as UserRole[];

const assessment: TriageAssessment = {
  urgency: "routine",
  profession: { role: "dentist", label: "Dentist", search: { specialty: "General Dentistry" } },
  timeframe: "Within the next 2–3 days",
  summary: "Dental symptoms are best assessed by a dentist.",
  source: "rules",
};

const routesOf = (mode: Parameters<typeof resolveTriageNextSteps>[0]["mode"], role: UserRole) =>
  resolveTriageNextSteps({
    mode,
    permissions: ROLE_PERMISSIONS[role] ?? [],
    assessment,
  });

describe("triage access — every role may open /triage", () => {
  it("hasRoutePermission([role], '/triage') is true for EVERY role in USER_ROLES", () => {
    for (const role of ALL_ROLES) {
      expect(hasRoutePermission([role], "/triage"), `role ${role}`).toBe(true);
    }
  });

  it("ROLE_PERMISSIONS itself carries '/triage' for every role (not only the super_admin bypass)", () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_PERMISSIONS[role] ?? [], `role ${role}`).toContain("/triage");
    }
  });
});

describe("getTriageMode — every role maps to exactly one mode", () => {
  it("maps every USER_ROLES value to one of patient/clinical/self", () => {
    for (const role of ALL_ROLES) {
      expect(["patient", "clinical", "self"], `role ${role}`).toContain(getTriageMode(role));
    }
  });

  it("spot-pins the required mappings", () => {
    expect(getTriageMode("patient")).toBe("patient");
    for (const role of ["doctor", "nurse", "pharmacist", "lab_technician", "triage_staff", "ambulance_staff"] as const) {
      expect(getTriageMode(role), `role ${role}`).toBe("clinical");
    }
    for (const role of ["receptionist", "super_admin", "admin", "courier", "institution_admin"] as const) {
      expect(getTriageMode(role), `role ${role}`).toBe("self");
    }
  });

  it("individual professionals are clinical; business entities are self", () => {
    for (const role of [
      "pharmacy_technologist", "pathologist", "phlebotomist", "radiographer",
      "health_personnel", "midwife", "psychologist", "community_health_worker",
    ] as const) {
      expect(getTriageMode(role), `role ${role}`).toBe("clinical");
    }
    for (const role of [
      "pharmacy", "wholesale_pharmacy", "lab", "institution_staff",
      "medical_records_officer", "hr_manager", "cxo", "ot_staff",
      "billing_staff", "finance_manager", "inventory_manager",
      "maintenance_manager", "support",
    ] as const) {
      expect(getTriageMode(role), `role ${role}`).toBe("self");
    }
  });

  it("the clinical set is exactly the 27 professions + triage_staff + ambulance_staff", () => {
    expect(CLINICAL_TRIAGE_ROLES.size).toBe(29);
    expect(CLINICAL_TRIAGE_ROLES.has("health_personnel")).toBe(true);
    expect(CLINICAL_TRIAGE_ROLES.has("pharmacy")).toBe(false);
    expect(CLINICAL_TRIAGE_ROLES.has("lab")).toBe(false);
  });

  it("unknown / missing role falls back to self — the least-privilege mode, never patient", () => {
    expect(getTriageMode(null)).toBe("self");
    expect(getTriageMode(undefined)).toBe("self");
    expect(getTriageMode({ currentRole: null, primaryRole: null, availableRoles: [] })).toBe("self");
  });
});

describe("resolveActingRole — current acting role wins", () => {
  it("prefers currentRole over primaryRole over highest-priority available role", () => {
    expect(
      resolveActingRole({ currentRole: "patient", primaryRole: "doctor", availableRoles: ["doctor", "patient"] }),
    ).toBe("patient");
    expect(
      resolveActingRole({ currentRole: null, primaryRole: "nurse", availableRoles: ["doctor", "nurse"] }),
    ).toBe("nurse");
    // No current/primary: ROLE_PRIORITY puts super_admin first.
    expect(
      resolveActingRole({ currentRole: null, primaryRole: null, availableRoles: ["patient", "super_admin"] }),
    ).toBe("super_admin");
  });

  it("mode follows the ACTING role, not the highest privilege the user holds", () => {
    // A doctor currently acting as a patient gets the patient mode…
    expect(getTriageMode({ currentRole: "patient", primaryRole: "doctor", availableRoles: ["doctor", "patient"] })).toBe("patient");
    // …and a multi-role user acting as super_admin gets self, not clinical.
    expect(getTriageMode({ currentRole: "super_admin", primaryRole: "doctor", availableRoles: ["doctor", "super_admin"] })).toBe("self");
  });
});

describe("resolveTriageNextSteps — least privilege per mode", () => {
  it("patient: includes the /search booking hand-off, honouring the profession search", () => {
    const steps = routesOf("patient", "patient");
    const links = steps.filter((s) => s.kind === "link");
    expect(links).toHaveLength(1);
    expect(links[0].route).toBe("/search?specialty=General%20Dentistry");
    expect(links[0].label).toContain("Dentist");
  });

  it("clinical: never /search — not even for roles whose permissions contain /search", () => {
    for (const role of ALL_ROLES.filter((r) => getTriageMode(r) === "clinical")) {
      const steps = routesOf("clinical", role);
      for (const step of steps) {
        expect(step.route ?? "", `role ${role}`).not.toMatch(/^\/search(\?|$)/);
      }
    }
  });

  it("clinical: /opd and /emergency appear only when the role already has them", () => {
    // Doctor has both via PROVIDER_CORE_ROUTES + its own grants.
    const doctorRoutes = routesOf("clinical", "doctor").map((s) => s.route).filter(Boolean);
    expect(doctorRoutes).toContain("/opd");
    expect(doctorRoutes).toContain("/emergency");
    // Lab technician has neither — guidance only, no invented links.
    const labSteps = routesOf("clinical", "lab_technician");
    expect(labSteps.filter((s) => s.kind === "link")).toHaveLength(0);
    expect(labSteps.some((s) => s.kind === "guidance")).toBe(true);
    // A stripped permission list yields no links at all.
    const stripped = resolveTriageNextSteps({ mode: "clinical", permissions: [], assessment });
    expect(stripped.filter((s) => s.kind === "link")).toHaveLength(0);
    // A permission list with only /opd yields exactly that link.
    const onlyOpd = resolveTriageNextSteps({ mode: "clinical", permissions: ["/opd"], assessment });
    expect(onlyOpd.filter((s) => s.kind === "link").map((s) => s.route)).toEqual(["/opd"]);
  });

  it("clinical: always carries the no-booking / no-record guidance", () => {
    const steps = routesOf("clinical", "doctor");
    const guidance = steps.find((s) => s.kind === "guidance");
    expect(guidance?.label).toMatch(/does not book/i);
    expect(guidance?.label).toMatch(/patient record/i);
    expect(guidance?.label).toMatch(/sign in as a patient/i);
  });

  it("self: never /search and never any admin or clinical target — whatever the permissions say", () => {
    for (const role of ["receptionist", "admin", "courier", "institution_admin", "super_admin"] as const) {
      const steps = routesOf("self", role);
      expect(steps.filter((s) => s.kind === "link"), `role ${role}`).toHaveLength(0);
      const guidance = steps.find((s) => s.kind === "guidance");
      expect(guidance?.label, `role ${role}`).toMatch(/patient account/i);
    }
    // Even a permission list stuffed with privileged routes changes nothing.
    const stuffed = resolveTriageNextSteps({
      mode: "self",
      permissions: ["/search", "/opd", "/emergency", "/admin-dashboard", "/super-admin-dashboard", "/medical-records"],
      assessment,
    });
    expect(stuffed.filter((s) => s.kind === "link")).toHaveLength(0);
  });

  it("super_admin in self mode gains no admin powers from triage", () => {
    expect(getTriageMode("super_admin")).toBe("self");
    const steps = routesOf("self", "super_admin");
    expect(steps.every((s) => s.kind === "guidance")).toBe(true);
  });
});
