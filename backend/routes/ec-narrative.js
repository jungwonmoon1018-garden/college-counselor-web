// routes/ec-narrative.js — the /api/ec narrative routes, the candidate ranker
// and the idea generator. Split out of routes/ec.js on 2026-09-20; `deps` is the server's
// routeDeps object of live getters.
import { NARRATIVE_MAX_CHARS, NARRATIVE_MIN_CHARS, NarrativeValidationError, computeProfileFingerprint, getActiveNarrative, saveNarrative, softDeleteNarrative } from "../activities/narrative-store.js";
import { resolveLocale, t } from "../shared/i18n.js";
import { matchMajorBucket as matchMajorBucketFn } from "../activities/ec-vectorizer.js";
import { renderFriendlyFactor, renderFriendlyTier } from "../activities/friendly-labels.js";
import { exemplarsPromptBlock, randomExemplarGroup } from "../activities/crimson-ec-exemplars.js";

export function registerEcNarrativeRoutes(app, deps) {
  // POST /api/ec/narrative — save a new narrative (deactivates prior active)
  app.post("/api/ec/narrative", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { narrative_text } = req.body || {};
      const result = saveNarrative(deps.ragStmts.narrative, req.studentId, narrative_text);
      res.json({
        ok: true,
        id: result.id,
        hash: result.hash,
        themes: result.themes,
        major_buckets: result.majorBuckets,
        active: true,
        min_chars: NARRATIVE_MIN_CHARS,
        max_chars: NARRATIVE_MAX_CHARS,
      });
    } catch (err) {
      if (err instanceof NarrativeValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      console.error("[EC narrative] save error:", err.message);
      res.status(500).json({ error: "Save failed" });
    }
  });

  // GET /api/ec/narrative — fetch the currently-active narrative
  app.get("/api/ec/narrative", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const active = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
      res.json({ active: active || null });
    } catch (err) {
      console.error("[EC narrative] get error:", err.message);
      res.status(500).json({ error: "Fetch failed" });
    }
  });

  // GET /api/ec/narrative/active — the active narrative flattened to the shape
  // the NarrativeEditor reads (narrative_text/id/created_at), plus `source`
  // ('student' | 'auto') and `profileStale` (true when the story predates
  // newly-added ECs/courses, by fingerprint). Returns null when none exists.
  app.get("/api/ec/narrative/active", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const active = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
      if (!active) return res.json(null);
      let profileStale = false;
      try {
        const profile = deps.assembleProfileForGeneration(req.studentId);
        if (profile && active.profileFingerprint) {
          profileStale = active.profileFingerprint !== computeProfileFingerprint(profile);
        }
      } catch { /* non-fatal */ }
      res.json({
        id: active.id,
        narrative_text: active.narrativeText,
        text: active.narrativeText,
        themes: active.themes,
        major_buckets: active.majorBuckets,
        hash: active.hash,
        source: active.source,
        profile_fingerprint: active.profileFingerprint,
        profileStale,
        created_at: active.createdAt,
      });
    } catch (err) {
      console.error("[EC narrative active] get error:", err.message);
      res.status(500).json({ error: "Fetch failed" });
    }
  });

  // DELETE /api/ec/narrative — soft-delete (sets is_active=0, preserves history)
  app.delete("/api/ec/narrative", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const info = softDeleteNarrative(deps.ragStmts.narrative, req.studentId);
      res.status(204).set("X-Deactivated", String(info.deactivated)).end();
    } catch (err) {
      console.error("[EC narrative] delete error:", err.message);
      res.status(500).json({ error: "Delete failed" });
    }
  });

  // POST /api/ec/candidates/rank — narrative-aware ranking of candidate ECs.
  // Jiyeon UX audit F6. The student types a shortlist of ideas she's debating
  // ("Start a bioinformatics club", "Translate at a patient foundation"); we
  // score each one against her ACTIVE narrative's themes + major buckets.
  // A fast deterministic keyword/bucket pass produces a baseline; when the
  // installation has OpenRouter configured, a budgeted semantic re-rank can
  // recognize genuine fit even with zero literal keyword overlap.
  app.post("/api/ec/candidates/rank", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const locale = resolveLocale(req);
      const { candidates, majorInterest } = req.body || {};
      if (!Array.isArray(candidates) || candidates.length === 0) {
        return res.status(400).json({ error: "candidates must be a non-empty array of {name, description?}" });
      }
      if (candidates.length > 25) {
        return res.status(400).json({ error: "max 25 candidates per request" });
      }

      const active = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
      if (!active) {
        return res.status(409).json({
          error: "no_active_narrative",
          locale,
          friendlyMessage: t("candidates.no_active_narrative", locale),
        });
      }

      const narrativeThemes = (active.themes || [])
        .map((t) => (typeof t === "string" ? t : t?.theme))
        .filter(Boolean)
        .map((t) => String(t).toLowerCase());
      const narrativeBuckets = new Set((active.majorBuckets || []).map(String));
      const declaredMajorBucket = majorInterest ? matchMajorBucketFn(majorInterest) : null;
      if (declaredMajorBucket) narrativeBuckets.add(declaredMajorBucket);

      const ranked = candidates.map((raw, idx) => {
        const name = String(raw?.name || "").trim();
        const description = String(raw?.description || "").trim();
        const combined = `${name} ${description}`.toLowerCase();
        if (!name) {
          return { ok: false, index: idx, error: t("candidates.name_required", locale) };
        }

        // 1. Major bucket match — did the candidate's text land in one of
        //    the narrative's detected buckets?
        const candidateBucket = matchMajorBucketFn(combined);
        const bucketHit = candidateBucket && narrativeBuckets.has(candidateBucket);

        // 2. Theme co-occurrence — count how many narrative themes appear in
        //    the candidate's text. Weight unigrams at 1, bigrams at 2.
        let themeHits = 0;
        const matchedThemes = [];
        for (const theme of narrativeThemes) {
          if (theme.length < 4) continue;
          if (combined.includes(theme)) {
            themeHits += theme.includes(" ") ? 2 : 1;
            matchedThemes.push(theme);
            if (matchedThemes.length >= 8) break;
          }
        }

        // 3. Predicted narrative_fit in [0, 1] — a friendly linear model.
        const predictedNarrativeFit = Math.min(
          1,
          (bucketHit ? 0.5 : 0) + Math.min(0.5, themeHits * 0.08),
        );

        // 4. Predicted tier — an EC that would land tier_2+ needs at least
        //    both a bucket match and some theme overlap.
        let predictedTier = "tier_4_foundational";
        if (bucketHit && themeHits >= 3) predictedTier = "tier_2_strong";
        else if (bucketHit || themeHits >= 4) predictedTier = "tier_3_developing";

        // Friendly summary — route through i18n so Korean students read Korean.
        const prettyBucket = (candidateBucket || "").replace(/_/g, " ");
        const themesList = matchedThemes.slice(0, 3).join(", ");
        let summaryKey;
        let summaryParams = {};
        if (bucketHit && themeHits >= 2) {
          summaryKey = "candidates.summary_strong";
          summaryParams = { bucket: prettyBucket, themes: themesList, fit: predictedNarrativeFit.toFixed(2) };
        } else if (bucketHit) {
          summaryKey = "candidates.summary_major_hit";
          summaryParams = { bucket: prettyBucket };
        } else if (themeHits > 0) {
          summaryKey = "candidates.summary_partial";
          summaryParams = { themes: themesList };
        } else {
          summaryKey = "candidates.summary_weak";
        }

        return {
          ok: true,
          index: idx,
          name,
          description: description || null,
          candidateBucket: candidateBucket || null,
          bucketHit,
          matchedThemes,
          themeHits,
          predictedNarrativeFit: Math.round(predictedNarrativeFit * 100) / 100,
          predictedTier,
          friendly: {
            tier: renderFriendlyTier(predictedTier),
            narrativeFit: renderFriendlyFactor("narrative_fit"),
            summary: t(summaryKey, locale, summaryParams),
            summaryKey,
          },
        };
      });

      // Sort descending by predicted fit so the student can see the top picks first.
      ranked.sort((a, b) => (b.predictedNarrativeFit ?? 0) - (a.predictedNarrativeFit ?? 0));

      // ── Budgeted semantic re-rank (best-effort) ──
      // The deterministic pass above is brittle (literal keyword overlap). When
      // OpenRouter is configured, ask the LLM to judge each idea's true fit to
      // the narrative/profile/target schools using supplied evidence, then merge
      // those scores and rationales over the baseline. Any failure keeps the
      // deterministic result.
      let engine = "deterministic";
      let rerankNote = null;
      const targetSchools = deps.resolveTargetSchools(req.studentId, req.body?.targetSchools);
      try {
        const { modelConfig, callLLM } = deps.buildStudentCallLLM(req.studentId);
        if (modelConfig && callLLM) {
          // The re-rank is bounded: a slow or stalled provider call used to hold
          // the whole response (the adapter allows ~105 s), and the student saw
          // "Ranking…" with no result for the entire wait. Past the budget the
          // deterministic ranking goes back with a note; the model call finishes
          // in the background and is simply discarded.
          const budgetMs = Number(process.env.EC_RERANK_TIMEOUT_MS) > 0 ? Number(process.env.EC_RERANK_TIMEOUT_MS) : 30_000;
          let timer = null;
          const llm = await Promise.race([
            deps.llmRankCandidates({ callLLM, modelConfig, studentId: req.studentId, active, candidates, targetSchools })
              .catch((e) => { console.warn("[EC candidates rank] LLM re-rank failed, using deterministic:", e.message); return null; }),
            new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), budgetMs); timer.unref?.(); }),
          ]);
          if (timer) clearTimeout(timer);
          if (llm === "timeout") {
            rerankNote = t("candidates.rerank_timeout", locale);
            console.warn(`[EC candidates rank] LLM re-rank exceeded ${budgetMs} ms, returning deterministic ranking`);
          }
          if (Array.isArray(llm) && llm.length) {
            const byName = new Map(llm.map((x) => [x.name.toLowerCase(), x]));
            for (const row of ranked) {
              if (!row.ok) continue;
              const m = byName.get(String(row.name).toLowerCase());
              if (!m) continue;
              row.predictedNarrativeFit = Math.round(m.fit * 100) / 100;
              if (m.tier) row.predictedTier = m.tier;
              row.friendly = {
                ...row.friendly,
                tier: renderFriendlyTier(row.predictedTier),
                summary: m.prestigeNote ? `${m.rationale} ${m.prestigeNote}`.trim() : (m.rationale || row.friendly?.summary),
              };
              if (m.sources?.length) row.sources = m.sources;
              row.engine = "llm";
            }
            ranked.sort((a, b) => (b.predictedNarrativeFit ?? 0) - (a.predictedNarrativeFit ?? 0));
            engine = "llm";
          }
        }
      } catch (e) {
        console.warn("[EC candidates rank] LLM re-rank failed, using deterministic:", e.message);
      }

      res.json({
        ok: true,
        engine,
        rerankNote,
        narrativeId: active.id,
        narrativeHash: active.hash,
        narrativeBuckets: [...narrativeBuckets],
        targetSchools,
        candidates: ranked,
        count: ranked.length,
        locale,
      });
    } catch (err) {
      console.error("[EC candidates rank] error:", err.message);
      res.status(500).json({ error: "Candidate ranking failed" });
    }
  });

  // POST /api/ec/ideas/generate — brainstorm NEW EC ideas grounded ONLY in the
  // student's real profile (courses, ECs, scores, major, goals, narrative).
  // Honors SKILL.md: suggestions framed as "you might consider", never invents
  // awards/prestige. Each idea is tagged with deterministic narrative fit.
  app.post("/api/ec/ideas/generate", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const locale = resolveLocale(req);
      const { modelConfig, callLLM } = deps.buildStudentCallLLM(req.studentId);
      if (!modelConfig) return res.status(503).json({ error: "The administrator must configure OpenRouter first." });
      const profile = deps.assembleProfileForGeneration(req.studentId);
      if (!profile) return res.status(404).json({ error: "No profile data. Complete your profile first." });
      const active = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
      const count = Math.min(8, Math.max(3, parseInt(req.body?.count, 10) || 5));
      const targetSchools = deps.resolveTargetSchools(req.studentId, req.body?.targetSchools);
      const priorities = await deps.getSchoolPriorities(targetSchools);
      const schoolBlock = deps.schoolPrioritiesPromptBlock(priorities);

      const summary = deps.profileSummaryForPrompt(profile, active);
      // Inject a random group of ten reference exemplars (Crimson set) as
      // calibration — real strong-EC patterns the model can gauge depth against
      // without copying. Reshuffled each call so suggestions stay varied.
      const exemplarBlock = exemplarsPromptBlock(randomExemplarGroup(10));
      const prompt = `STUDENT PROFILE (their real data — the ONLY basis for your ideas):
  ${summary}${schoolBlock}${exemplarBlock}

  TASK: Suggest ${count} extracurricular activity IDEAS this student could realistically pursue to strengthen their application${targetSchools.length ? " for the target schools above" : ""}. Ground EVERY idea in the profile above — connect each to a course, an existing activity, a test/AP strength, the intended major, or a stated goal.

  RULES:
  - Build on what the student already does (depth over breadth). Prefer deepening or extending existing activities and a coherent "spike" over scattered new clubs.${targetSchools.length ? "\n- Favor ideas that strengthen fit for what the target schools value above, but only where it fits the student's genuine direction." : ""}
  - Include at least one idea that builds community & character (service, mentorship, inclusivity, or authentic community impact) where it grows naturally out of something the student already cares about — never as résumé-padding.
  - Use the REFERENCE examples only to calibrate what "strong" looks like (depth, leadership, real impact). Do NOT copy them or assume the student has done them.
  - NEVER claim the student has won an award, held a title, or done something not in the profile.
  - Each idea must be something the student does themselves; frame as a suggestion to consider. These are activity ideas the student carries out and later writes about in their OWN words — never draft the essay or the story for them.

  Return ONLY a JSON array of exactly ${count} objects, no prose, no markdown:
  [
    {
      "name": "<short activity name>",
      "category": "<research|service|leadership|competition|creative|work|club|project|community|other>",
      "rationale": "<1-2 sentences tying this to the student's specific evidence above>",
      "dimension": "<which strength it builds: leadership|achievement|dedication|major_spike|prestige|narrative_fit|community_and_character>",
      "hoursPerWeekEstimate": <integer>
    }
  ]`;

      const resp = await callLLM({
        model: modelConfig.models?.medium || modelConfig.models?.large,
        max_tokens: 2000,
        system: "You are a college counselor brainstorming extracurricular ideas grounded ONLY in the student's real profile. Never invent awards or accomplishments. Output ONLY the requested JSON.",
        messages: [{ role: "user", content: prompt }],
      });
      const text = (resp?.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      const parsed = deps.parseLLMJson(text);
      const rawIdeas = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.ideas) ? parsed.ideas : []);
      const ideas = rawIdeas.slice(0, count).map((it) => {
        const name = String(it?.name || "").slice(0, 120);
        const category = String(it?.category || "other").slice(0, 40);
        const rationale = String(it?.rationale || "").slice(0, 400);
        const dimension = String(it?.dimension || "").slice(0, 40);
        const hours = Number.isFinite(Number(it?.hoursPerWeekEstimate)) ? Math.max(0, Math.min(40, Math.round(Number(it.hoursPerWeekEstimate)))) : null;
        const tag = deps.tagIdeaWithNarrative(`${name} ${rationale}`, active);
        return {
          name, category, rationale, dimension,
          hoursPerWeekEstimate: hours,
          ...tag,
          friendly: tag.predictedTier ? { tier: renderFriendlyTier(tag.predictedTier) } : null,
        };
      }).filter(it => it.name);

      res.json({ ok: true, ideas, count: ideas.length, hasNarrative: Boolean(active), targetSchools, locale });
    } catch (err) {
      if (Number.isInteger(err?.status) || err?.code) return deps.respondLLMError(res, err, "EC ideas generate");
      console.error("[EC ideas generate] error:", err.message);
      res.status(500).json({ error: "Idea generation failed" });
    }
  });
}
