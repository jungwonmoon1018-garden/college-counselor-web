import { describe, expect, it } from "vitest";
import { unknownConsentTypes } from "./consent-needs.js";

// The heal grants only the onboarding three; everything else a refusal names
// goes to the consent panel, once each, and never to the heal.
describe("unknownConsentTypes", () => {
  it("keeps the types the heal may not grant", () => {
    expect(unknownConsentTypes(["data_processing", "fafsa_contributor", "cross_border_transfer", "fafsa_contributor", "", null, "new_type"]))
      .toEqual(["fafsa_contributor", "new_type"]);
  });

  it("is empty when the refusal names only onboarding consents or nothing", () => {
    expect(unknownConsentTypes(["ai_interaction", "cross_border_transfer"])).toEqual([]);
    expect(unknownConsentTypes(undefined)).toEqual([]);
  });
});
