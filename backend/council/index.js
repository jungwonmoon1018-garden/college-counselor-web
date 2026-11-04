// Explicit sequential Strategy Council:
// Strategist -> Data Checker -> Skeptic -> Devil's Advocate -> Moderator.

import { Councilor } from "./councilor.js";
import * as strategistRole from "./roles/strategist.js";
import * as dataCheckerRole from "./roles/data-checker.js";
import * as skepticRole from "./roles/skeptic.js";
import * as devilsAdvocateRole from "./roles/devils-advocate.js";
import { moderate } from "./moderator.js";
import { buildCouncilContext } from "./context-builder.js";
import { recordConvening } from "./audit-trail.js";
import { DECISION_TYPES, subIntentToDecisionType } from "./triggers.js";

export const COUNCIL_STAGE_ORDER = Object.freeze([
  "Strategist",
  "Data Checker",
  "Skeptic",
  "Devil's Advocate",
  "Moderator",
]);

function buildCouncilors(callModel) {
  return [
    new Councilor({
      role: strategistRole.ROLE,
      getSystemPrompt: strategistRole.getSystemPrompt,
      tier: strategistRole.TIER,
      callModel,
    }),
    new Councilor({
      role: dataCheckerRole.ROLE,
      getSystemPrompt: dataCheckerRole.getSystemPrompt,
      tier: dataCheckerRole.TIER,
      callModel,
    }),
    new Councilor({
      role: skepticRole.ROLE,
      getSystemPrompt: skepticRole.getSystemPrompt,
      tier: skepticRole.TIER,
      callModel,
    }),
    new Councilor({
      role: devilsAdvocateRole.ROLE,
      getSystemPrompt: devilsAdvocateRole.getSystemPrompt,
      tier: devilsAdvocateRole.TIER,
      callModel,
    }),
  ];
}

// The Strategist's provider failure as the error the route maps to a status:
// it keeps the adapter's status and code (a 401 becomes 502
// provider_auth_failed, a stall 504 provider_timeout in
// shared/model-errors.js) and names the Council's own reason.
export function councilProviderError(output) {
  const failure = output?.provider_error || {};
  const error = new Error("The AI provider could not answer for the Strategy Council: " + (failure.message || "provider error"));
  error.status = Number.isInteger(failure.status) ? failure.status : 502;
  error.code = failure.code || "http_error";
  error.provider = "openrouter";
  error.councilCode = "COUNCIL_PROVIDER_UNAVAILABLE";
  error.stage = output?.role || null;
  return error;
}

// A stage the run stops at is reconciled before the error goes up. A
// failure to reconcile is logged and does not replace the error the route
// maps to a status; the route then releases the stage as before.
async function reconcileStoppedStage(afterStage, stage) {
  if (!afterStage) return;
  try {
    await afterStage(stage);
  } catch (err) {
    console.warn("[COUNCIL] reconciling the stopped stage failed:", err?.message);
  }
}

function normalizeContext(value) {
  if (!value) return null;
  if (typeof value === "string") return { text: value, evidenceIndex: {}, immutable: true };
  return {
    text: String(value.text || ""),
    evidenceIndex: value.evidenceIndex || {},
    immutable: true,
  };
}

export async function convene(opts = {}) {
  const {
    studentId,
    dataDir,
    question,
    student,
    councilStmts,
    factStmts,
    signal,
    callModel,
    beforeStage,
    afterStage,
  } = opts;
  const llm = opts.llm || opts.byok;
  if (opts.explicit !== true) {
    const error = new Error("Strategy Council requires an explicit, cost-disclosed student action.");
    error.code = "COUNCIL_EXPLICIT_ACTION_REQUIRED";
    throw error;
  }
  if (!studentId) throw new Error("convene() requires studentId");
  if (!question) throw new Error("convene() requires question");
  if (!councilStmts) throw new Error("convene() requires councilStmts");
  if (!llm?.apiKey) throw new Error("convene() requires the administrator's OpenRouter key");

  const decisionType = opts.decisionType ||
    subIntentToDecisionType(opts.subIntent) ||
    DECISION_TYPES.OTHER;
  const context = normalizeContext(opts.contextOverride) || await buildCouncilContext({
    studentId,
    dataDir,
    question,
    student,
    factStmts,
    evidenceStmts: opts.evidenceStmts,
  });
  const outputs = [];

  for (const [index, seat] of buildCouncilors(callModel).entries()) {
    if (signal?.aborted) throw signal.reason || new Error("Council request aborted");
    const stageInfo = {
      index,
      role: seat.role,
      tier: seat.tier,
      priorOutputs: outputs,
      contextChars: context.text.length,
    };
    const approval = beforeStage ? await beforeStage(stageInfo) : { allowed: true };
    if (approval?.allowed === false) {
      const error = new Error(approval.reason || "Council stage budget was denied.");
      error.code = approval.code || "COUNCIL_BUDGET_DENIED";
      error.stage = seat.role;
      throw error;
    }
    let output;
    try {
      output = await seat.deliberate({
        question,
        decisionType,
        student,
        context,
        priorOutputs: outputs,
        llm,
        signal,
      });
    } catch (error) {
      // The student closed the request on a retry after a try that was
      // billed: the stage is reconciled at that usage, not released.
      if (error?.billedUsage) {
        await reconcileStoppedStage(afterStage, { ...stageInfo, output: { role: seat.role, usage: error.billedUsage, abstained: true, abstain_reason: "aborted" }, approval });
      }
      throw error;
    }
    // Without the Strategist there is no recommendation to review, and when
    // it abstained because the provider failed, the other seats would only
    // wait on the same outage (up to 105 s each) before the moderator
    // answered "could not produce a primary recommendation from the
    // available context" with Confidence 0% and a 0 USD cost, which reads as
    // the student's profile being too thin. The run stops with the
    // provider's error instead; the route answers it with a coded status and
    // releases every stage it has not reconciled. This one is reconciled
    // first: a try before the failure may have been billed (an unparseable
    // reply, then a 401 or a 5xx on the retry), and releasing it counted a
    // paid call as 0 USD against the student's cap (backend-3). With no
    // billed try its usage is null, which records 0 USD as a release would.
    if (index === 0 && output?.abstained && output.abstain_reason === "provider") {
      await reconcileStoppedStage(afterStage, { ...stageInfo, output, approval });
      throw councilProviderError(output);
    }
    outputs.push(output);
    if (afterStage) await afterStage({ ...stageInfo, output, approval });
  }

  const envelope = moderate(outputs);
  const totalTokens = outputs.reduce((totals, output) => {
    const usage = output.usage || {};
    totals.input += Number(usage.input_tokens) || 0;
    totals.output += Number(usage.output_tokens) || 0;
    return totals;
  }, { input: 0, output: 0 });
  const conveningId = await recordConvening({
    stmts: councilStmts,
    studentId,
    decisionType,
    question,
    envelope,
    totalTokens,
    triggerSource: opts.triggerSource || "manual",
  });

  return {
    convening_id: conveningId,
    recommendation: envelope.recommendation,
    confidence: envelope.confidence,
    dissent: envelope.dissent,
    dissents: envelope.dissents,
    citations: envelope.citations,
    council_breakdown: envelope.council_breakdown,
    moderator_rule: envelope.moderator_rule,
    decision_type: decisionType,
    total_tokens: totalTokens,
    stage_order: COUNCIL_STAGE_ORDER,
    sequential: true,
  };
}

export { DECISION_TYPES } from "./triggers.js";
export { initCouncilTables, prepareCouncilStatements } from "./audit-trail.js";
