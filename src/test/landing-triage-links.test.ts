import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// W1-F1 (2026-10-28): the landing page symptom chips must carry ONLY the
// body-area preselection (?area=). They previously also appended a
// pre-typed symptom (?s=Fever etc.), which let a single landing-page
// click silently create a pre-filled symptom on /triage — at odds with
// the triage surface's no-data-created-by-navigation behaviour (W5).
// The chips keep working via area alone; the user picks/types their own
// symptoms on /triage.

const readSrc = (p: string) => readFileSync(resolve(__dirname, "../../", p), "utf8");

describe("W1-F1 · landing triage chips carry area only, never a pre-filled symptom", () => {
  const landing = readSrc("src/pages/Landing.tsx");

  it("builds chip links from the area param alone", () => {
    expect(landing).toContain("to={`/triage?area=${chip.area}`}");
  });

  it("no landing link to /triage carries an s= symptom param", () => {
    const triageLinks = landing.match(/\/triage\?[^"`\s]*/g) || [];
    expect(triageLinks.length).toBeGreaterThan(0);
    for (const link of triageLinks) {
      expect(link).not.toMatch(/[?&]s=/);
    }
    // The old conditional-append construction is gone entirely.
    expect(landing).not.toContain("chip.s");
    expect(landing).not.toContain("&s=${");
  });

  it("all eight symptom chips still preselect their body area", () => {
    const areas = [
      "general",
      "teeth-mouth",
      "skin",
      "back-joints",
      "stomach-digestion",
      "mind-mood",
      "child-health",
      "eyes-vision",
    ];
    for (const area of areas) {
      expect(landing).toContain(`area: "${area}"`);
    }
  });
});
