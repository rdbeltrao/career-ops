import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../../src/lib/run-prompts.mjs";

test("evaluation workers retain shared scoring rules and user overrides with either context source", () => {
  const library = {
    notice: "Current facts and preferences only.",
    text: "CURRENT_CONTEXT",
    evidenceText: "CURRENT_FACTS",
  };
  for (const contextLibrary of [null, library]) {
    for (const jdSource of ["ats-api", "scan-store"]) {
      const prompt = buildPrompt({
        kind: "evaluate", input: "https://example.com/jobs/1", memory: "",
        today: "2026-10-27", dataRoot: "/tmp/career-data", contextLibrary,
        jdFile: "/tmp/career-data/posting.md", jdSource,
      });
      assert.match(prompt, /Read modes\/_shared\.md for scoring rules, especially Evidence-bound scoring/);
      assert.match(prompt, /Read modes\/_custom\.md if present under the user data root/);
      assert.match(prompt, /Apply explicit missing-data score defaults/);
      assert.match(prompt, /do not turn unknown client identity, a hiring partner, or the JD's language alone into blockers/);
      if (contextLibrary) {
        assert.match(prompt, /CURRENT_CONTEXT/);
        assert.doesNotMatch(prompt, /then cv\.md,|if modes\/_context\.md exists/);
      }
    }
  }
});
