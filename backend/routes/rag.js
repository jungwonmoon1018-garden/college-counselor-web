// routes/rag.js — the /api/rag routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (ragStmts, requireStudentAuth, studentLimiter).
import { assembleRAGContext, enhancedCollegeMatch } from "../rag-engine.js";

export function registerRagRoutes(app, deps) {
  app.post("/api/rag/context", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { queryFocus } = req.body;
      const context = assembleRAGContext(deps.ragStmts, req.studentId, queryFocus || "holistic");
      if (context.error) return res.status(404).json(context);
      res.json(context);
    } catch (err) {
      console.error("[RAG] Context assembly error:", err.message);
      res.status(500).json({ error: "RAG context assembly failed" });
    }
  });

  app.post("/api/rag/college-match", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const filters = req.body;
      const result = enhancedCollegeMatch(deps.ragStmts, req.studentId, filters);
      if (result.error) return res.status(404).json(result);
      res.json(result);
    } catch (err) {
      console.error("[RAG] College match error:", err.message);
      res.status(500).json({ error: "College match failed" });
    }
  });
}
