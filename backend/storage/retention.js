// ═══════════════════════════════════════════════════════════════════════
// RETENTION — Automated data lifecycle management
// ═══════════════════════════════════════════════════════════════════════
// Enforces retention policies:
//   - Document vault (pii-vault.js storeDocument): 72 hours
//   - Activity evidence files (ec_attachments, direct and chat uploads):
//     kept until the student removes one (DELETE /api/ec/attachments/:id)
//     or deletes the account. The 72-hour line above used to read as if it
//     covered uploads, but nothing stores an upload in the document vault.
//   - Conversation logs: 30 days (consumer), per-institution (school), and
//     the thread memory built from them goes with them
//   - Audit logs: 90 days (consumer), 5+ years (institutional)
//   - Canonical facts: until superseded + 90 days
//   - Vector embeddings: updated on diff, no raw backing
//   - Profile data: until deletion requested
// ═══════════════════════════════════════════════════════════════════════

// ─── Default retention policies ───
export const RETENTION_POLICIES = {
  consumer: {
    documents: { hours: 72, label: "72 hours" },
    uploaded_evidence: { days: null, label: "Until the student removes it or deletes the account" },
    conversation_logs: { days: 30, label: "30 days" },
    audit_events: { days: 90, label: "90 days" },
    notifications: { days: 90, label: "90 days" },
    stale_facts: { days: 90, label: "90 days after superseded" },
    expired_evidence: { days: 90, label: "90 days after expiry" },
    profile_data: { days: null, label: "Until deletion requested" },
  },
  institutional: {
    documents: { hours: 72, label: "72 hours" },
    uploaded_evidence: { days: null, label: "Until the student removes it or deletes the account" },
    conversation_logs: { days: null, label: "Per institutional agreement" },
    audit_events: { years: 7, label: "7 years (FERPA minimum)" },
    notifications: { years: 7, label: "7 years" },
    stale_facts: { days: 180, label: "180 days after superseded" },
    expired_evidence: { days: 180, label: "180 days after expiry" },
    profile_data: { days: null, label: "Per institutional agreement" },
  },
};

// ─── Run retention cleanup ───
export function runRetentionCleanup(db, piiVaultDb, mode = "consumer") {
  const policy = RETENTION_POLICIES[mode] || RETENTION_POLICIES.consumer;
  const results = {};

  // 1. Clean expired documents from PII vault
  if (piiVaultDb) {
    try {
      const docResult = piiVaultDb.prepare(
        `DELETE FROM document_vault WHERE auto_delete = 1 AND julianday(retention_expires_at) < julianday('now')`
      ).run();
      results.documents = { deleted: docResult.changes };
    } catch (e) {
      results.documents = { error: e.message };
    }
  }

  // 2. Clean old audit events
  if (policy.audit_events.days) {
    try {
      const auditResult = db.prepare(
        `DELETE FROM audit_events WHERE timestamp < datetime('now', '-${policy.audit_events.days} days')`
      ).run();
      results.audit_events = { deleted: auditResult.changes };
    } catch (e) {
      results.audit_events = { error: e.message };
    }
  } else if (policy.audit_events.years) {
    try {
      const days = policy.audit_events.years * 365;
      const auditResult = db.prepare(
        `DELETE FROM audit_events WHERE timestamp < datetime('now', '-${days} days')`
      ).run();
      results.audit_events = { deleted: auditResult.changes };
    } catch (e) {
      results.audit_events = { error: e.message };
    }
  }

  // 3. Clean old notifications
  if (policy.notifications.days) {
    try {
      const notifResult = db.prepare(
        `DELETE FROM notification_queue WHERE created_at < datetime('now', '-${policy.notifications.days} days')`
      ).run();
      results.notifications = { deleted: notifResult.changes };
    } catch (e) {
      results.notifications = { error: e.message };
    }
  }

  // 4. Clean stale/expired facts
  if (policy.stale_facts.days) {
    try {
      const staleResult = db.prepare(
        `DELETE FROM canonical_facts WHERE confidence IN ('stale', 'expired') AND updated_at < datetime('now', '-${policy.stale_facts.days} days')`
      ).run();
      results.stale_facts = { deleted: staleResult.changes };
    } catch (e) {
      results.stale_facts = { error: e.message };
    }
  }

  // 5. Clean expired evidence
  if (policy.expired_evidence.days) {
    try {
      const evidenceResult = db.prepare(
        `DELETE FROM evidence_items WHERE trust_level = 'expired' AND updated_at < datetime('now', '-${policy.expired_evidence.days} days')`
      ).run();
      results.expired_evidence = { deleted: evidenceResult.changes };
    } catch (e) {
      results.expired_evidence = { error: e.message };
    }
  }


  // 7. Clean old conversation logs (chat history). chat_messages.content is
  //    plaintext student-typed text, so honor the declared conversation_logs
  //    retention. Skip when days is null (institutional mode keeps per agreement).
  //    The thread memory (chat_graph_facts and their edges, an excerpt of each
  //    question and answer) goes with the messages it was built from. It used
  //    to stay forever: the counselor kept recalling "deleted" conversations
  //    as THREAD MEMORY, and once the thread itself aged out nothing could
  //    remove them short of deleting the account. A fact whose user message
  //    no longer exists is removed, which also clears the facts earlier runs
  //    left behind. The sidebar's message counts are recomputed, since they
  //    were only ever incremented and kept claiming the purged turns.
  if (policy.conversation_logs?.days) {
    try {
      const d = policy.conversation_logs.days;
      const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
      const tx = db.transaction(() => {
        const msgResult = db.prepare(
          `DELETE FROM chat_messages WHERE created_at < datetime('now', '-${d} days')`
        ).run();
        // Drop now-orphaned / stale threads (no remaining messages and inactive past the window).
        const threadResult = db.prepare(
          `DELETE FROM chat_threads WHERE updated_at < datetime('now', '-${d} days') AND id NOT IN (SELECT DISTINCT thread_id FROM chat_messages)`
        ).run();
        let factsDeleted = 0;
        let edgesDeleted = 0;
        if (hasTable("chat_graph_facts")) {
          const orphanFacts = `SELECT id FROM chat_graph_facts
            WHERE message_id NOT IN (SELECT id FROM chat_messages)
               OR thread_id NOT IN (SELECT id FROM chat_threads)`;
          if (hasTable("chat_graph_edges")) {
            edgesDeleted = db.prepare(`DELETE FROM chat_graph_edges WHERE fact_id IN (${orphanFacts})`).run().changes;
          }
          factsDeleted = db.prepare(`DELETE FROM chat_graph_facts WHERE id IN (${orphanFacts})`).run().changes;
        }
        const recounted = db.prepare(
          `UPDATE chat_threads SET message_count = (SELECT COUNT(*) FROM chat_messages WHERE thread_id = chat_threads.id)
           WHERE message_count IS NOT (SELECT COUNT(*) FROM chat_messages WHERE thread_id = chat_threads.id)`
        ).run().changes;
        return { messagesDeleted: msgResult.changes, threadsDeleted: threadResult.changes, factsDeleted, edgesDeleted, threadsRecounted: recounted };
      });
      results.conversation_logs = tx();
    } catch (e) {
      results.conversation_logs = { error: e.message };
    }
  }

  return {
    mode,
    results,
    completedAt: new Date().toISOString(),
  };
}

// ─── Get retention status/report ───
export function getRetentionReport(db, piiVaultDb, mode = "consumer") {
  const report = { mode, policy: RETENTION_POLICIES[mode] };

  try {
    report.audit_events = db.prepare("SELECT COUNT(*) as count, MIN(timestamp) as oldest FROM audit_events").get();
  } catch { report.audit_events = null; }

  try {
    report.canonical_facts = db.prepare(
      "SELECT confidence, COUNT(*) as count FROM canonical_facts GROUP BY confidence"
    ).all();
  } catch { report.canonical_facts = null; }

  try {
    report.evidence_items = db.prepare(
      "SELECT trust_level, COUNT(*) as count FROM evidence_items GROUP BY trust_level"
    ).all();
  } catch { report.evidence_items = null; }

  if (piiVaultDb) {
    try {
      report.documents = piiVaultDb.prepare(
        "SELECT COUNT(*) as count, MIN(created_at) as oldest FROM document_vault"
      ).get();
    } catch { report.documents = null; }
  }

  return report;
}
