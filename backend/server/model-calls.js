// server/model-calls.js — everything around one model call made for a
// student: the budget reservation and its reconcile/release, the operator key,
// the per-student callLLM, JSON parsing of a reply and the error response. Moved out of server.js on 2026-09-20.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (MAX_TOKENS_LIMIT, OPERATOR_LLM,
// SIM_INTERNAL_TOKEN, SIM_URL, authStore, db, piiStmts, ragStmts).
import { safeJSON } from "./auth.js";
import { reconcileBudget, releaseBudget, reserveBudget } from "../security/usage-budget.js";
import crypto from "node:crypto";
import { OPENROUTER_TARGETS } from "../scouts/openrouter-model-refresh.js";
import { callLLM as adapterCallLLM, effectiveMaxTokens as adapterEffectiveMaxTokens } from "../llm-adapters/index.js";
import { validateRequiredConsents } from "../security/consent.js";
import { modelErrorResponse } from "../shared/model-errors.js";

let deps;
export function bindModelCalls(serverDeps) { deps = serverDeps; }

export function snapshotToStudentProfile(snapshot, narrative = null) {
  return {
    gpa: { unweighted: snapshot.gpa_unweighted, weighted: snapshot.gpa_weighted },
    classRank: safeJSON(snapshot.class_rank_json, null),
    courses: safeJSON(snapshot.courses_json, []),
    apScores: safeJSON(snapshot.ap_scores_json, []),
    testScores: safeJSON(snapshot.test_scores_json, []),
    activities: safeJSON(snapshot.activities_json, []),
    goals: safeJSON(snapshot.goals_json, []),
    majorInterest: snapshot.major_interest,
    narrative: narrative?.narrativeText || null,
  };
}

export async function callSimulationSidecar(pathname, options = {}) {
  const response = await fetch(`${deps.SIM_URL}${pathname}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "x-simulation-internal-token": deps.SIM_INTERNAL_TOKEN,
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(data?.error || `Simulation sidecar returned ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

// ─── Prestige adapter resolver ──────────────────────────────
// Prestige web-research is currently disabled: this returns null, so
// competition-research.js short-circuits to source:"unavailable" and the EC
// vectorizer falls back to deterministic signals (catalog / benchmark). Re-
// enabling web-enriched prestige on OpenRouter's web plugin is a tracked
// follow-up.
export function resolvePrestigeAdapter(_studentId) {
  return null;
}

// ───────────────────────────────────────────────────────────
// Shared per-student paid-call closure. The installation-wide OpenRouter key
// is fixed by the local administrator; the student identity is used only for
// budget reservation, reconciliation, and the usage ledger.
// ───────────────────────────────────────────────────────────
export function estimateModelInputTokens(system, messages) {
  const chars = String(system || "").length + JSON.stringify(messages || []).length;
  return Math.max(256, Math.min(100_000, Math.ceil(chars / 4)));
}

export function reserveStudentModelCall(studentId, model, { system, messages, maxTokens, requestId } = {}) {
  const grade = deps.authStore.getStudentGrade(studentId);
  const reservation = reserveBudget(deps.db, {
    studentId,
    grade,
    requestId: requestId || crypto.randomUUID(),
    model,
    maxInputTokens: estimateModelInputTokens(system, messages),
    // What the adapter will really ask for (a reasoning model is floored at
    // 8,192), not what the caller asked: the reservation is the pre-call
    // check that this call fits the month, and it used to cover an eighth of
    // a reasoning model's possible output. A student close to the cap now
    // sees the 402 one call earlier, which is the point.
    maxOutputTokens: adapterEffectiveMaxTokens(model, Math.max(1, Math.min(Number(maxTokens) || 1024, deps.MAX_TOKENS_LIMIT))),
  });
  if (reservation.code === "request_id_released") {
    const error = new Error("This request_id belongs to a call that already failed; send the retry with a new request_id.");
    error.status = 409;
    error.code = "request_id_released";
    throw error;
  }
  if (!reservation.allowed) {
    const error = new Error(reservation.reason || "Monthly model budget does not allow this request.");
    error.status = 402;
    error.code = reservation.code || "budget_exceeded";
    error.budget = reservation;
    throw error;
  }
  if (reservation.idempotent) {
    const error = new Error("This request_id has already been reserved or processed.");
    error.status = 409;
    error.code = "duplicate_request_id";
    throw error;
  }
  return reservation;
}

export function reconcileStudentModelCall(reservation, usage) {
  return reconcileBudget(deps.db, {
    reservationId: reservation.reservationId,
    inputTokens: usage?.input_tokens || 0,
    outputTokens: usage?.output_tokens || 0,
  });
}

export function releaseStudentModelCall(reservation) {
  if (reservation?.reservationId) releaseBudget(deps.db, { reservationId: reservation.reservationId });
}

export function currentOperatorKeyConfig() {
  return deps.OPERATOR_LLM ? {
    provider: "openrouter",
    apiKey: deps.OPERATOR_LLM.apiKey,
    models: { ...OPENROUTER_TARGETS },
  } : null;
}

// Every paid call for a student needs the AI consents (data processing, AI
// interaction, cross-border transfer). Consent was checked route by route,
// and five paths never checked it: the candidate and spike re-ranks, the EC
// ideas, the narrative draft, and the auto-narrative that runs in the
// background after a sync. Checking here, at the one place every paid call
// passes, means a new route cannot forget, and a withdrawn consent
// (POST /api/consent/revoke) stops every AI feature at once. The per-route
// checks stay; they answer before any work is done.
export function consentRequiredError(missing) {
  const error = new Error("AI consent is required before this request.");
  error.status = 403;
  error.code = "consent_required";
  error.missing = Array.isArray(missing) ? missing : [];
  return error;
}

export function assertStudentAIConsent(studentId) {
  const consents = validateRequiredConsents(deps.piiStmts, studentId, "ai_interaction");
  if (!consents.allowed) throw consentRequiredError(consents.missing);
}

export function buildStudentCallLLM(studentId, { requestIdPrefix = null } = {}) {
  const operator = currentOperatorKeyConfig();
  if (!operator) return { modelConfig: null, callLLM: null };
  let callIndex = 0;
  const callLLM = async (args = {}) => {
    assertStudentAIConsent(studentId);
    const model = args.model || operator.models.medium;
    const maxTokens = Math.max(1, Math.min(Number(args.max_tokens ?? args.maxTokens) || 1024, deps.MAX_TOKENS_LIMIT));
    const requestId = String(args.requestId || (requestIdPrefix
      ? requestIdPrefix + ":" + (++callIndex)
      : crypto.randomUUID()));
    const reservation = reserveStudentModelCall(studentId, model, {
      system: args.system,
      messages: args.messages,
      maxTokens,
      requestId,
    });
    try {
      const result = await adapterCallLLM({
        provider: "openrouter",
        apiKey: operator.apiKey,
        model,
        maxTokens,
        system: args.system,
        messages: args.messages,
        temperature: typeof args.temperature === "number" ? args.temperature : undefined,
        signal: args.signal,
      });
      const budget = reconcileStudentModelCall(reservation, result?.usage);
      // The call can outlast the account: a student who deletes it while an
      // answer is on the way must not get a usage row back for an id that no
      // longer exists (the erasure sweep would find it, but nothing else
      // ever would).
      if (deps.authStore?.studentExists && !deps.authStore.studentExists(studentId)) return { ...result, _budget: budget };
      try {
        deps.ragStmts.insertUsage.run(
          studentId,
          "openrouter:" + model,
          result?.usage?.input_tokens || 0,
          result?.usage?.output_tokens || 0,
          "administrator",
        );
      } catch { /* usage ledger is authoritative */ }
      return { ...result, _budget: budget };
    } catch (error) {
      releaseStudentModelCall(reservation);
      throw error;
    }
  };
  return { modelConfig: operator, callLLM };
}

// Defensive JSON extraction from an LLM text response. Strip JSON/code
// fences, else grab the first object or array block. Returns null on failure
// so callers never crash on malformed model output.
export function parseLLMJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/[[{][\s\S]*[}\]]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// The error-to-status translation lives in shared/model-errors.js so the
// Council route can use it too; re-exported here for the routes that reach
// it through routeDeps.
export { modelErrorResponse };

// Map a fixed-OpenRouter adapter error to an informative HTTP response instead
// of an opaque 500. Secret remediation belongs to the local administrator;
// students never manage provider keys or model selection. The status and code
// come from modelErrorResponse, so these routes and /api/chat agree: an
// upstream 401 used to leave here as a 401 too.
export function respondLLMError(res, err, label) {
  // A missing or withdrawn consent is the student's to resolve, not a
  // provider failure; without this branch its 403 read as "the OpenRouter
  // credential was rejected".
  if (err?.code === "consent_required") {
    return res.status(403).json({
      error: "AI consent is required before this request.",
      code: "consent_required",
      missing: Array.isArray(err.missing) ? err.missing : [],
    });
  }
  const up = Number.isInteger(err?.status) ? err.status : null;
  const mapped = modelErrorResponse(err);
  console.error(`[${label}] LLM error${up ? ` (upstream ${up})` : ""}:`, err?.message);
  let friendly;
  if (mapped.body.code === "provider_timeout") friendly = "The AI provider took too long to respond, so the request was stopped. Please try again.";
  else if (mapped.body.code === "provider_auth_failed") friendly = "The configured OpenRouter credential was rejected. Ask the local administrator to verify it.";
  else if (mapped.body.code === "provider_error" && up === 429) friendly = "The AI service is rate-limiting requests (HTTP 429). Wait a moment and retry.";
  else if (mapped.body.code === "provider_error" && up === 402) friendly = "The AI service reports insufficient provider credit or quota. Ask the local administrator to review the OpenRouter account.";
  else if (mapped.status === 402) friendly = mapped.body.error;
  else friendly = "The AI request failed. Please try again; if it persists, ask the local administrator to check OpenRouter.";
  return res.status(mapped.status).json({
    ...mapped.body,
    error: friendly,
    detail: err?.message || null,
    provider: err?.provider || null,
    upstreamStatus: up,
  });
}

export function llmResponseText(response) {
  return Array.isArray(response?.content)
    ? response.content.filter((block) => block?.type === "text").map((block) => block.text || "").join("\n").trim()
    : String(response?.text || "").trim();
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Tiny local helper for server-side JSON parsing
export function safeParseJSON(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; } catch { return fallback; }
}
