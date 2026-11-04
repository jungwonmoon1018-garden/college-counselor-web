import { describe, expect, it } from "vitest";
import { formatCouncilResult } from "../profile/strategy-council.js";
import { crisisDisclaimer, crisisResources, crisisResponseText } from "./crisis-lexicon.js";

// The Council route now sends the chat route's reply, resources already in
// `answer`. Rendering the actions again would list every line twice.
describe("Council crisis reply", () => {
  it("shows the server's text once, with the localized title", () => {
    for (const locale of ["en-US", "ko"]) {
      const body = {
        answer: crisisResponseText(locale), topic_type: "crisis", crisisSafe: true,
        actions: crisisResources(locale), limitations: [crisisDisclaimer(locale)],
        _meta: { deterministic: true, topicType: "CRISIS", modelTier: "NONE" },
      };
      const result = formatCouncilResult(body, locale);
      expect(result.text).toBe(crisisResponseText(locale));
      expect(result.text.split("741741").length - 1).toBe(1);
      expect(result.crisisSafe).toBe(true);
      expect(result.blocked).toBe(true);
      expect(result.council).toBe(false);
      expect(result.threadTitle).toBe(locale === "ko" ? "지원 안내" : "Support resources");
    }
  });

  it("recognizes an older server's crisis body by _meta alone", () => {
    const result = formatCouncilResult({ answer: "Please reach out:", actions: [{ name: "Lifeline", contact: "988" }], _meta: { topicType: "CRISIS" } });
    expect(result.crisisSafe).toBe(true);
    expect(result.text).toMatch(/988/);
  });
});
