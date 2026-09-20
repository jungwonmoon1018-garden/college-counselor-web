// routes/mcp.js — the /api/mcp routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (evidenceStmts, ragStmts, requireStudentAuth, studentLimiter).
import { assembleRAGContext } from "../storage/rag-engine.js";
import { getEvidenceProfile } from "../storage/evidence-graph.js";

export function registerMcpRoutes(app, deps) {
  app.post("/api/mcp/admissions/query", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { operation, college, unitId, query } = req.body;
      const context = assembleRAGContext(deps.ragStmts, req.studentId, "holistic");
      if (context.error) return res.status(404).json(context);

      // Use evidence graph for enriched context
      const evidence = getEvidenceProfile(deps.evidenceStmts, "student", req.studentId);

      res.json({
        operation,
        college,
        studentContext: context.studentContext,
        evidence: evidence.items?.slice(0, 10) || [],
        source: "evidence_graph + fact_store",
      });
    } catch (err) {
      console.error("[MCP] Admissions query error:", err.message);
      res.status(500).json({ error: "Admissions MCP query failed" });
    }
  });
}
