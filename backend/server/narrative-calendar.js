// server/narrative-calendar.js — the narrative draft and its automatic
// regeneration, the student's target schools and their priorities, and the
// admissions calendar. Moved out of server.js on 2026-09-20.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (AUTO_NARRATIVE_TRIGGERS, C7_PRIORITY_WEIGHTS,
// db, profileSummaryForPrompt, ragStmts).
import { NARRATIVE_MAX_CHARS, NARRATIVE_MIN_CHARS, computeProfileFingerprint, getActiveNarrative, saveNarrative } from "../narrative-store.js";
import { assembleProfileForGeneration } from "../server/verified-data.js";
import { buildStudentCallLLM, safeParseJSON } from "../server/model-calls.js";
import { extractGoalUnitIds } from "../rag-engine.js";
import { extractTargetSchoolNames } from "../cds-search.js";

let deps;
export function bindNarrativeCalendar(serverDeps) { deps = serverDeps; }

// Shared narrative-draft generator — single home for the prompt so the
// manual /api/narrative/draft endpoint and the auto-regenerator produce
// identical, SKILL.md-grounded output. Returns the cleaned draft string
// (caller validates/saves). `existing` is the current active narrative (or
// null) so the model can refine rather than discard the student's voice.
export async function generateNarrativeDraftText({ profile, existing, callLLM, modelConfig, schoolBlock = "" }) {
  const summary = deps.profileSummaryForPrompt(profile, existing);
  const prompt = `STUDENT PROFILE (their real data — the ONLY basis for the draft):
${summary}
${existing?.narrativeText ? `\nThe student's CURRENT narrative (refine, don't discard their voice):\n"${existing.narrativeText}"` : ""}${schoolBlock}

TASK: Write a DRAFT "narrative" — a ${NARRATIVE_MIN_CHARS}-${NARRATIVE_MAX_CHARS} character first-person self-presentation that captures who this student is academically and what intellectual thread connects their work (a "spike"). This is a starting point the student will edit — NOT an application essay.

RULES:
- First person ("I ..."). ${NARRATIVE_MIN_CHARS}-${NARRATIVE_MAX_CHARS} characters.
- Use ONLY evidence from the profile. Never invent awards, titles, or experiences.
- Name the intended major/field and 1-2 concrete activities or courses that show the thread.
- If the profile shows service, mentorship, inclusivity, or community impact, you may surface it as part of who this student is — but reflect ONLY what the evidence actually supports. Never manufacture empathy, motives, or character qualities the student did not state.
- Plain, authentic, specific — not flowery. One short paragraph.

This is editable scaffolding in the student's OWN voice — a starting point they will rewrite, not a finished essay and not words handed to them. Leave room for the student to add the lived detail and reflection only they can write; do not over-polish it into something that no longer sounds like them.

Return ONLY the draft text, no quotes, no preamble.`;

  const resp = await callLLM({
    model: modelConfig.models?.medium || modelConfig.models?.large,
    max_tokens: 700,
    system: "You draft a short first-person self-presentation grounded ONLY in the student's real profile. Never invent accomplishments. Return only the draft text.",
    messages: [{ role: "user", content: prompt }],
  });
  let draft = (resp?.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  draft = draft.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim();
  if ((draft.startsWith('"') && draft.endsWith('"')) || (draft.startsWith("“") && draft.endsWith("”"))) {
    draft = draft.slice(1, -1).trim();
  }
  if (draft.length > NARRATIVE_MAX_CHARS) draft = draft.slice(0, NARRATIVE_MAX_CHARS);
  return draft;
}

export async function maybeAutoRegenerateNarrative(studentId, changes) {
  try {
    const relevant = Array.isArray(changes) && changes.some(c => deps.AUTO_NARRATIVE_TRIGGERS.has(c?.type));
    if (!relevant) return { skipped: "no_relevant_change" };

    const profile = assembleProfileForGeneration(studentId);
    if (!profile) return { skipped: "no_profile" };
    const fp = computeProfileFingerprint(profile);
    const existing = getActiveNarrative(deps.ragStmts.narrative, studentId);

    // Protect the student's voice: never overwrite a hand-written narrative.
    if (existing && existing.source === "student") return { skipped: "student_written" };
    // Nothing material changed since the last auto-narrative.
    if (existing && existing.source === "auto" && existing.profileFingerprint === fp) {
      return { skipped: "fingerprint_unchanged" };
    }

    const { modelConfig, callLLM } = buildStudentCallLLM(studentId);
    if (!modelConfig) return { skipped: "openrouter_not_configured" };

    // Tailor the auto-narrative toward the student's saved target schools.
    let schoolBlock = "";
    try {
      const priorities = await getSchoolPriorities(resolveTargetSchools(studentId, null));
      schoolBlock = schoolPrioritiesPromptBlock(priorities);
    } catch { /* non-fatal */ }
    const draft = await generateNarrativeDraftText({ profile, existing, callLLM, modelConfig, schoolBlock });
    try {
      const saved = saveNarrative(deps.ragStmts.narrative, studentId, draft, { source: "auto", profileFingerprint: fp });
      console.log(`[AUTO-NARRATIVE] regenerated for ${String(studentId).slice(0, 8)} (${saved.id.slice(0, 8)})`);
      return { regenerated: true, id: saved.id };
    } catch (e) {
      // Draft failed validation (too short/long) — leave prior narrative intact.
      console.warn("[AUTO-NARRATIVE] draft rejected:", e.message);
      return { skipped: "invalid_draft" };
    }
  } catch (err) {
    if (err?.budget) return { skipped: "budget", code: err.code || "budget_denied" };
    console.warn("[AUTO-NARRATIVE] failed:", err.message);
    return { skipped: "error" };
  }
}

// ───────────────────────────────────────────────────────────
// Target-school tailoring — shared by the EC-idea / narrative /
// course tools so their output is oriented toward the specific
// universities the student wants. Source priority: explicit request
// override → the student's saved goal schools.
// ───────────────────────────────────────────────────────────
export function resolveTargetSchools(studentId, requested) {
  if (Array.isArray(requested) && requested.length) {
    return requested
      .map((s) => String(s?.schoolName || s?.name || s || "").trim())
      .filter(Boolean)
      .slice(0, 6);
  }
  try {
    const snap = deps.ragStmts.getLatestSnapshot.get(studentId);
    const goals = safeParseJSON(snap?.goals_json, []);
    const goalUnitIds = extractGoalUnitIds(goals);
    const fallbackRows = goalUnitIds
      .map((u) => deps.db.prepare("SELECT unit_id, name FROM baseline_colleges WHERE unit_id = ?").get(u))
      .filter(Boolean);
    // extractTargetSchoolNames returns {unitId, schoolName} objects; callers
    // (calendar/context, getSchoolPriorities) expect plain strings like the
    // requested-path branch above. Map to the name so this always returns
    // string[] — otherwise s.toLowerCase() downstream throws on the objects.
    return extractTargetSchoolNames(goals, fallbackRows)
      .map((t) => String(t?.schoolName || t?.name || t || "").trim())
      .filter(Boolean)
      .slice(0, 6);
  } catch {
    return [];
  }
}

// An admit rate as a percent with one decimal, from a fraction (0.0923) or
// a percent (9.23); null when there is none.
export function admitRatePercentOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const pct = n <= 1 ? n * 100 : n;
  return Math.round(pct * 10) / 10;
}

export async function getSchoolPriorities(schoolNames) {
  if (!Array.isArray(schoolNames) || !schoolNames.length) return [];
  let loadValidatedRecord;
  try { ({ loadValidatedRecord } = await import("./cds-validator.js")); }
  catch { return schoolNames.map((s) => ({ school: s, hasData: false })); }
  const slugify = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const out = [];
  for (const name of schoolNames) {
    let rec = null;
    try { rec = loadValidatedRecord(deps.ragStmts, slugify(name)); } catch { /* ignore */ }
    if (!rec) { out.push({ school: name, hasData: false }); continue; }
    const factors = Object.entries(rec.c7 || {})
      .map(([k, label]) => ({ factor: k, label, weight: deps.C7_PRIORITY_WEIGHTS[label] ?? null }))
      .filter((f) => f.weight != null)
      .sort((a, b) => (b.weight || 0) - (a.weight || 0));
    out.push({
      school: rec.school || name,
      hasData: true,
      // A percent, whatever scale the record used: the validated record
      // holds a fraction (0.0923), and "(admit ~0.0923%)" reached both the
      // course-plan card and the model's target-school block.
      admitRate: admitRatePercentOf(rec.overallAdmitRate),
      topFactors: factors.filter((f) => f.weight >= 0.7).map((f) => f.factor),
      rigorWeight: deps.C7_PRIORITY_WEIGHTS[rec.c7?.rigor] ?? null,
      c7: rec.c7 || null,
      sourceUrl: rec.sourceUrl || null,
    });
  }
  return out;
}

// Promptable block describing what the target schools value. Empty when no
// targets, so callers can append unconditionally.
export function schoolPrioritiesPromptBlock(priorities) {
  if (!Array.isArray(priorities) || !priorities.length) return "";
  const lines = priorities.map((p) => {
    if (!p.hasData) return `  • ${p.school} (no Common Data Set on file — use general knowledge cautiously, don't invent)`;
    const fac = (p.topFactors || []).map((f) => String(f).replace(/_/g, " ")).join(", ");
    return `  • ${p.school}${p.admitRate != null ? ` (admit ~${p.admitRate}%)` : ""}${fac ? ` — most-valued factors: ${fac}` : ""}`;
  });
  return `\n\nTARGET SCHOOLS the student is aiming for — tailor toward what THESE schools value (from their Common Data Set where available; do NOT name the schools in the output text, just let their priorities shape emphasis):\n${lines.join("\n")}`;
}

// ───────────────────────────────────────────────────────────
// Admissions calendar awareness — the consultant agent needs to know
// today's date, the current application-cycle phase, typical US deadlines,
// and approximate high-school breaks. Deterministic from the server clock
// (always fresh), so the agent is never date-blind even without web access.
// ───────────────────────────────────────────────────────────
export function buildAdmissionsCalendar(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1..12
  // A senior applying in the fall of `cycleStartYear` matriculates the next
  // fall (`cycleEntryYear`). The cycle rolls forward to the NEXT season once
  // RD season is over (February onward): from Feb–Jul the just-finished
  // cycle's EA/ED/RD/deposit dates are all in the past, so the relevant
  // deadlines to outline are the UPCOMING fall's. January is the one month
  // still inside the active RD window, so it stays on that cycle.
  const cycleStartYear = m >= 2 ? y : y - 1;
  const cycleEntryYear = cycleStartYear + 1;
  let phase;
  if (m >= 8 && m <= 10) phase = "early-application season — EA/ED apps due ~Nov 1";
  else if (m === 11) phase = "EA/ED deadlines now; RD apps being finalized";
  else if (m === 12) phase = "early decisions releasing; RD apps due ~Jan 1";
  else if (m === 1) phase = "regular-decision deadlines (~Jan 1-15)";
  else phase = "planning the upcoming cycle — research, essays, and target list for applications this fall";
  return {
    today: now.toISOString().slice(0, 10),
    cycleStartYear,
    cycleEntryYear,
    schoolYear: `${cycleStartYear}–${cycleEntryYear}`,
    applicationCycle: `Class entering Fall ${cycleEntryYear}`,
    phase,
    typicalDeadlines: {
      earlyEaEd: `~Nov 1 ${cycleStartYear} (some Nov 15)`,
      regularDecision: `~Jan 1–15 ${cycleEntryYear}`,
      eaEdDecisionsRelease: `mid–late Dec ${cycleStartYear}`,
      rdDecisionsRelease: `mid-Mar–early-Apr ${cycleEntryYear}`,
      fafsaOpens: `Oct 1 ${cycleStartYear}`,
      cssProfilePriority: `Nov ${cycleStartYear}–Feb ${cycleEntryYear} (varies)`,
      financialAidPriority: `often the ED/EA date, else ~Feb 1 ${cycleEntryYear}`,
      nationalDepositDeadline: `May 1 ${cycleEntryYear}`,
    },
    typicalHsBreaks: {
      summer: `early-June–late-Aug ${cycleStartYear}`,
      thanksgiving: `late Nov ${cycleStartYear}`,
      winter: `~Dec 20 ${cycleStartYear}–early Jan ${cycleEntryYear}`,
      spring: `~Mar–Apr ${cycleEntryYear}`,
    },
    // Concrete ISO fallbacks (parseable) so the UI can always create dated
    // deadline entries even when no per-school web data is available.
    typicalISO: {
      earlyEaEd: `${cycleStartYear}-11-01`,
      regularDecision: `${cycleEntryYear}-01-01`,
      financialAidPriority: `${cycleEntryYear}-02-01`,
      fafsaOpens: `${cycleStartYear}-10-01`,
      nationalDepositDeadline: `${cycleEntryYear}-05-01`,
    },
    note: "Approximate US norms — exact dates vary by school and year; verify on each school's admissions/financial-aid site.",
  };
}
