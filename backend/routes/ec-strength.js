// routes/ec-strength.js — the /api/ec strength reads, the evidence queued from
// chat, the recompute and override, and the spike read. Split out of routes/ec.js on 2026-09-20; `deps` is the server's
// routeDeps object of live getters.
import { localizeFriendlyLabels, resolveLocale, t } from "../shared/i18n.js";
import { STRENGTH_FACTORS, TIERS, applyStrengthOverride, buildDefaultLLMClient, recomputeStudentECStrengthVectors, toPublicShape as toStrengthPublicShape } from "../activities/ec-strength-vectorizer.js";
import { FACTOR_FRIENDLY, PRESTIGE_SOURCE_FRIENDLY, TIER_FRIENDLY, enrichECVectorWithFriendly, renderFriendlyPrestigeSource } from "../activities/friendly-labels.js";
import { harvestStudentChatRecords } from "../activities/ec-chat-evidence.js";
import * as chatHistory from "../chat/chat-history.js";
import { getActiveNarrative } from "../activities/narrative-store.js";
import { WELLBEING_LIMITS } from "../activities/ec-vectorizer.js";

export function registerEcStrengthRoutes(app, deps) {
  // GET /api/ec/strength — list 5-factor strength vectors for this student
  // When ?friendly=1, each vector is decorated with human-readable labels
  // (tier, prestige source, factors). Jiyeon UX audit F11.
  app.get("/api/ec/strength", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const locale = resolveLocale(req);
      const rows = deps.ragStmts.strength.getByStudent.all(req.studentId) || [];
      const wantFriendly = req.query.friendly === "1" || req.query.friendly === "true";
      const vectors = rows
        .map((row) => {
          const v = toStrengthPublicShape(row);
          if (!v || !wantFriendly) return v;
          return enrichECVectorWithFriendly(v, deps.prestigeExplanationFor(row, v.ecName));
        })
        .filter(Boolean);
      // When the caller wants friendly labels, also ship a locale-aware legend
      // so the frontend can key off `friendlyLegendI18n[tier]` without
      // maintaining its own Korean copy.
      const localizedLegend = wantFriendly ? localizeFriendlyLabels(locale) : null;
      res.json({
        count: rows.length,
        factors: STRENGTH_FACTORS,
        tiers: Object.values(TIERS),
        vectors,
        locale,
        ...(wantFriendly
          ? {
              friendlyLegend: {
                tiers: TIER_FRIENDLY,
                prestigeSources: PRESTIGE_SOURCE_FRIENDLY,
                factors: FACTOR_FRIENDLY,
              },
              friendlyLegendI18n: localizedLegend,
            }
          : {}),
      });
    } catch (err) {
      console.error("[EC strength] list error:", err.message);
      res.status(500).json({ error: "Fetch failed" });
    }
  });

  // GET /api/ec/strength/:ecName — single EC with reasoning + file refs.
  // Always includes the friendly label block and (when cached) the prestige
  // explanation — this is the page the student will actually stare at while
  // deciding whether to keep, deepen, or drop an EC.
  app.get("/api/ec/strength/:ecName", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const row = deps.ragStmts.strength.getByStudentAndName.get(req.studentId, req.params.ecName);
      if (!row) return res.status(404).json({ error: "No strength vector for this EC" });
      const fileRefIds = deps.safeParseJSON(row.file_refs_json, []);
      const attachments = fileRefIds
        .map((id) => deps.ragStmts.strength.getAttachmentById.get(id))
        .filter(Boolean)
        .map((a) => ({
          id: a.id,
          ec_name: a.ec_name,
          filename: a.filename,
          mime_type: a.mime_type,
          extracted_chars: a.extracted_chars,
          status: a.extraction_status,
          uploaded_at: a.uploaded_at,
          // Where the evidence came from: a file attached in chat, or a
          // direct upload.
          origin: String(a.storage_path || "").startsWith("chat://") ? "chat" : "upload",
        }));
      const baseVector = toStrengthPublicShape(row);
      const explanation = deps.prestigeExplanationFor(row, req.params.ecName);
      const enriched = enrichECVectorWithFriendly(baseVector, explanation);
      res.json({
        ok: true,
        vector: enriched,
        reasoning: deps.safeParseJSON(row.reasoning_json, null),
        attachments,
      });
    } catch (err) {
      console.error("[EC strength] get error:", err.message);
      res.status(500).json({ error: "Fetch failed" });
    }
  });

  // GET /api/ec/strength/:ecName/prestige — student-facing prestige rationale.
  // Returns {score, source, rationale, sourcesCited, friendly, fetchedAt}. This
  // is the UX-audit F5 surface — the student can see WHY their EC scored what
  // it did, which reputable sources grounded the score, and when the backend
  // last looked. 404 if the EC doesn't belong to this student or hasn't been
  // researched yet.
  app.get("/api/ec/strength/:ecName/prestige", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const locale = resolveLocale(req);
      const row = deps.ragStmts.strength.getByStudentAndName.get(req.studentId, req.params.ecName);
      if (!row) {
        return res.status(404).json({
          error: "ec_not_found",
          ecName: req.params.ecName,
          locale,
          friendlyMessage: t("prestige.ec_not_found", locale),
          recomputeUrl: null,
        });
      }
      const explanation = deps.prestigeExplanationFor(row, req.params.ecName);
      if (!explanation) {
        const currentSource = row.prestige_source || "legacy";
        // Pull locale-specific short/summary from i18n when available, else
        // fall back to the engineer-shape renderer.
        const localizedSource = {
          short: t(`friendly.prestige.${currentSource}.short`, locale),
          summary: t(`friendly.prestige.${currentSource}.summary`, locale),
        };
        const friendly = localizedSource.short && localizedSource.summary
          ? localizedSource
          : renderFriendlyPrestigeSource(currentSource);
        return res.status(404).json({
          error: "no_cached_rationale",
          ecName: req.params.ecName,
          currentScore: row.prestige ?? 0,
          currentSource,
          friendly,
          locale,
          friendlyMessage: t("prestige.no_cached_rationale", locale, {
            short: friendly.short,
            summary: friendly.summary,
          }),
          recomputeUrl: `/api/ec/strength/recompute`,
          recomputeBody: { ec_name: req.params.ecName },
        });
      }
      const friendly = {
        short: t(`friendly.prestige.${explanation.source}.short`, locale) || renderFriendlyPrestigeSource(explanation.source).short,
        summary: t(`friendly.prestige.${explanation.source}.summary`, locale) || renderFriendlyPrestigeSource(explanation.source).summary,
      };
      res.json({
        ok: true,
        ecName: req.params.ecName,
        ...explanation,
        friendly,
        locale,
        recomputeUrl: `/api/ec/strength/recompute`,
        recomputeBody: { ec_name: req.params.ecName },
      });
    } catch (err) {
      console.error("[EC prestige] get rationale error:", err.message);
      res.status(500).json({ error: "Fetch failed" });
    }
  });

  // POST /api/ec/evidence/from-chat — read the files attached in past chat
  // turns into the activities they concern: the backfill for records stored
  // before chat uploads counted as EC evidence, and the student's own "read
  // my uploads" button. Returns what was linked, what named no activity, what
  // was already stored, and the uploads whose text is not in their chat
  // record (a PDF or image sent before this build kept only its name) so the
  // student can attach them again. Recomputes the strength vectors when
  // anything was linked, so the reply reflects the new evidence.
  app.post("/api/ec/evidence/from-chat", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const profile = deps.assembleProfileForGeneration(req.studentId);
      const summary = harvestStudentChatRecords(deps.ragStmts, req.studentId, {
        activities: profile?.activities || [],
        seal: chatHistory.sealText,
      });
      let recomputed = false;
      if (summary.linked.length) {
        await deps.recomputeStrengthForStudent(req.studentId);
        recomputed = true;
      }
      res.json({ ok: true, ...summary, recomputed });
    } catch (err) {
      console.error("[EC evidence] backfill error:", err.message);
      res.status(500).json({ error: "Could not read the chat uploads" });
    }
  });

  // POST /api/ec/strength/recompute — force a refresh of 4-factor vectors.
  // Body `{ ec_name?: string }` runs only a single EC if provided; else
  // recomputes every EC for the student.
  app.post("/api/ec/strength/recompute", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const snap = deps.ragStmts.getLatestSnapshot.get(req.studentId);
      if (!snap) return res.status(404).json({ error: "No profile data" });
      let activities = deps.safeParseJSON(snap.activities_json, []);
      const { ec_name } = req.body || {};
      if (ec_name) {
        activities = activities.filter((a) => a?.name === ec_name);
        if (activities.length === 0) {
          return res.status(404).json({ error: `No EC named ${ec_name}` });
        }
      }
      const active = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
      const prestigeAdapter = deps.resolvePrestigeAdapter(req.studentId);
      const result = await recomputeStudentECStrengthVectors(
        deps.ragStmts.strength, req.studentId,
        {
          activities,
          narrative: active?.narrativeText || null,
          narrativeThemes: active?.themes || [],
          narrativeHash: active?.hash || null,
          narrativeId: active?.id || null,
          majorInterest: snap.major_interest || null,
          llmClient: buildDefaultLLMClient(deps.ragStmts.narrativeFitCache),
          prestigeAdapter,
          ragStmts: deps.ragStmts,
        },
      );
      res.json({ ok: true, ...result, recomputedAt: new Date().toISOString() });
    } catch (err) {
      console.error("[EC strength] recompute error:", err.message);
      res.status(500).json({ error: "Recompute failed" });
    }
  });

  // POST /api/ec/strength/override — pin one or more factor values for an EC.
  // Overrides survive subsequent recomputes; tier is recalculated from the
  // merged vector.
  app.post("/api/ec/strength/override", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { ec_name, factor, value, overrides } = req.body || {};
      if (!ec_name) return res.status(400).json({ error: "ec_name required" });

      // Support either single {factor,value} or batched {overrides: {...}}
      let payload = {};
      if (overrides && typeof overrides === "object") {
        for (const k of STRENGTH_FACTORS) {
          if (overrides[k] !== undefined) payload[k] = Number(overrides[k]);
        }
      } else if (factor && value !== undefined) {
        if (!STRENGTH_FACTORS.includes(factor)) {
          return res.status(400).json({ error: `factor must be one of: ${STRENGTH_FACTORS.join(", ")}` });
        }
        payload[factor] = Number(value);
      } else {
        return res.status(400).json({ error: "Provide either {factor,value} or {overrides:{...}}" });
      }

      for (const [k, v] of Object.entries(payload)) {
        if (!Number.isFinite(v) || v < 0 || v > 1) {
          return res.status(400).json({ error: `${k} must be a number in [0,1]` });
        }
      }

      const result = applyStrengthOverride(deps.ragStmts.strength, req.studentId, ec_name, payload);
      res.json({
        ok: true,
        ec_name,
        factors: result.factors,
        tier_label: result.tier_label,
        overrides: result.overrideJson,
      });
    } catch (err) {
      if (/No strength vector/i.test(err.message)) {
        return res.status(404).json({ error: err.message });
      }
      console.error("[EC strength] override error:", err.message);
      res.status(500).json({ error: "Override failed" });
    }
  });

  app.get("/api/ec/spike", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const locale = resolveLocale(req);
      const rows = deps.ragStmts.strength.getByStudent.all(req.studentId) || [];
      const rowByName = new Map(rows.map((r) => [r.ec_name, r]));
      const vectors = rows
        .map(toStrengthPublicShape)
        .filter(Boolean)
        .map((v) => {
          const explanation = deps.prestigeExplanationFor(rowByName.get(v.ecName), v.ecName);
          const enriched = enrichECVectorWithFriendly(v, explanation);
          // Composite ranking score from fields already on the row. Tier is the
          // dominant signal (it already folds in dedication/achievement/
          // leadership/prestige); major_spike and narrative_fit break ties
          // toward activities that actually lead the student's story.
          const tierWeight = deps.SPIKE_TIER_WEIGHT[v.tierLabel] ?? 1;
          const spike = Number(v.factors?.major_spike ?? 0);
          const fit = Number(v.factors?.narrative_fit ?? 0);
          // Scaled to 0–1 (the tier weight alone runs to 4, so the raw
          // composite topped out at 2.5 and the card showed "Lead score 1.34").
          const rankScore = (tierWeight * 0.5 + spike * 0.35 + fit * 0.15) / (4 * 0.5 + 0.35 + 0.15);
          return { ...enriched, rankScore: Math.round(rankScore * 1000) / 1000 };
        })
        .sort((a, b) => b.rankScore - a.rankScore);

      // Leading = top 2-3 (cap at 3, but only those that clear foundational).
      const leadingPool = vectors.filter((v) => v.tierLabel !== "tier_4_foundational");
      let leading = (leadingPool.length >= 2 ? leadingPool : vectors).slice(0, 3);
      let leadingNames = new Set(leading.map((v) => v.ecName));
      let supporting = vectors.filter((v) => !leadingNames.has(v.ecName));

      // ── Budgeted semantic re-rank (best-effort) ──
      // Reorder lead vs supporting by genuine narrative/major/target-school fit
      // using supplied evidence, attaching a one-line rationale. Falls back to
      // the deterministic composite on any failure.
      let engine = "deterministic";
      const targetSchools = deps.resolveTargetSchools(req.studentId, (() => {
        const q = req.query.targetSchools;
        if (!q) return null;
        return Array.isArray(q) ? q : String(q).split(",").map((s) => s.trim()).filter(Boolean);
      })());
      if (vectors.length > 0) {
        try {
          const { modelConfig, callLLM } = deps.buildStudentCallLLM(req.studentId);
          if (modelConfig && callLLM) {
            const active = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
            const llm = await deps.llmRankSpike({ callLLM, modelConfig, studentId: req.studentId, active, vectors, targetSchools });
            if (Array.isArray(llm) && llm.length) {
              const byName = new Map(llm.map((x) => [x.name.toLowerCase(), x]));
              for (const v of vectors) {
                const m = byName.get(String(v.ecName).toLowerCase());
                if (m) { v.leadRationale = m.rationale; if (m.sources?.length) v.sources = m.sources; v.leadScore = m.leadScore; }
              }
              // Leaders = LLM-flagged leads (cap 3), highest leadScore first;
              // top up from composite order if the LLM flagged fewer than 2.
              const flagged = vectors
                .filter((v) => byName.get(String(v.ecName).toLowerCase())?.lead)
                .sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0));
              let newLeading = flagged.slice(0, 3);
              if (newLeading.length < 2) {
                for (const v of vectors) {
                  if (newLeading.length >= 2) break;
                  if (!newLeading.includes(v)) newLeading.push(v);
                }
              }
              leading = newLeading;
              leadingNames = new Set(leading.map((v) => v.ecName));
              supporting = vectors.filter((v) => !leadingNames.has(v.ecName));
              engine = "llm";
            }
          }
        } catch (e) {
          console.warn("[EC spike] LLM re-rank failed, using deterministic:", e.message);
        }
      }

      // Wellbeing guardrail: sum weekly hours across ECs against the
      // sustainable ceiling encoded in ec-vectorizer.js. Duty-of-care AND
      // differentiator — we optimize for the student, not a longer list.
      const totalWeeklyHours = rows.reduce(
        (sum, r) => sum + (Number(r.hours_per_week) || 0),
        0,
      );
      const overCommitted = totalWeeklyHours >= WELLBEING_LIMITS.caution_weekly_hours;
      const wellbeing = {
        totalWeeklyHours: Math.round(totalWeeklyHours * 10) / 10,
        sustainableCap: WELLBEING_LIMITS.sustainable_weekly_hours,
        cautionLine: WELLBEING_LIMITS.caution_weekly_hours,
        hardCeiling: WELLBEING_LIMITS.hard_ceiling_weekly_hours,
        overCommitted,
        message: overCommitted
          ? `You're at ${Math.round(totalWeeklyHours)} hrs/week across your activities — above the ${WELLBEING_LIMITS.caution_weekly_hours}-hr caution line. Before adding anything, consider deepening your leading activities and easing off the supporting ones.`
          : `You're at ${Math.round(totalWeeklyHours)} hrs/week across your activities, within a sustainable range (up to ${WELLBEING_LIMITS.sustainable_weekly_hours} hrs/week).`,
      };

      const localizedLegend = localizeFriendlyLabels(locale);
      res.json({
        ok: true,
        count: rows.length,
        engine,
        targetSchools,
        leading,
        supporting,
        wellbeing,
        factors: STRENGTH_FACTORS,
        tiers: Object.values(TIERS),
        locale,
        friendlyLegend: {
          tiers: TIER_FRIENDLY,
          prestigeSources: PRESTIGE_SOURCE_FRIENDLY,
          factors: FACTOR_FRIENDLY,
        },
        friendlyLegendI18n: localizedLegend,
      });
    } catch (err) {
      console.error("[EC spike] error:", err.message);
      res.status(500).json({ error: "Spike analysis failed" });
    }
  });
}
