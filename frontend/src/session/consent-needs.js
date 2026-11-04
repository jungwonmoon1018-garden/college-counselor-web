// Which consents a refusal names that the app may not grant on its own
// (debt-11). The heal in server-session.js re-grants only the three
// onboarding consents the student accepted at sign-up, and only when they
// were never recorded; anything else a route's 403 consent_required names is
// a permission the student has not been asked for. Filtered away, as it
// was, a newly required consent left the student with "Import failed" and no
// way forward; granted silently, it would be consent nobody gave. Such types
// go to the consent panel (components/ConsentNeeded.jsx), which asks.
import { ONBOARDING_CONSENT_TYPES } from "./server-session.js";

export function unknownConsentTypes(missing) {
  const out = [];
  for (const type of Array.isArray(missing) ? missing : []) {
    const id = String(type || "").trim();
    if (!id || ONBOARDING_CONSENT_TYPES.includes(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}
