# Methodology

College Counselor separates deterministic rules, verified evidence,
student-provided information, and AI coaching. These categories are not
interchangeable.

## Claim lanes

- **Verified fact**: supported by a relevant, unexpired source record with a
  resolvable official URL.
- **Student-provided fact**: supplied by the authenticated student and not
  independently verified.
- **Coaching suggestion**: an editable recommendation, never an admissions
  prediction or official determination.

Extracted text is not automatically verified. A paragraph is not promoted to
verified because one sentence has a citation. When a regulated question has no
matching current source, the application says that no verified answer is
available.

## Regulated guidance

FAFSA eligibility and deadline calculations use versioned deterministic rules.
Each rule carries an academic year, effective date, source URL, and expiry.
The application does not treat Selective Service registration as a current
Title IV eligibility requirement.

FAFSA output is advisory and does not replace StudentAid.gov. Stale or missing
deadline evidence results in a verification prompt rather than an invented date.

## Positioning and fit

College fit is expressed with ranges, uncertainty, data coverage, and
provenance. It is not an acceptance probability. Student overrides remain
visible and survive recomputation. Limited data lowers confidence instead of
being filled with model guesses.

The priorities matrix under the fit card reads the whole record against each
value a school states or each admission factor it declares in section C7 of
its Common Data Set: GPA, class rank, every test score with its sections and
AP exam results placed against the enrolled class, courses by type, and each
activity with the qualities its own description shows (leadership, character,
talent, commitment, impact). A priority the profile cannot show, such as an
essay or recommendations, is labeled as such rather than counted as a gap.

An activity's prestige is read deterministically from its name, its
150-character description, listed awards, role and attachment text against
the seeded competition benchmarks and the organizers' official catalog. No web
research runs. The rationale names the competition and level matched, where it
was found, the next level and what it is worth, and — when nothing matches —
what to write so the next read can pick it up.

## Sources

The supported source classes are:

| Data | Primary source |
| --- | --- |
| College outcomes, costs, and admissions fields | IPEDS / College Scorecard |
| Institutional admissions factors | Official Common Data Set |
| FAFSA rules | Federal Student Aid publications |
| Application deadlines | Official institution admissions pages |
| AP reference material | Released College Board material |

Bundled baseline values are labeled as bundled and retain their original
vintage. Startup does not relabel them as freshly verified. Fact ingestion uses
semantic upserts so repeated startup cannot crowd out distinct evidence.

## Model use and cost

OpenRouter is the only model provider, and requests use its fixed official
HTTPS endpoint. Models are constrained by a packaged allowlist and known price
manifest. A live catalog may confirm availability and price but cannot add an
arbitrary model. Unknown-price models fail closed.

Paid calls reserve their maximum estimated cost before dispatch and reconcile
actual token use afterward. Monthly caps are USD 10 for grades 9-11 and USD 15
for grade 12.

Strategy Council is explicit-only. Its five roles run sequentially, validate
citations against the shared evidence set, and preserve unresolved dissent.

## Safety and privacy

Essay ghostwriting and crisis detection have deterministic server-side
handling. Raw crisis text is not included in operational logs, and the
application does not send parent notification emails.

Student content is encrypted at rest. External model processing requires
explicit AI and cross-border consent, and provider payloads are redacted before
transmission. Export and deletion cover all student-owned records and files.

Human review is not available in this release.
