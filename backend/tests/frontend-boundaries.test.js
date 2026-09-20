import test from "node:test";
import assert from "node:assert/strict";
import { readFrontendSources } from "./helpers/frontend-source.mjs";

// Every module under frontend/src: App.jsx was split into sibling modules, and
// a retired surface must not come back in any of them.
const sources = readFrontendSources();

test("frontend excludes retired parent-notification and Anthropic compatibility surfaces", () => {
  for (const [name, source] of sources) {
    assert.doesNotMatch(source, /\bparentalNotify\b/, name + " must not call the removed notification client");
    assert.doesNotMatch(source, /\/notify-parent\b/i, name + " must not call the removed parent endpoint");
    assert.doesNotMatch(source, /chat\s*\|\s*anthropic/i, name + " must not accept the legacy proxy suffix");
    assert.doesNotMatch(source, /\banthropic(?:_beta)?\b/i, name + " must not retain Anthropic compatibility tokens");
  }
});
