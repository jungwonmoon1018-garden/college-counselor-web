// What the College Fit read depends on. The card used to keep the read it
// was opened with: a student who edited a course, added an AP score or
// changed an activity after looking a school up saw the old matrix and
// the old positioning until they searched the school again. The app now
// fingerprints the parts of the record the fit reads and, after a profile
// sync lands, re-reads the shown school when the fingerprint has moved —
// and not when only chat memory, notes or documents changed.
export function fitProfileFingerprint(data) {
  const p = data?.profile || {};
  return JSON.stringify({
    gpa: p.gpa ?? null,
    classRank: p.classRank ?? null,
    courses: p.courses ?? [],
    apScores: p.apScores ?? [],
    testScores: p.testScores ?? [],
    activities: data?.activities ?? [],
    majorInterest: data?.majorInterest ?? p.majorInterest ?? null,
  });
}

// True when the shown read (taken at `readFingerprint`) no longer matches
// the record.
export function fitReadIsStale(readFingerprint, data) {
  if (!readFingerprint) return false;
  return readFingerprint !== fitProfileFingerprint(data);
}
