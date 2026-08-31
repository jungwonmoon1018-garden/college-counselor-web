// ═══════════════════════════════════════════════════════════
// TESTS: pseudo-tool-call markup scrubbing in output screening
// ═══════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { screenOutput } from "../content-moderation.js";

describe("screenOutput pseudo-tool markup", () => {
  it("strips <|tool_call|>-style markup and call: fragments", () => {
    const raw = '<|tool_call>call:fetch_rag_context(focus="extracurriculars")<tool_call|>\n\nYour robotics club is a strong anchor for CS.';
    const out = screenOutput(raw);
    assert.equal(out.text, "Your robotics club is a strong anchor for CS.");
    assert.ok(out.issues.some((issue) => issue.type === "pseudo_tool_markup"));
  });

  it("strips bare tool-invocation lines and tool_code fences", () => {
    const raw = 'analyze_ec_strength()\n```tool_code\nget_ap_rigor(courses=["Calculus BC"])\n```\nAP Calculus BC is among the harder APs.';
    const out = screenOutput(raw);
    assert.ok(!/analyze_ec_strength|tool_code|get_ap_rigor/.test(out.text));
    assert.ok(out.text.includes("AP Calculus BC is among the harder APs."));
  });

  it("leaves ordinary counseling text alone", () => {
    const out = screenOutput("Call your counselor to confirm the deadline.");
    assert.equal(out.text, "Call your counselor to confirm the deadline.");
    assert.equal(out.safe, true);
  });
});
