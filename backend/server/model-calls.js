// server/model-calls.js — everything around one model call made for a
// student: the budget reservation and its reconcile/release, the operator key,
// the per-student callLLM, JSON parsing of a reply and the error response. Moved out of server.js on 2026-09-20.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (MAX_TOKENS_LIMIT, OPERATOR_LLM,
// SIM_INTERNAL_TOKEN, SIM_URL, authStore, db, ragStmts).
import { safeJSON } from "../server/auth.js";
import { reconcileBudget, releaseBudget, reserveBudget } from "../usage-budget.js";
import crypto from "node:crypto";
import { OPENROUTER_TARGETS } from "../openrouter-model-refresh.js";
import { callLLM as adapterCallLLM } from "../llm-adapters/index.js";

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
    maxOutputTokens: Math.max(1, Math.min(Number(maxTokens) || 1024, deps.MAX_TOKENS_LIMIT)),
  });
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

export function buildStudentCallLLM(studentId, { requestIdPrefix = null } = {}) {
  const operator = currentOperatorKeyConfig();
  if (!operator) return { modelConfig: null, callLLM: null };
  let callIndex = 0;
  const callLLM = async (args = {}) => {
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

// Map a fixed-OpenRouter adapter error to an informative HTTP response instead
// of an opaque 500. Secret remediation belongs to the local administrator;
// students never manage provider keys or model selection.
export function respondLLMError(res, err, label) {
  const up = Number.isInteger(err?.status) ? err.status : null;
  const httpStatus = up === 499 ? 504 : (up && up >= 400 && up < 600 ? up : 502);
  console.error(`[${label}] LLM error${up ? ` (upstream ${up})` : ""}:`, err?.message);
  let friendly;
  if (err?.code === "provider_timeout") friendly = "The AI provider took too long to respond, so the request was stopped. Please try again.";
  else if (up === 429) friendly = "The AI service is rate-limiting requests (HTTP 429). Wait a moment and retry.";
  else if (up === 401 || up === 403) friendly = "The configured OpenRouter credential was rejected. Ask the local administrator to verify it.";
  else if (up === 402) friendly = "The AI service reports insufficient provider credit or quota. Ask the local administrator to review the OpenRouter account.";
  else friendly = "The AI request failed. Please try again; if it persists, ask the local administrator to check OpenRouter.";
  return res.status(httpStatus).json({
    error: friendly,
    detail: err?.message || null,
    code: err?.code || "llm_error",
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
