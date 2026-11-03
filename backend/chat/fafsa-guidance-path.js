// chat/fafsa-guidance-path.js — which FAFSA guidance text the orchestration
// catalog loads at boot.
//
// The path used to be a constant naming data/fafsa/2026-2027.txt, so once the
// rules moved to the next award year (FAFSA_RULESETS in rules-engine.js) the
// chat would still have grounded FAFSA answers in the expired year's text,
// even with the new year's file on disk. The file now follows the award year
// selectFafsaRuleset picks for the date, then the newest <YYYY-YYYY>.txt
// present, then the old name, so an older deployment with only the
// 2026-2027 file reads exactly what it read before. FAFSA_GUIDANCE_PATH in
// the environment still wins over all three.
import fs from "node:fs";
import path from "node:path";
import { selectFafsaRuleset } from "./rules-engine.js";

export const LEGACY_FAFSA_GUIDANCE_FILE = "2026-2027.txt";

// An award year spans two consecutive calendar years ("2026-2027.txt").
const AWARD_YEAR_FILE_RE = /^(\d{4})-(\d{4})\.txt$/;

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveFafsaGuidancePath({ dir, now = new Date(), override = "", rulesets } = {}) {
  if (override) return override;
  const awardYear = selectFafsaRuleset(now, rulesets)?.academicYear;
  if (awardYear) {
    const current = path.join(dir, `${awardYear}.txt`);
    if (isFile(current)) return current;
  }
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  const newest = names
    .map((name) => ({ name, match: AWARD_YEAR_FILE_RE.exec(name) }))
    .filter(({ name, match }) => match && Number(match[2]) === Number(match[1]) + 1 && isFile(path.join(dir, name)))
    .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))[0];
  if (newest) return path.join(dir, newest.name);
  return path.join(dir, LEGACY_FAFSA_GUIDANCE_FILE);
}
