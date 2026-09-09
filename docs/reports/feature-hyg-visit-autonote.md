# 08 — The visit form becomes the clinic note (auto-note parity)

Branch `feature/hyg-visit-autonote`, off `origin/develop` at `def5dca`.
Worktree `C:\Users\beau\carein-wt\hyg-visit-autonote`.

> **NOT PUSHED — auto mode refused `git push`.** Everything below is committed on the
> branch in that worktree. Beau, paste these:
>
> ```bash
> cd "C:/Users/beau/carein-wt/hyg-visit-autonote"
> git push -u origin feature/hyg-visit-autonote
> gh pr create --base develop --head feature/hyg-visit-autonote \
>   --title "Make the visit form write the practice's own clinic note" \
>   --body-file docs/reports/feature-hyg-visit-autonote.md
> ```
>
> (`gh pr edit` is broken repo-wide — if the body needs changing afterwards, use
> `gh api -X PATCH`.)

---

## What this does

Filling in the CareIN visit now IS writing the clinic note. When the hygienist has said
which of the five hygiene visits this is, the `note` staged write renders **that visit
type's SOAP template** — the practice's own Open Dental auto note, re-stated as data — with
her graded chips tapped into its holes, the treatment block after it, and the typed-name
block last. Still unsigned.

The five: `Adult Prophy NP`, `Adult Prophy Recall`, `Child Prophy NP`, `Child Prophy
Recall`, `Perio Maint`. SRP, FMD/4346 and the laser notes are deliberately out, as the
brief says — they carry anesthetic, carps and quadrant detail this form has no fields for,
and half a template is worse than none.

---

## The two rules everything else follows from

**An unset chip renders as its label and a blank.** Exactly what their notes do today: a
hole nobody filled prints `Calculus: ` and the reader knows nobody answered. No default,
no "WNL", no "none recorded". An unfilled Adult Prophy Recall note is pinned line for line
in `autonoteParity.test.js`, and the test additionally asserts that none of the words a
default would have printed (`WNL`, `None`, `Good`, `Minimal`, `not recorded`, `N/A`)
appears anywhere in it.

**A wrong template is a wrong chart note, so an ambiguous appointment label is a question.**
`suggestVisitType` is narrow on purpose and returns `null` for most of a real schedule
(`Prophy 60`, `Adult Prophy` with `isNewPatient: null`, `Adult/Child Prophy`, `SRP UR`).
Null means the form shows nothing picked, offers no graded rows, and says why.

---

## Three places the practice's own template is deliberately NOT reproduced

All three are the same call: their template asserts something flatly, and CareIN cannot
know it is true.

| Their template | What CareIN writes | Why |
| --- | --- | --- |
| `P:  Return for Recall in 6  months` | `P:  Return for Recall in 6 months` when the slip carries an interval; `P:  Return for Recall` when it does not | Six months hardcoded is a recall interval nobody set, printed on a chart |
| `Polished, flossed, scaled as needed, FL2TX.` (child notes) | `, FL2TX` only when the `Fluoride` chip is on | "Fluoride was applied" on a visit where it was not is the same defect as inventing a grade |
| `Perio chart updated` (Perio Maint) | `Perio chart updated` / `Perio chart NOT updated` / `Perio chart updated: ` | Perio charting is H4 and is not built. CareIN has no way to see a perio chart |

Whitespace is also normalised: the export pads its holes with runs of spaces
(`STE:               HTE:`) because a person types into them. We fill them, so one space
after each colon is what reads correctly.

Two option spellings are corrected — `Inflamamtion` → `Inflammation` and `Advaced` →
`Advanced`. The parity test knows about exactly these two and fails on a third, so this is
a declared exception rather than a habit. **Plaque's fourth option is lower-case `none` in
their export and Bleeding's is `None`** — that difference is NOT tidied up. These strings
go verbatim into a legal record and a cosmetic change there is a change nobody asked for.

---

## Storage: no migration, and why that is the right answer

The slip is already **one jsonb column** on `hyg_visit`, validated through `HygSlipSchema`
on the way in and re-parsed on the way out. Five new fields go on it —
`visitType`, `visitTypeSource`, `noteFields`, `rtc`, `perioChartUpdated` — and the DDL does
not change at all. A `noteFields` jsonb column would have been a migration to reach the
same place the existing column already is.

**The load-bearing detail is that every new field carries a `.default()`.**
`visitStore.readSlip` reports a slip this build cannot parse as an EMPTY one — the honest
answer to "we cannot read what was stored". A *required* new field would therefore make
every visit saved before this branch, including one a hygienist is half way through filling
in right now, read back blank. `hyg-contract.test.ts` pins that with a slice-2 slip, key
for key: it still parses, it keeps every word somebody typed, it gains the new fields as
unanswered, `.strict()` still refuses a typo'd key, and `visitType: "srp_upper"` is still a
refusal.

`noteFields` is a `z.record` keyed by control id rather than fourteen named fields, matching
how `recordsStatus` already works: the set of rows is decided by the TEMPLATE, so a template
that gains a row must not need a schema change to store its answer.

---

## The form is generated from the template that prints the note

`controlsFor(visitType)` walks the same template `renderVisitNote` walks, in the same order.
No component holds a hand-written list of rows — a hand-written list is the one a template
change leaves behind, and that bug's shape is a chip she fills in that no note prints.
A test asserts both directions: every hole the practice's auto note has is offered as a row,
and every row offered is one the note prints.

Every row has a free-text suffix beside the chips. That is not an extra — their real notes
say *"Calculus: Slight-mod Lower ant and U post"*, and a form that took only the grade would
make every note worse than the one it replaced.

`STE`, `HTE`, `Perio Class` and `Pediatric Behavior` are MultiResponse in the export and are
multi-select here; picks come out in the template's own order, so HTE is `RD, XD` however
she tapped them. The parity test checks the multi/one flag against the export for all
fourteen controls.

---

## The signature block

`backend/config/hygStaff.js` — a config file, per office, sourced from the practice's own
two signature auto notes (`LW Signature`, `Raegan McGee `). These are staff, not patients.

- **A licence is never invented.** The roster is looked up by normalised name. A hit prints
  `Raegan McGee RDH #4251`; a miss prints the name ALONE — no blank `RDH #`, no fabricated
  number, and never somebody else's.
- **An office never gets another office's doctors.** An unknown office gets an empty list,
  never a fallback.
- The signing hygienist is `req.user.name`, the SSO display name — who is signed in. The
  route builds the block and hands it to the composer, which stays pure.
- Still **unsigned**. `Entered in CareIN by <actor>. Unsigned.` is the last line, and the
  existing "no composed line may say `signed`" assertion now covers the new lines too.

The doctor pick-list (`Dr. ___ performed periodic exam`) is a **response field**,
`doctorOptions`, derived server-side from the office on the stored visit — never a constant
in the client bundle, because a name compiled into a component is a name that eventually
renders for the wrong practice.

---

## Two judgement calls worth flagging

**1. Chief complaint reuses `patientConcerns` rather than adding a box.** The slip already
had one box for what the patient came in about; the templates call it the chief complaint.
It stays ONE field, relabelled with the note's own word and captioned "Prints on the note's
S: line". Two boxes asking the same question, only one of which reached the chart, is the
likelier bug. Same for `hygieneFindings` → `Findings`.

**2. A visit with no `visitType` composes the OLD generic note, not a refusal.** A hygienist
who has not said which visit this is still gets a note saying what she recorded. Choosing a
template for her would be choosing which sentences go in somebody's chart. Every existing
composer test passes unchanged because of this.

Two smaller ones: the routing slip's own **AAP perio classification** row stays where it
was and is now captioned to say it is the slip's, not the note's — the practice's `Perio
status` pick-list is a different scale, and collapsing them would be inventing a mapping.
And the templates have no radiographs or products slot, so `Radiographs taken:` is added
under `O:` and `Products dispensed:` under `P:` **only when non-empty** — a clean eight-tap
visit still renders the template exactly, and nothing a hygienist ticked is silently
dropped.

---

## The auto-pick, and where it runs

The suggestion is computed on the client from the appointment this page already fetched,
using the SAME `suggestVisitType` the backend parity tests state the whole mapping with —
one rule, not two. It only ever touches the **draft**:

- A GET creates no visit row, and auto-saving a suggestion would leave a visit behind for
  every card somebody glanced at. It is stored with her first real edit.
- A slip that already carries a `visitType` is returned untouched. Her answer is never
  re-derived from an appointment label, not even when they disagree.
- The form says `Chosen from the appointment type. Tap a different one if it is wrong.`
  Tapping any chip records `visitTypeSource: "manual"`.

The stored slip is what composes. A suggestion nobody accepted leaves `visitType: null`,
and a null composes the generic note — so the client-side suggestion is a form default, not
a decision the server takes on trust.

---

## preview === sent

Unchanged and now covered for templated notes: `payload.text === preview.join("\n")` is
asserted, the whole note is still printable-ASCII after `sanitizeForOd` (tested with smart
quotes and a middot pushed through a chip suffix), and the fingerprint is still taken over
the composed lines. Change a chip and the next stage recomposes; a stale confirm is still
`PREVIEW_CHANGED`.

`payload.visitType` was added so the row records WHICH template wrote its words. That meant
widening the strict `PAYLOAD_SCHEMAS.note` guard in `sendVisit.js` — as
`VisitTypeSchema.nullable().optional()`, **optional** because a row staged before this
branch has no such key and a strict schema would turn it into a refusal to send a note
somebody has already read and approved.

One UI fix fell out of the screenshots: a blank preview line was rendering as a
zero-height `<li>`, so the note she confirms ran together while the note landing in Open
Dental had paragraphs. The bytes were always the same; `previewLineClass` makes the shape
the same too, which is the half a person actually checks.

---

## Acceptance

| # | | |
| --- | --- | --- |
| 1 | Adult Prophy Recall, ~8 taps ⇒ template line for line | ✅ `SNAPSHOT: Adult Prophy Recall renders the practice template, line for line`, plus a snapshot per visit type |
| 2 | Chip + suffix renders `Calculus: Slight Lower ant and U post` | ✅ backend snapshot + `stores a grade and its free-text suffix together` |
| 3 | Unset chip ⇒ blank, never invented | ✅ `an unset chip renders as its label and a blank, and NEVER invents a grade` |
| 4 | Auto-pick: clean map, ambiguous ⇒ she picks | ✅ 10 clean cases + 9 ambiguous ones, plus the two UI tests |
| 5 | Child shows behaviour; Perio Maint shows Bone Loss | ✅ backend + UI, both directions |
| 6 | Signature from config, unsigned, licence when known | ✅ `hygStaff.test.js` (8) + the composer's `signed` assertion |

## Gates

| | |
| --- | --- |
| `node scripts/shard-runner.mjs` (4 shards) | ✅ 2384 pass, 0 fail |
| `node --check server.js` | ✅ |
| `pnpm run check` | ✅ clean, no `any` added |
| `pnpm run test` | ✅ 1390 pass, 99 skipped, 0 fail |
| `hyg-contract-bundle.test.ts` (byte-compare) | ✅ `contract.gen.cjs` regenerated with the pinned esbuild |
| Screenshots | ✅ 8, light and dark, under `docs/screenshots/hyg/` |

Screenshots: `hyg-note-01-recall` (pre-picked and filled — the "is this eight taps?" shot),
`hyg-note-02-unpicked` (nothing picked, and it reads as a question rather than a broken
screen), `hyg-note-03-perio` (sub/supra calculus, bone loss, and the perio-chart line),
`hyg-note-04-preview` (the composed note in the tray, with the signature block).

No real patient data anywhere: the fixture is PatNum 12827 in roland, patient names in
screenshots are synthetic, and the only real names are the practice's own clinicians in the
signature config.

## Not done, on purpose

- **SRP Upper/Lower, FMD/4346, LAPT/laser** — out of scope per the brief; a follow-up slice
  needs anesthetic, carps and quadrant fields this form does not have.
- **Doctor-exam templates** — the doctor's note, not the hygienist's.
- **No migration** — defended above. If a future slice wants these fields queryable rather
  than merely stored, that is a promotion out of jsonb and its own change.

## Files

New: `new-dashboard/shared/hyg/noteTemplates.ts` (the templates and the pure renderer),
`backend/config/hygStaff.js` + test, `backend/services/hyg/autonoteParity.test.js`,
`new-dashboard/client/src/features/hyg/visit/VisitNoteFields.tsx`,
`new-dashboard/tests/hyg-autonote{,-shots}.test.tsx`,
`docs/hyg-autonotes/autonotes.json` + README (the vendored source the parity test reads).

Changed: `shared/hyg/contract.ts` (five slip fields, `doctorOptions`),
`backend/hyg/contract.entry.ts` + `contract.gen.cjs`, `stagedWriteComposer.js`,
`routes/hyg/visit.js`, `sendVisit.js`, `HygVisit.tsx`, `RouterSlip.tsx`,
`StagedWritesTray.tsx`, `features/hyg/api.ts`, and six test fixtures that needed
`doctorOptions`.
