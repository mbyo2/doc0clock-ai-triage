import { describe, expect, it } from "vitest";
import { DANGER_SIGNS, screenRedFlags, triageCorpus } from "@/lib/triage/redFlags";
import { EMPTY_INTAKE, type TriageIntake } from "@/lib/triage/types";

const mk = (partial: Partial<TriageIntake>): TriageIntake => ({ ...EMPTY_INTAKE, ...partial });
const ids = (intake: TriageIntake) => screenRedFlags(intake).map((h) => h.id);

describe("red-flag engine — explicit danger chips", () => {
  it("every danger-sign chip escalates with its own rule id", () => {
    for (const sign of DANGER_SIGNS) {
      expect(ids(mk({ dangerSigns: [sign.id] }))).toContain(sign.id);
    }
  });
});

describe("red-flag engine — text patterns escalate", () => {
  const cases: Array<[string, string]> = [
    // chest pain
    ["chest-pain", "I have had chest pain since this morning"],
    ["chest-pain", "There is a tightness in my chest when I walk"],
    ["chest-pain", "crushing pain in the chest radiating to my arm"],
    // breathing
    ["breathing-difficulty", "I can't breathe properly since an hour ago"],
    ["breathing-difficulty", "severe shortness of breath even when resting"],
    ["breathing-difficulty", "my child is struggling to breathe"],
    // stroke FAST
    ["stroke-signs", "his face is drooping on the left side"],
    ["stroke-signs", "sudden weakness on one side of my body"],
    ["stroke-signs", "her speech is slurred and unclear"],
    // severe bleeding
    ["severe-bleeding", "the bleeding won't stop after 20 minutes of pressure"],
    ["severe-bleeding", "he is vomiting blood"],
    ["severe-bleeding", "heavy bleeding from the wound"],
    // unconsciousness
    ["unconsciousness", "she passed out at the market"],
    ["unconsciousness", "my father is unconscious and unresponsive"],
    ["unconsciousness", "the baby won't wake up for feeding"],
    // seizure
    ["seizure", "he had a seizure five minutes ago"],
    ["seizure", "convulsions that lasted about a minute"],
    // severe allergy
    ["severe-allergy", "I think it is anaphylaxis after eating peanuts"],
    ["severe-allergy", "severe allergic reaction, my throat is closing"],
    ["severe-allergy", "her tongue is swelling after taking the medicine"],
    // suicidal thoughts
    ["suicidal-thoughts", "I keep thinking about ending my life"],
    ["suicidal-thoughts", "sometimes I want to harm myself"],
    // thunderclap headache
    ["thunderclap-headache", "it is the worst headache of my life"],
    ["thunderclap-headache", "a sudden severe headache like a thunderclap"],
    // poisoning / overdose
    ["poisoning-overdose", "my toddler swallowed paraffin an hour ago"],
    ["poisoning-overdose", "she took too many pills, I fear an overdose"],
    // severe burns
    ["severe-burns", "he was badly burned by hot oil"],
    ["severe-burns", "a severe burn covering a large part of his leg"],
  ];

  it.each(cases)("%s escalates for: %s", (ruleId, text) => {
    expect(ids(mk({ chiefComplaint: text }))).toContain(ruleId);
  });
});

describe("red-flag engine — structured combinations", () => {
  it("pregnant + bleeding escalates as a pregnancy emergency", () => {
    expect(ids(mk({ chiefComplaint: "I am spotting", pregnant: "yes", symptoms: ["Bleeding"] })))
      .toContain("pregnancy-emergency");
  });

  it("pregnant + reduced baby movement escalates", () => {
    expect(ids(mk({ chiefComplaint: "The baby is not moving like before", pregnant: "yes" })))
      .toContain("pregnancy-emergency");
  });

  it("pregnancy mentioned in words + severe pain escalates even without the chip", () => {
    expect(ids(mk({ chiefComplaint: "I am pregnant and having severe abdominal pain" })))
      .toContain("pregnancy-emergency");
  });

  it("fever in a baby under 3 months escalates", () => {
    expect(ids(mk({ chiefComplaint: "My baby has a fever", ageBand: "under-3-months" })))
      .toContain("infant-fever");
    expect(ids(mk({ chiefComplaint: "hot body since last night", ageBand: "under-3-months" })))
      .toContain("infant-fever");
  });

  it("dehydration signs in a young child escalate", () => {
    expect(ids(mk({ chiefComplaint: "diarrhoea all day, no urine since morning and no tears when crying", ageBand: "1-5-years" })))
      .toContain("child-dehydration");
  });

  it("fever + stiff neck escalates as meningitis signs", () => {
    expect(ids(mk({ chiefComplaint: "high fever and a stiff neck since yesterday" })))
      .toContain("meningitis-signs");
  });

  it("a rash that does not fade escalates even without fever", () => {
    expect(ids(mk({ chiefComplaint: "purple spots on her legs, the rash doesn't fade when pressed" })))
      .toContain("meningitis-signs");
  });

  it("a 'yes' to the pregnancy bleeding follow-up probe escalates", () => {
    const intake = mk({
      pregnant: "yes",
      chiefComplaint: "I feel unwell",
      answers: [{ question: "Any bleeding or leaking fluid?", answer: "Yes, I have bleeding or leaking fluid" }],
    });
    expect(ids(intake)).toContain("pregnancy-emergency");
  });

  it("a 'no' to the same probe does NOT escalate (question text is never screened)", () => {
    const intake = mk({
      pregnant: "yes",
      chiefComplaint: "morning sickness and tiredness",
      answers: [{ question: "Any bleeding or leaking fluid?", answer: "No" }],
    });
    expect(ids(intake)).not.toContain("pregnancy-emergency");
    expect(ids(intake)).toHaveLength(0);
  });
});

describe("red-flag engine — benign inputs do NOT escalate", () => {
  const benign: string[] = [
    "I have a mild headache since yesterday",
    "Toothache for three days, worse when I drink something cold",
    "My gums bleed a little when I brush my teeth",
    "Seasonal allergies — sneezing and itchy eyes every morning",
    "I feel dizzy for a few seconds when I stand up quickly",
    "Chest congestion and a cough from a cold",
    "I feel anxious and cannot sleep well these days",
    "Fever and cough for two days, drinking water fine",
    "I sprained my ankle playing football on Saturday",
    "Lower back pain after lifting heavy boxes",
    "A rash on my arm that itches, probably from a new soap",
    "Stomach ache after eating too much, with some nausea",
    "My knee hurts when I climb stairs",
    "Sore throat and a runny nose since Monday",
  ];

  it.each(benign)("no escalation for: %s", (text) => {
    expect(ids(mk({ chiefComplaint: text }))).toHaveLength(0);
  });

  it("pregnant + morning sickness alone does not escalate", () => {
    expect(ids(mk({ chiefComplaint: "morning sickness and tiredness", pregnant: "yes" }))).toHaveLength(0);
  });

  it("fever in an 8-month-old alone does not escalate (urgency floor handles it)", () => {
    expect(ids(mk({ chiefComplaint: "fever since last night", ageBand: "3-12-months" }))).toHaveLength(0);
  });

  it("an empty intake does not escalate", () => {
    expect(ids(mk({}))).toHaveLength(0);
  });
});

describe("triageCorpus", () => {
  it("contains symptom words and answers, lowercased", () => {
    const corpus = triageCorpus(
      mk({ chiefComplaint: "Chest Issues", answers: [{ question: "Q?", answer: "Getting Worse" }] }),
    );
    expect(corpus).toContain("chest issues");
    expect(corpus).toContain("getting worse");
    expect(corpus).not.toContain("q?");
  });
});
