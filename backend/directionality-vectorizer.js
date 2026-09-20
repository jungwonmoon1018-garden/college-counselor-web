// directionality-vectorizer.js — the academic directionality read: its table,
// its prepared statements, the five-factor vector and the per-student
// recompute. Moved out of ec-vectorizer.js on 2026-09-20, which re-exports
// them so its importers are unchanged.
import { courseLevel } from "./course-rigor.js";
import { matchMajorBucket, normalizeText, clamp01, round2, safeArray } from "./vector-utils.js";

// Student directionality vectorization
// Represents overall student trajectory across academics, interests, and tests.
// Five independent factors (not merged into a single score per Korea AI Act):
//   1. academic_momentum: GPA trend + position
//   2. test_score_strength: SAT/ACT vs T20 percentile
//   3. major_academic_fit: AP/GPA alignment with intended major
//   4. rigor_and_challenge: AP load vs GPA ratio
//   5. overall_academic_standing: composite readiness
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??
export function initDirectionalityTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS student_directionality (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,

      -- Five independent directionality factors (0.0-1.0 each)
      academic_momentum REAL DEFAULT 0,
      test_score_strength REAL DEFAULT 0,
      major_academic_fit REAL DEFAULT 0,
      rigor_and_challenge REAL DEFAULT 0,
      overall_academic_standing REAL DEFAULT 0,

      -- Composite label (coarse, non-ranking)
      directionality_label TEXT,

      -- Supporting metrics (for explanation)
      gpa_unweighted REAL,
      gpa_percentile_t20 REAL,
      ap_count INTEGER,
      sat_total INTEGER,
      sat_percentile_t20 REAL,
      act_total INTEGER,
      act_percentile_t20 REAL,
      major_interest TEXT,

      -- Override support
      is_overridden INTEGER DEFAULT 0,
      override_json TEXT,

      -- Reasoning and metadata
      reasoning_json TEXT,

      computed_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_student_directionality_student
      ON student_directionality(student_id, computed_at DESC);
  `);
}

export function prepareDirectionalityStatements(db) {
  return {
    upsertDirectionality: db.prepare(`
      INSERT INTO student_directionality
        (id, student_id,
         academic_momentum, test_score_strength, major_academic_fit,
         rigor_and_challenge, overall_academic_standing,
         directionality_label,
         gpa_unweighted, gpa_percentile_t20, ap_count,
         sat_total, sat_percentile_t20, act_total, act_percentile_t20,
         major_interest,
         reasoning_json, is_overridden, override_json,
         computed_at, updated_at)
      VALUES (?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?, ?, ?,?,?, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        academic_momentum = excluded.academic_momentum,
        test_score_strength = excluded.test_score_strength,
        major_academic_fit = excluded.major_academic_fit,
        rigor_and_challenge = excluded.rigor_and_challenge,
        overall_academic_standing = excluded.overall_academic_standing,
        directionality_label = excluded.directionality_label,
        gpa_percentile_t20 = excluded.gpa_percentile_t20,
        reasoning_json = excluded.reasoning_json,
        updated_at = datetime('now')
    `),
    getByStudent: db.prepare(`
      SELECT * FROM student_directionality
      WHERE student_id = ?
      ORDER BY computed_at DESC LIMIT 1
    `),
    getByStudentHistory: db.prepare(`
      SELECT * FROM student_directionality
      WHERE student_id = ?
      ORDER BY computed_at DESC LIMIT 10
    `),
    deleteByStudent: db.prepare(`
      DELETE FROM student_directionality WHERE student_id = ?
    `),
    applyOverride: db.prepare(`
      UPDATE student_directionality
      SET academic_momentum = COALESCE(?, academic_momentum),
          test_score_strength = COALESCE(?, test_score_strength),
          major_academic_fit = COALESCE(?, major_academic_fit),
          rigor_and_challenge = COALESCE(?, rigor_and_challenge),
          overall_academic_standing = COALESCE(?, overall_academic_standing),
          is_overridden = 1,
          override_json = ?,
          updated_at = datetime('now')
      WHERE student_id = ?
    `)
  };
}

/**
 * Compute overall student directionality across academics, test scores, and major fit.
 * Returns five independent factors (not merged into a single score).
 *
 * @param {object} params
 * @param {object} params.academics - { gpaUnweighted, apCourses, courses }
 * @param {Array} params.testScores - [{ test: "sat"|"act", totalScore }]
 * @param {string} params.majorInterest - intended major
 * @param {object} params.priorSnapshot - previous profile snapshot (for trend detection)
 * @param {object} params.gpaBaselines - baseline GPA percentile data
 * @param {object} params.satBaselines - baseline SAT percentile data
 * @param {object} params.actBaselines - baseline ACT percentile data
 * @param {Array} params.collegeProfiles - baseline college profiles
 * @returns {{ factors, label, metrics, reasoning }}
 */
export function vectorizeDirectionality({
  academics = {},
  testScores = [],
  majorInterest = null,
  priorSnapshot = null,
  gpaBaselines = [],
  satBaselines = [],
  actBaselines = [],
  collegeProfiles = [],
} = {}) {
  const reasoning = [];
  const factors = {};
  const metrics = {};

  // Extract current data
  const gpaUw = Number(academics.gpaUnweighted ?? academics.gpa?.unweighted ?? 0);
  const apCourses = Array.isArray(academics.apCourses)
    ? academics.apCourses
    : (academics.courses || []).filter((c) => courseLevel(c) === "ap");

  // ??? Factor 1: Academic Momentum (GPA trend + position) ???
  // Momentum = GPA position + trend adjustment. Trend adjustment applies
  // regardless of whether baseline tables are available ??a decline of
  // several tenths of a point is a real signal even in the absence of
  // percentile data.
  let momentum = 0.5; // neutral default
  let trendDirection = null; // "improving" | "flat" | "declining" | null
  if (gpaUw > 0) {
    const t20Baseline = gpaBaselines.find(b => b.scope === "t20_admitted");
    const normalizedGPA = Math.min(gpaUw / 4.0, 1.0);
    // When a baseline is available, reserve headroom so that improving
    // students have a way to climb; otherwise use the raw normalized GPA.
    momentum = t20Baseline ? normalizedGPA * 0.7 : normalizedGPA;

    // Trend: apply in both branches, scaling the adjustment with the size
    // of the GPA delta so dramatic swings get proportionally weighted.
    if (priorSnapshot) {
      const priorGPA = Number(priorSnapshot.gpa_unweighted ?? 0);
      if (priorGPA > 0) {
        const gpaDelta = gpaUw - priorGPA;
        if (gpaDelta > 0.1) {
          trendDirection = "improving";
          momentum += Math.min(0.3, 0.5 * gpaDelta + 0.1);
        } else if (gpaDelta < -0.1) {
          trendDirection = "declining";
          momentum -= Math.min(0.5, 0.5 * Math.abs(gpaDelta) + 0.2);
        } else {
          trendDirection = "flat";
        }
      }
    }
  }
  factors.academic_momentum = round2(clamp01(momentum));
  reasoning.push(`Academic momentum: ${factors.academic_momentum} (GPA ${gpaUw.toFixed(2)}${priorSnapshot ? `, trend: ${trendDirection || 'unknown'}` : ''})`);

  // ??? Factor 2: Test Score Strength (SAT/ACT vs T20) ???
  let testStrength = 0.5; // neutral if no test yet
  let satPercentile = null;
  let actPercentile = null;
  let satScore = null;
  let actScore = null;

  const satEntry = testScores.find(t => t.test === "sat");
  if (satEntry) {
    satScore = satEntry.totalScore;
    // Simple percentile: SAT ranges 400-1600; T20 is roughly 1450-1570
    // Map 1450+ to 90th percentile, 1200 to 50th, 800 to 0th
    if (satScore >= 1450) satPercentile = 0.9;
    else if (satScore >= 1350) satPercentile = 0.75;
    else if (satScore >= 1200) satPercentile = 0.5;
    else if (satScore >= 1000) satPercentile = 0.25;
    else satPercentile = 0.0;
    testStrength = satPercentile;
  }

  const actEntry = testScores.find(t => t.test === "act");
  if (actEntry) {
    actScore = actEntry.totalScore;
    // ACT ranges 1-36; T20 is roughly 33-35
    if (actScore >= 33) actPercentile = 0.9;
    else if (actScore >= 31) actPercentile = 0.75;
    else if (actScore >= 28) actPercentile = 0.5;
    else if (actScore >= 24) actPercentile = 0.25;
    else actPercentile = 0.0;
    if (testStrength === 0.5) testStrength = actPercentile;
  }

  factors.test_score_strength = round2(clamp01(testStrength));
  metrics.satTotal = satScore;
  metrics.satPercentileT20 = satPercentile;
  metrics.actTotal = actScore;
  metrics.actPercentileT20 = actPercentile;
  reasoning.push(`Test score strength: ${factors.test_score_strength}${satScore ? ` (SAT ${satScore})` : ''}${actScore ? ` (ACT ${actScore})` : ''}${!satScore && !actScore ? ' (no tests yet)' : ''}`);

  // ??? Factor 3: Major-Academic Fit (AP/GPA alignment with major) ???
  let majorFit = 0.5; // neutral default
  if (majorInterest) {
    const majorBucket = matchMajorBucket(majorInterest);
    const majorExpectedAPs = {
      computer_science: ["Calculus BC", "Computer Science A", "Physics"],
      engineering: ["Calculus BC", "Physics", "Chemistry"],
      biology: ["Biology", "Chemistry", "AP Lab", "Physics"],
      chemistry: ["Chemistry", "Calculus BC", "Physics"],
      physics: ["Physics C", "Calculus BC", "Physics B"],
      mathematics: ["Calculus BC", "Calculus AB"],
      economics: ["Micro/Macro", "Calculus"],
      business: ["Micro/Macro", "Statistics"],
    };

    const expected = majorExpectedAPs[majorBucket] || [];
    let apOverlap = 0;
    if (expected.length > 0) {
      apOverlap = apCourses.filter((ac) =>
        expected.some((e) => (ac.name || "").toLowerCase().includes(e.toLowerCase()))
      ).length;
    }

    // AP alignment: what % of expected do they have?
    const apAlignment = expected.length > 0 ? clamp01(apOverlap / expected.length) : 0.5;

    // GPA alignment: match GPA vs colleges that offer this major
    let gpaAlignment = 0.5;
    const collegesWithMajor = collegeProfiles.filter((c) => {
      const topMajors = safeArray(c.top_majors_json || c.topMajors || []);
      return topMajors.some((m) => normalizeText(m).includes(normalizeText(majorInterest)));
    });
    if (collegesWithMajor.length > 0) {
      const avgAdmitted = collegesWithMajor.reduce((sum, c) => sum + (Number(c.avg_gpa_admitted) || 0), 0) / collegesWithMajor.length;
      if (avgAdmitted > 0) {
        gpaAlignment = clamp01(0.5 + (gpaUw - avgAdmitted) / 0.5);
      }
    }

    majorFit = (apAlignment + gpaAlignment) / 2;
  }
  factors.major_academic_fit = round2(clamp01(majorFit));
  metrics.majorInterest = majorInterest;
  reasoning.push(`Major-academic fit: ${factors.major_academic_fit}${majorInterest ? ` (${majorInterest})` : ''}`);

  // ??? Factor 4: Rigor and Challenge (AP load vs GPA) ???
  let rigor = 0.2; // default for 0 APs
  const apCount = apCourses.length;
  if (apCount >= 6 && gpaUw >= 3.7) rigor = 1.0; // managing lots of rigor well
  else if (apCount >= 4 && gpaUw >= 3.5) rigor = 0.8;
  else if (apCount >= 3 && gpaUw >= 3.3) rigor = 0.6;
  else if (apCount >= 1 && gpaUw >= 3.0) rigor = 0.4;
  else if (apCount === 0) rigor = 0.2;
  else rigor = 0.5; // mixed signals

  // Penalize if GPA is too low for AP load
  if (apCount > 0 && gpaUw < 3.0) rigor *= 0.7;

  factors.rigor_and_challenge = round2(clamp01(rigor));
  metrics.apCount = apCount;
  reasoning.push(`Rigor & challenge: ${factors.rigor_and_challenge} (${apCount} APs, GPA ${gpaUw.toFixed(2)})`);

  // ??? Factor 5: Overall Academic Standing (composite) ???
  // Weighted composite of GPA, AP count, and test score
  const gpaComponent = clamp01(gpaUw / 4.0); // 0-1 normalized GPA
  const apComponent = clamp01(apCount / 8); // 8 APs is typical for T20
  const testComponent = testStrength; // already 0-1 from Factor 2
  const standing = (gpaComponent * 0.4) + (apComponent * 0.3) + (testComponent * 0.3);

  factors.overall_academic_standing = round2(clamp01(standing));
  reasoning.push(`Overall academic standing: ${factors.overall_academic_standing}`);

  // Directionality label (coarse, categorical)
  // Priority, per the implementation plan:
  //   declining    negative GPA trend OR momentum < 0.4
  //   early_stage  no APs yet (insufficient rigor evidence, even if the
  //                  student already has a test score)
  //   strong_upward high momentum + standing AND trend is not flat
  //   stable_strong high momentum + standing, flat/unknown trend
  //   stable_developing otherwise
  let label;
  if (trendDirection === "declining" || factors.academic_momentum < 0.4) {
    label = "declining";
  } else if (apCount === 0) {
    label = "early_stage";
  } else if (
    factors.academic_momentum >= 0.7 &&
    factors.overall_academic_standing >= 0.7 &&
    trendDirection !== "flat"
  ) {
    label = "strong_upward";
  } else if (
    factors.academic_momentum >= 0.6 &&
    factors.overall_academic_standing >= 0.6
  ) {
    label = "stable_strong";
  } else if (
    factors.academic_momentum >= 0.4 &&
    factors.overall_academic_standing >= 0.4
  ) {
    label = "stable_developing";
  } else {
    label = "stable_developing";
  }

  return {
    factors,
    label,
    metrics: {
      gpaUnweighted: gpaUw,
      gpaPercentileT20: satPercentile, // proxy
      apCount,
      satTotal: satScore,
      satPercentileT20: satPercentile,
      actTotal: actScore,
      actPercentileT20: actPercentile,
      majorInterest,
    },
    reasoning,
  };
}

/**
 * Recompute directionality for a student, preserving overrides.
 * Called automatically on every syncStudentData().
 *
 * @param {object} dirStmts - prepared statements for directionality table
 * @param {string} studentId - student UUID
 * @param {object} currentSnapshot - current profile snapshot
 * @param {object} priorSnapshot - prior profile snapshot (if exists)
 * @param {object} allSnapshots - all profile snapshots (for trend data)
 * @param {Array} gpaBaselines - baseline GPA data
 * @param {Array} satBaselines - baseline SAT data
 * @param {Array} actBaselines - baseline ACT data
 * @param {Array} collegeProfiles - baseline college profiles
 * @returns {{ id, factors, label, metrics, reasoning, isOverridden, computedAt }}
 */
export function recomputeStudentDirectionality(
  dirStmts,
  studentId,
  currentSnapshot,
  priorSnapshot = null,
  allSnapshots = [],
  gpaBaselines = [],
  satBaselines = [],
  actBaselines = [],
  collegeProfiles = []
) {
  const academics = {
    gpaUnweighted: currentSnapshot.gpa_unweighted,
    apCourses: safeArray(currentSnapshot.ap_scores_json),
    courses: safeArray(currentSnapshot.courses_json),
  };

  const testScores = safeArray(currentSnapshot.test_scores_json);
  const majorInterest = currentSnapshot.major_interest;

  // Compute fresh vector
  const { factors, label, metrics, reasoning } = vectorizeDirectionality({
    academics,
    testScores,
    majorInterest,
    priorSnapshot,
    gpaBaselines,
    satBaselines,
    actBaselines,
    collegeProfiles,
  });

  // Check if student has previously overridden directionality
  const existing = dirStmts.getByStudent.get(studentId);
  let finalFactors = factors;
  let isOverridden = 0;
  let overrideJson = null;

  if (existing && existing.is_overridden) {
    isOverridden = 1;
    overrideJson = existing.override_json;
    // Preserve override values
    try {
      const overrides = JSON.parse(overrideJson);
      if (overrides.academic_momentum !== undefined) finalFactors.academic_momentum = overrides.academic_momentum;
      if (overrides.test_score_strength !== undefined) finalFactors.test_score_strength = overrides.test_score_strength;
      if (overrides.major_academic_fit !== undefined) finalFactors.major_academic_fit = overrides.major_academic_fit;
      if (overrides.rigor_and_challenge !== undefined) finalFactors.rigor_and_challenge = overrides.rigor_and_challenge;
      if (overrides.overall_academic_standing !== undefined) finalFactors.overall_academic_standing = overrides.overall_academic_standing;
    } catch (e) {
      // Ignore parse errors, use computed values
    }
  }

  const id = existing?.id || crypto.randomUUID();
  dirStmts.upsertDirectionality.run(
    id, studentId,
    finalFactors.academic_momentum,
    finalFactors.test_score_strength,
    finalFactors.major_academic_fit,
    finalFactors.rigor_and_challenge,
    finalFactors.overall_academic_standing,
    label,
    metrics.gpaUnweighted,
    metrics.gpaPercentileT20,
    metrics.apCount,
    metrics.satTotal,
    metrics.satPercentileT20,
    metrics.actTotal,
    metrics.actPercentileT20,
    majorInterest,
    JSON.stringify(reasoning),
    isOverridden,
    overrideJson,
  );

  return {
    id,
    factors: finalFactors,
    label,
    metrics,
    reasoning,
    isOverridden: Boolean(isOverridden),
    computedAt: new Date().toISOString(),
  };
}
