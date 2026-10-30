import { describe, expect, it } from "vitest";
import {
  mergeAssessment,
  rulesAssessment,
  rulesFollowUps,
  rulesUrgencyFloor,
} from "@/lib/triage/recommend";
import { buildAnonymisedPayload } from "@/lib/triage/payload";
import { EMPTY_INTAKE, type TriageIntake } from "@/lib/triage/types";

const mk = (partial: Partial<TriageIntake>): TriageIntake => ({ ...EMPTY_INTAKE, ...partial });

describe("rules assessment — profession mapping", () => {
  it("dental symptoms → dentist, General Dentistry search", () => {
    const a = rulesAssessment(mk({ chiefComplaint: "Toothache for three days", bodyArea: "teeth-mouth" }));
    expect(a.profession.role).toBe("dentist");
    expect(a.profession.search.specialty).toBe("General Dentistry");
    expect(a.source).toBe("rules");
  });

  it("eye symptoms → optometrist", () => {
    const a = rulesAssessment(mk({ chiefComplaint: "My vision has been blurry this week", bodyArea: "eyes-vision" }));
    expect(a.profession.role).toBe("optometrist");
  });

  it("mental-health symptoms → psychologist", () => {
    const a = rulesAssessment(mk({ chiefComplaint: "I feel anxious and depressed most days", bodyArea: "mind-mood" }));
    expect(a.profession.role).toBe("psychologist");
  });

  it("routine pregnancy → midwife", () => {
    const a = rulesAssessment(mk({ chiefComplaint: "I need an antenatal check-up", pregnant: "yes" }));
    expect(a.profession.role).toBe("midwife");
  });

  it("suspected fracture → doctor (Orthopedics) with urgent floor", () => {
    const a = rulesAssessment(mk({ chiefComplaint: "I fell and think I have a broken wrist, I can't bear weight on it" }));
    expect(a.profession.role).toBe("doctor");
    expect(a.profession.search.specialty).toBe("Orthopedics");
    expect(a.urgency).toBe("urgent");
  });

  it("back pain → physiotherapist", () => {
    const a = rulesAssessment(mk({ chiefComplaint: "Lower back pain after lifting boxes", bodyArea: "back-joints" }));
    expect(a.profession.role).toBe("physiotherapist");
  });

  it("palpitations → doctor (Cardiology), urgent", () => {
    const a = rulesAssessment(mk({ chiefComplaint: "I keep getting palpitations in the evening" }));
    expect(a.profession.search.specialty).toBe("Cardiology");
    expect(a.urgency).toBe("urgent");
  });

  it("young child → doctor (Pediatrics)", () => {
    const a = rulesAssessment(mk({ chiefComplaint: "My son has a cough and a runny nose", ageBand: "1-5-years" }));
    expect(a.profession.search.specialty).toBe("Pediatrics");
  });

  it("skin rash → doctor (Dermatology)", () => {
    const a = rulesAssessment(mk({ chiefComplaint: "An itchy rash on my arm", bodyArea: "skin" }));
    expect(a.profession.search.specialty).toBe("Dermatology");
  });

  it("unmatched symptoms → doctor (General Practice) as the safe default", () => {
    const a = rulesAssessment(mk({ chiefComplaint: "I just feel generally unwell and tired" }));
    expect(a.profession.role).toBe("doctor");
    expect(a.profession.search.specialty).toBe("General Practice");
  });
});

describe("rules urgency floor", () => {
  it("severity 9 is urgent even for a routine complaint", () => {
    expect(rulesUrgencyFloor(mk({ chiefComplaint: "toothache", severity: 9 }))).toBe("urgent");
  });

  it("mild severity stays routine", () => {
    expect(rulesUrgencyFloor(mk({ chiefComplaint: "mild cold", severity: 2, duration: "2-3-days" }))).toBe("routine");
  });

  it("fever in a 3–12 month old is urgent", () => {
    expect(rulesUrgencyFloor(mk({ chiefComplaint: "fever since last night", ageBand: "3-12-months" }))).toBe("urgent");
  });

  it("'getting worse' + moderate severity is urgent", () => {
    const intake = mk({
      chiefComplaint: "cough",
      severity: 5,
      answers: [{ question: "Course?", answer: "Getting worse" }],
    });
    expect(rulesUrgencyFloor(intake)).toBe("urgent");
  });
});

describe("mergeAssessment — rules always override the model", () => {
  const rules = rulesAssessment(mk({ chiefComplaint: "palpitations daily", severity: 3 }));

  it("a model may escalate urgency but never de-escalate below the rules floor", () => {
    // rules floor here is urgent (palpitations); model says routine → stays urgent
    const merged = mergeAssessment(rules, { urgency: "routine", professionRole: "doctor" });
    expect(merged?.urgency).toBe("urgent");
  });

  it("a model escalation to urgent is honoured over a routine floor", () => {
    const routineRules = rulesAssessment(mk({ chiefComplaint: "mild cold", severity: 1 }));
    const merged = mergeAssessment(routineRules, { urgency: "urgent", professionRole: "doctor" });
    expect(merged?.urgency).toBe("urgent");
  });

  it("a model 'emergency' verdict returns null — caller must show the emergency screen", () => {
    expect(mergeAssessment(rules, { urgency: "emergency", professionRole: "doctor" })).toBeNull();
  });

  it("a profession outside the platform taxonomy is rejected in favour of the rules pick", () => {
    const merged = mergeAssessment(rules, { urgency: "urgent", professionRole: "astronaut" });
    expect(merged?.profession.role).toBe(rules.profession.role);
    expect(merged?.source).toBe("meta-ai");
  });

  it("a valid taxonomy profession from the model is used", () => {
    const merged = mergeAssessment(rules, { urgency: "urgent", professionRole: "dentist" });
    expect(merged?.profession.role).toBe("dentist");
    expect(merged?.profession.label).toBe("Dentist");
  });
});

describe("rules follow-up bank", () => {
  it("pregnancy gets the pregnancy probes", () => {
    const qs = rulesFollowUps(mk({ pregnant: "yes", chiefComplaint: "antenatal visit" }));
    expect(qs.map((q) => q.id)).toContain("preg-bleeding");
  });

  it("dental gets the dental probe", () => {
    const qs = rulesFollowUps(mk({ bodyArea: "teeth-mouth", chiefComplaint: "toothache" }));
    expect(qs.map((q) => q.id)).toContain("swelling");
  });

  it("anything else gets the generic bank", () => {
    const qs = rulesFollowUps(mk({ chiefComplaint: "tired all the time" }));
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.map((q) => q.id)).toContain("course");
  });
});

describe("anonymised payload — privacy pins", () => {
  it("contains exactly the whitelisted symptom/context keys and nothing else", () => {
    const payload = buildAnonymisedPayload(
      mk({ chiefComplaint: " headache ", symptoms: ["Fever"], ageBand: "18-64-years", severity: 4 }),
    );
    expect(Object.keys(payload).sort()).toEqual(
      [
        "ageBand",
        "answers",
        "bodyArea",
        "chiefComplaint",
        "dangerSigns",
        "duration",
        "pregnant",
        "severity",
        "symptoms",
      ].sort(),
    );
  });

  it("serialises with no identity-bearing keys or values anywhere", () => {
    const payload = buildAnonymisedPayload(mk({ chiefComplaint: "fever", symptoms: ["Fever"] }));
    const wire = JSON.stringify(payload).toLowerCase();
    for (const forbidden of ["userid", "user_id", "email", "phone", "nrc", "address", "name", "profile", "session", "ip"]) {
      expect(wire).not.toContain(`"${forbidden}"`);
    }
  });

  it("trims and caps free text", () => {
    const payload = buildAnonymisedPayload(mk({ chiefComplaint: `  ${"x".repeat(900)}  ` }));
    expect(payload.chiefComplaint.length).toBe(500);
  });
});
