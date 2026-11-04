// shared/model-errors.js — one translation from whatever a model call threw
// into the HTTP status and the stable `code` the browser gets. /api/chat,
// the Council route and respondLLMError (the other model routes) all answer
// through it, and the client words each code for the student in English or
// Korean. A pure module, so the Council route can use it without pulling in
// the server's state.

// Codes the adapter (llm-adapters/) puts on what it throws. An error carrying
// one of these came from OpenRouter or from the call to it, never from our
// own checks, whatever its status says.
export const PROVIDER_ERROR_CODES = new Set([
  "auth_rejected", "http_error", "network_error", "aborted", "provider_timeout",
  "missing_api_key", "unsupported_provider", "model_not_allowed", "tools_disabled",
  "no_fetch", "missing_model",
]);

export function isProviderError(err) {
  return err?.provider === "openrouter" || PROVIDER_ERROR_CODES.has(String(err?.code || ""));
}

// It exists because the upstream status used to leave the server as our own:
// OpenRouter's 401 for a revoked operator key reached the browser as a 401,
// which the client reads as an expired session, so it spent a sign-in on the
// per-IP auth limiter, resent the same request_id onto a released
// reservation and showed a "monthly budget" error. A provider's 401/403 is
// now 502 provider_auth_failed, its 402 and 429 are 502 provider_error
// (neither is the student's cap or our limiter), and a stall is 504
// provider_timeout. The student's own 402 budget codes, the 403
// consent_required and the 409 duplicate keep their status and code.
export function modelErrorResponse(err) {
  const code = typeof err?.code === "string" ? err.code : "";
  const up = Number.isInteger(err?.status) ? err.status : null;
  if (code === "consent_required") {
    const missing = Array.isArray(err?.missing) ? err.missing : [];
    return {
      status: 403,
      body: { error: "AI consent is required before this request.", code, missing, missingConsents: missing, blocked: true },
    };
  }
  if (code === "empty_model_reply") {
    return { status: 502, body: { error: "The AI model returned an empty reply twice. Please try again.", code } };
  }
  if (isProviderError(err)) {
    if (code === "auth_rejected" || up === 401 || up === 403) {
      return { status: 502, body: { error: "The AI service rejected this site's credential. The counselor who runs this site needs to check it.", code: "provider_auth_failed", upstreamStatus: up } };
    }
    if (code === "provider_timeout" || up === 504) {
      return { status: 504, body: { error: "The AI provider took too long to respond, so the request was stopped. Please try again.", code: "provider_timeout" } };
    }
    if (code === "aborted" || up === 499) {
      return { status: 499, body: { error: "The request was cancelled.", code: "request_cancelled" } };
    }
    if (code === "missing_api_key" || code === "unsupported_provider") {
      return { status: 503, body: { error: "The administrator must configure OpenRouter before AI coaching is available.", code: "openrouter_not_configured" } };
    }
    return {
      status: 502,
      body: {
        error: up === 429
          ? "The AI service is busy right now. Wait a minute and try again."
          : "The AI service could not answer right now. Please try again in a moment.",
        code: "provider_error",
        upstreamStatus: up,
      },
    };
  }
  if (up === 402) {
    return {
      status: 402,
      body: { error: err?.message || "Monthly model budget does not allow this request.", code: code || "budget_exceeded", budget: err?.budget || null },
    };
  }
  if (up && up >= 400 && up < 500) {
    return { status: up, body: { error: err?.message || "The request could not be processed.", code: code || "request_failed" } };
  }
  if (up && up >= 500 && up < 600) {
    return { status: up, body: { error: err?.message || "The AI request failed.", code: code || "server_error" } };
  }
  return { status: 500, body: { error: "The AI request failed. Please try again.", code: "internal_error" } };
}
