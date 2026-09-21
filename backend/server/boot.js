// server/boot.js — the last steps of boot: listening, with the banner that
// names the port, the environment and the databases. Moved out of server.js
// on 2026-09-21; called from the same place, so what runs when at boot is
// unchanged. `deps` is server.js's routeDeps object of live getters.

export function startListening(deps) {
  // ═══════════════════════════════════════════════════════════
  // START SERVER
  // ═══════════════════════════════════════════════════════════
  deps.app.listen(deps.PORT, deps.HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║  College Counselor Backend v2 (Rules-First Architecture)       ║
║  Port: ${String(deps.PORT).padEnd(54)}║
║  Env:  ${deps.NODE_ENV.padEnd(54)}║
║  Scorecard: ${(deps.SCORECARD_API_KEY ? "LIVE" : "OFFLINE (baseline only)").padEnd(49)}║
║  Retention: ${deps.RETENTION_MODE.padEnd(49)}║
║                                                                ║
║  Databases:                                                    ║
║    counselor.db  — operational (audit, baselines, snapshots)   ║
║    pii-vault.db  — encrypted PII (separate, AES-256-GCM)      ║
║    vectors.db    — embeddings (no student PII)                 ║
║                                                                ║
║  Architecture:                                                 ║
║    T0: Rules Engine (deterministic, $0)                        ║
║    T1: Small (routine coaching)                                ║
║    T2: Medium (synthesis and strategy)                         ║
║    T3: Large (complex review)                                  ║
║    Paid calls share a fixed grade-based monthly budget.        ║
║                                                                ║
║  New Modules:                                                  ║
║    policy-router, rules-engine, fact-store, evidence-graph,    ║
║    answer-composer, pii-vault, content-mod,                    ║
║    consent, domain-monitor, retention, batch-jobs, vector-store║
╚════════════════════════════════════════════════════════════════╝
  `);
  });
}
