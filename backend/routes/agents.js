// routes/agents.js — the /api/agents routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (apiLimiter, evidenceStmts, factStmts, orchestrationCatalog, ragStmts, requireStudentAuth).
import { screenInput } from "../content-moderation.js";
import { routeRequest } from "../policy-router.js";
import { assembleRAGContext } from "../rag-engine.js";
import { getEvidenceProfile } from "../evidence-graph.js";
import { searchFacts } from "../fact-store.js";
import { buildOrchestration } from "../orchestration-engine.js";
import { OPENROUTER_TARGETS } from "../openrouter-model-refresh.js";
import { calculateDeadlineStatus, runDocumentCompletenessCheck, runFAFSAEligibilityCheck } from "../rules-engine.js";
import { composeDeterministicAnswer } from "../answer-composer.js";
import { validateEvidenceSources } from "../source-registry.js";

export function registerAgentsRoutes(app, deps) {
  app.post("/api/agents/orchestrate", deps.apiLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const { query } = req.body;
      if (!query || typeof query !== "string") return res.status(400).json({ error: "query is required" });
      if (query.length > 4000) return res.status(400).json({ error: "query is too long" });

      // Step 1: Input screening
      const inputScreen = screenInput(query);
      if (inputScreen.blocked) {
        return res.status(400).json({ error: inputScreen.reason, blocked: true });
      }

      // Step 2: Policy routing
      const routing = routeRequest(query);

      // Step 3: Check if deterministic. routeRequest returns { classification,
      // gateResult, modelTier, isDeterministic, action } — read the real fields
      // (the prior code read nonexistent top-level routing.* and never fired).
      const cls = routing.classification;
      if (routing.isDeterministic) {
        let deterministicResult = null;

        if (cls.subIntent === "fafsa" || cls.subIntent === "eligibility") {
          deterministicResult = runFAFSAEligibilityCheck(req.body.studentData || {});
        } else if (cls.subIntent === "deadlines") {
          deterministicResult = calculateDeadlineStatus(req.body.deadlineDate);
        } else if (cls.subIntent === "documents" || cls.subIntent === "document_completeness") {
          deterministicResult = runDocumentCompletenessCheck(req.body.applicationType, req.body.submittedItems);
        }

        if (deterministicResult) {
          const answer = composeDeterministicAnswer({
            classification: cls,
            result: deterministicResult,
            locale: req.headers["accept-language"]?.startsWith("ko") ? "ko" : "en-US",
          });
          return res.json({
            ...answer,
            _meta: { deterministic: true, modelTier: "NONE", cost: "$0.00", topicType: cls.topicType },
          });
        }
      }

      // Step 4: Assemble RAG context (small-context)
      const context = assembleRAGContext(deps.ragStmts, req.studentId, routing.subIntent || "holistic");
      if (context.error) return res.status(404).json(context);

      // Step 5: Gather evidence + validate sources for regulated topics
      const evidence = getEvidenceProfile(deps.evidenceStmts, "student", req.studentId);
      const facts = searchFacts(deps.factStmts, query, 10);
      if (cls.topicType === "regulated" || cls.topicType === "high_stakes") {
        const sourceCheck = validateEvidenceSources([...facts, ...(evidence.items || [])], routing.topicType);
        if (!sourceCheck.allTrusted && sourceCheck.untrustedItems?.length > 0) {
          console.warn(`[ORCH] Untrusted sources filtered for ${routing.topicType}: ${sourceCheck.untrustedItems.length}`);
        }
      }

      // Step 6: Build orchestration from the screened query and retrieved evidence.
      const orchestration = buildOrchestration({
        query: inputScreen.redacted ? inputScreen.redactedText : query,
        studentContext: context.studentContext,
        factStmts: deps.factStmts,
        evidenceStmts: deps.evidenceStmts,
        catalog: deps.orchestrationCatalog,
        modelConfig: { ...OPENROUTER_TARGETS },
      });

      res.json({
        ...orchestration,
        evidence: evidence.items?.slice(0, 10) || [],
        verifiedFacts: facts.slice(0, 5),
        _meta: {
          topicType: cls.topicType,
          modelTier: routing.modelTier,
          gates: cls.gates,
          deterministic: false,
        },
      });

    } catch (err) {
      console.error("[ORCH] Error:", err.message);
      res.status(500).json({ error: "Agent orchestration failed" });
    }
  });
}
