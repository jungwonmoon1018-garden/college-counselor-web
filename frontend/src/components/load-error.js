// load-error.js — what a self-loading card says when its request failed,
// in the student's language, and whether trying again can help. The cards
// used to fold every failure into their empty state: a 502 while the server
// restarted read "No prestige rationale cached yet" and "Evidence: none
// linked yet", both false, and a student could re-upload a certificate that
// was already on file (ui-12). A real empty answer keeps the empty copy.
import { t } from "../i18n.js";

export function loadErrorText(err, locale = "en-US") {
  const status = Number(err?.status) || 0;
  if (err?.sessionEnded || status === 401) return t(locale, "load.error_session");
  if (err?.timedOut) return t(locale, "load.error_timeout");
  if (status === 429) return t(locale, "load.error_rate");
  if (status === 403) return t(locale, "load.error_consent");
  if (status === 0) return t(locale, "load.error_network");
  return t(locale, "load.error_server");
}

// A session that ended needs a new sign-in, not another try.
export function loadErrorRetryable(err) {
  return !(err?.sessionEnded || Number(err?.status) === 401);
}
