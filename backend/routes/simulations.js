// routes/simulations.js — the /api/simulations routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (callSimulationSidecar, ragStmts, requireStudentAuth, snapshotToStudentProfile, studentLimiter).
import { getActiveNarrative } from "../activities/narrative-store.js";

export function registerSimulationsRoutes(app, deps) {
  app.post("/api/simulations", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const snap = deps.ragStmts.getLatestSnapshot.get(req.studentId);
      if (!snap) return res.status(404).json({ error: "No profile data" });
      const narrative = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
      const body = req.body || {};
      const result = await deps.callSimulationSidecar("/simulations", {
        method: "POST",
        body: {
          studentId: req.studentId,
          scenarioName: body.scenarioName || body.scenario?.name || null,
          scenario: body.scenario || {},
          profilePatch: body.profilePatch || body.patch || body.scenario?.profilePatch || {},
          baseProfile: deps.snapshotToStudentProfile(snap, narrative),
          targets: Array.isArray(body.targets) ? body.targets : [],
        },
      });
      res.status(201).json(result);
    } catch (err) {
      console.error("[SIMULATION] Create error:", err.message);
      res.status(err.status || 500).json({ error: err.message || "Simulation creation failed" });
    }
  });

  app.get("/api/simulations/:id", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const result = await deps.callSimulationSidecar(`/simulations/${encodeURIComponent(req.params.id)}?studentId=${encodeURIComponent(req.studentId)}`);
      res.json(result);
    } catch (err) {
      console.error("[SIMULATION] Get error:", err.message);
      res.status(err.status || 500).json({ error: err.message || "Simulation lookup failed" });
    }
  });

  app.delete("/api/simulations/:id", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const result = await deps.callSimulationSidecar(`/simulations/${encodeURIComponent(req.params.id)}?studentId=${encodeURIComponent(req.studentId)}`, {
        method: "DELETE",
      });
      res.json(result);
    } catch (err) {
      console.error("[SIMULATION] Delete error:", err.message);
      res.status(err.status || 500).json({ error: err.message || "Simulation deletion failed" });
    }
  });
}
