import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  initFactStore,
  prepareFactStatements,
  insertFact,
  searchFacts,
  seedCollegeFacts,
  lookupFact,
  lookupFactsForEntity,
  lookupFactsForTopic,
  expireOldFacts,
} from "../scouts/fact-store.js";

function store() {
  const db = new Database(":memory:");
  initFactStore(db);
  return { db, stmts: prepareFactStatements(db) };
}

describe("fact store semantic identity", () => {
  it("upserts one semantic fact instead of adding startup duplicates", () => {
    const { db, stmts } = store();
    const profiles = [{
      unitId: "100",
      name: "Example University",
      acceptance: 20,
      sat25: 1200,
      dataYear: 2024,
    }];
    seedCollegeFacts(stmts, profiles, db);
    seedCollegeFacts(stmts, profiles, db);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM canonical_facts").get().count, 2);
    const row = db.prepare("SELECT * FROM canonical_facts WHERE fact_key = 'acceptance_rate'").get();
    assert.equal(row.confidence, "extracted");
    assert.equal(row.provenance_type, "bundled_baseline");
    assert.equal(row.source_domain, "bundled-baseline.local");
    assert.equal(row.extracted_at, "2024-12-31T00:00:00.000Z");
    db.close();
  });

  it("updates changed values under the same semantic key", () => {
    const { db, stmts } = store();
    const base = {
      topic_type: "deadlines",
      entity_type: "university",
      entity_id: "mit",
      fact_key: "early_action_deadline",
      source_domain: "mitadmissions.org",
      source_url: "https://mitadmissions.org/apply/",
      confidence: "verified",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    insertFact(stmts, { ...base, fact_value: "November 1" });
    insertFact(stmts, { ...base, fact_value: "November 2" });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM canonical_facts").get().count, 1);
    assert.equal(db.prepare("SELECT fact_value FROM canonical_facts").get().fact_value, "November 2");
    db.close();
  });
});

describe("fact search", () => {
  it("tokenizes natural questions and treats SQL wildcard input as data", () => {
    const { db, stmts } = store();
    insertFact(stmts, {
      topic_type: "deadlines",
      entity_type: "university",
      entity_id: "mit",
      entity_name: "Massachusetts Institute of Technology",
      fact_key: "early_action_deadline",
      fact_value: "The early action deadline is November 1.",
      source_domain: "mitadmissions.org",
      source_url: "https://mitadmissions.org/apply/",
      confidence: "verified",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(searchFacts(stmts, "When is the MIT early action deadline?", 10).length, 1);
    assert.deepEqual(searchFacts(stmts, "%_%%", 10), []);
    db.close();
  });

  // ISO expiries ("…T…Z") used to be compared with datetime('now') as
  // text; "T" sorts after " ", so a fact stayed current for the whole UTC
  // day it expired on.
  it("compares ISO expiries as time, both ways, on the day they expire", () => {
    const { db, stmts } = store();
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const inAnHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const fact = (key, expires_at) => ({
      topic_type: "school_policies",
      entity_type: "university",
      entity_id: "100",
      entity_name: "Example University",
      fact_key: key,
      fact_value: `${key} value`,
      source_domain: "example.edu",
      confidence: "verified",
      expires_at,
    });
    insertFact(stmts, fact("deadline_regular_decision", hourAgo));
    insertFact(stmts, fact("test_policy", inAnHour));
    insertFact(stmts, fact("application_fee", "not a date"));
    const keys = (rows) => rows.map((row) => row.fact_key).sort();
    assert.deepEqual(keys(lookupFactsForTopic(stmts, "school_policies")), ["test_policy"]);
    assert.deepEqual(keys(lookupFactsForEntity(stmts, "university", "100")), ["test_policy"]);
    assert.deepEqual(keys(searchFacts(stmts, "Example University", 10)), ["test_policy"]);
    assert.equal(lookupFact(stmts, "100", "deadline_regular_decision"), null);
    assert.deepEqual(keys(stmts.getVerifiedFacts.all()), ["test_policy"]);
    // The expiry job marks the passed one (and the unreadable one), not the current one.
    assert.deepEqual(expireOldFacts(stmts), { expired: 2 });
    const confidence = Object.fromEntries(db.prepare("SELECT fact_key, confidence FROM canonical_facts").all().map((r) => [r.fact_key, r.confidence]));
    assert.deepEqual(confidence, { deadline_regular_decision: "expired", test_policy: "verified", application_fee: "expired" });
    // Expiring within the week counts the one an hour out.
    assert.deepEqual(stmts.getExpiringSoon.all().map((row) => row.fact_key), ["test_policy"]);
    db.close();
  });

  it("does not retrieve expired facts", () => {
    const { db, stmts } = store();
    insertFact(stmts, {
      topic_type: "fafsa",
      fact_key: "fafsa_eligibility",
      fact_value: "Old eligibility rule",
      source_domain: "studentaid.gov",
      confidence: "verified",
      expires_at: "2000-01-01T00:00:00.000Z",
    });
    assert.deepEqual(searchFacts(stmts, "FAFSA eligibility", 10), []);
    db.close();
  });
});
