# Hygienist feedback round 1: note correctness, vocabulary, TC handoff availability

Branch `feature/hyg-feedback-round-1`, cut from `origin/develop` at `dd0e408`. The PR targets develop and is **not merged**. This round adds no migration, no Open Dental write path and no new Open Dental read. Staging fixtures only: roland 12827 and valley 7115. No real patient or staff name appears in this report.

> **The nine new visit-type templates are DRAFTS pending the practice hygienist's approval.** Their full text is in section B below. The picker labels each one "(draft)" until it is approved.

## A. Note correctness

### A1. Only the examining doctor

**The source.** `backend/config/hygStaff.js` `signatureBlock` appended every supervising doctor in the office, by looping over `supervisingDoctors(office)`. The route's `signatureFor` handed that block to the composer for every note.

**The fix, at that source.**
- `signatureBlock` takes `examiningDoctors`, which `signatureFor` reads from the **stored** slip's `noteFields.drs` (the `Dr. ___ performed … exam` pick). It prints only those doctors, matched against this office's config, and only this office's.
- If no doctor is picked, or the template has no exam (Perio Maint and the drafts), the note names no doctor and is otherwise unchanged and valid.
- If the author is also a picked doctor, they are still printed once.
- If a picked name is not in the office config, it prints as the name alone, never with another office's licence.

**Tests.** The `hygStaff` tests and the parity snapshots were updated. Each edit is labelled `RULING (feedback round 1)`.
- New cases cover: one doctor picked, none picked, a case or spacing mismatch, a duplicate pick, and a stranger name.
- A route-level test stages a note with a stored pick of one doctor and asserts the other two are absent.

### A2. Primary teeth as letters: the 102/109 evidence

**Where the numbers came from.** `client/src/features/hyg/visit/ToothPicker.tsx` (at develop `dd0e408`) stored a primary tooth as `PRIMARY_OFFSET (100) + index in [...UPPER_PRIMARY, ...LOWER_PRIMARY] + 1`:
- B is index 1, so it is stored as **102**;
- I is index 8, so it is stored as **109**.

The number goes over the wire as `teeth: [102, 109]` and is stored as-is. Only that client file knew how to turn 102 back into "B".

**Why it printed "#102".** Every other surface printed the raw stored number with a "#":
- the note and Router: `stagedWriteComposer.js` `teethLabel`, `item.teeth.map((t) => '#' + t)`;
- the TC handoff text: `tcHandoffClient.js`, `` `#${teeth.join(', #')}` ``;
- TC's checkout procedure lines and plan items: `routes/tc/checkout.js`;
- TC's screens: `CheckoutSidebar`, `HygieneTreatmentPanel` and `ReferralsPanel`.

The test `A2 evidence` pins `primaryToNumber('B') === 102` and `primaryToNumber('I') === 109`, and shows that the stored value, not the letter, is what those renderers received.

**The fix: one shared place.**
- `new-dashboard/shared/hyg/teeth.ts` now owns:
  - the encoding (`PRIMARY_OFFSET`, `UPPER_PRIMARY`/`LOWER_PRIMARY` in the same order, so stored values keep their meaning);
  - `toothLabel` and `primaryToNumber`;
  - the renderers `toothText` / `teethText` ("#30", "B") and `odToothText` (Open Dental's own tooth text, for existing treatment).
- Both backend contract bundles export it.
- `ToothPicker.tsx` and `lib/hyg/dentition.ts` re-export it, so there is no second copy. A test asserts the picker's functions are the shared functions.
- Every renderer listed above now calls it. So does the existing-treatment line, the compact existing-treatment rows, "Treatment identified today", and the TC referral letter.

**Tests.** These cover primary-only (`B, I`), permanent-only (`#3, #30`) and mixed (`#30, B`), each across:
- the note text, the Router text and the TC handoff preview;
- the TC intake's `suspectedTreatment`;
- TC's own checkout procedure lines;
- the TC contract bundle.

The note tests also assert that no `#1xx` survives anywhere.

### A3. The hygienist's full name and licence

- `hygStaff.js` now has a `HYGIENISTS` roster. Each entry has `fullName`, `credential`, `license` (which may be `null`) and `signIn` (the sign-in names and emails that identify her).
- `signatureFor` passes the signed-in **email** as well as the display name, so a short or different display name still finds her full entry.
- **It fails soft.** A `null`, blank or whitespace licence prints the full name ONLY: never `RDH #`, never a placeholder, never a guess.
- The two entries already in the config were kept unchanged. **No new names or numbers were added.** The practice's full list goes in this file when it arrives, as one entry per hygienist.
- **Tests** use a synthetic roster:
  - full name plus licence;
  - matched by email;
  - a missing licence prints the name only;
  - a blank licence prints the name only;
  - the shipped roster only ever has full names and digit-only licences.

## B. Vocabulary

- **Done today** adds **ADD PMT**, **Laser UR / UL / LL / LR** and **OFI**.
  - **Polish** is retired. It is hidden from the chips unless the slip already has it. A saved slip with Polish still shows it picked, still prints it on the Router and note, and re-saves unchanged, because `doneToday` is a free id list and the option stays defined with `retired: true`.
  - A test covers both the client and the schema round-trip.
- **Treatment codes.** Restorative adds **SSC**. It is a tooth item on primary and permanent teeth alike, and not whole-mouth. A test adds SSC on primary B (stored as `[102]`) and on #30.
- **Visit types and templates** add nine drafts, below.
  - The SRP quads share one shape, parameterised by quadrant: Q1 and Q2 come from `SRP Upper`, Q3 and Q4 from `SRP Lower`.
  - **Anesthetic** and **Inflammation** are *typed* rows, with no chips:
    - the export's Anesthetic list is a sentence builder (repeated bare "1", "2", "3"), useless as chips;
    - the Inflammation hole (spelled "Inflammaiton" in their export) has no control behind it at all.
  - **Total Carps** is a 1–12 chip row, verbatim from the export.
  - The parity test was extended with labelled exemptions:
    - a draft with no source (Sealant);
    - the two typed rows;
    - SRP's "Quad" hole, which the visit type itself answers.
  - Every other parity rule still applies to the drafts.
- **No database CHECK** pins any of these lists: the slip is jsonb and the treatment code is free text. **So no migration was needed.**

### Deviations from the source notes, for the hygienist to rule on

1. **SRP drafts drop two flat claims from the source.**
   - "neg aspirations, pt tolerated well" and "Procedure lasted 1 hour and 37 minutes" are lines the practice's template always prints.
   - A template cannot know either, so the draft leaves them for her to type.
   - The injection-site line ("PSA, MSA, ASA, 30 short" / "IA, LB, Mental, Anterior Infiltration, 30 short", with topical benzocaine 20%) **is** kept as the source has it. Keep it, make it typed, or remove it?
2. **SRP's "Perio charted"** uses the existing conditional "Perio chart updated" line. It prints only when she says so, the same as Perio Maint.
3. **Laser.**
   - The source's fixed "UR quad" became the Laser chips she tapped ("Quadrants: UR, LL").
   - The source's instruction line ("In addition to procedures and anesthetic used include:") is dropped.
   - "No adverse reactions. Post op instructions given. Laser safety glasses worn." is kept as a flat statement, as the source has it.
4. **FMD and 4346** both come from the practice's single `FMD/4346` note.
   - The A: and P: lines name which procedure it was.
   - The source's prefilled "RTC: 6-8 wks fine scale" became the ordinary RTC box.
   - The source also asks for Pediatric behavior, so it is kept.
5. **Sealant has no practice auto note.**
   - The draft states the procedure: "Teeth isolated, etched, rinsed and dried. Sealant placed and light cured. Occlusion checked."
   - The teeth go in the ordinary Findings box. A "Teeth sealed:" label was tried and removed in review: that box also reaches TC as areas of concern.
   - Should the sealed teeth have a field of their own?
6. **Fl2** is drafted from `Fluoride Varnish` ("5% sodium fluoride varnish applied"). If Fl2 should mean foam (the `Fluoride Foam` note, "1.23% acidulated phosphate 1 min foam disp tray"), the change is one line.

### The draft templates, full text (blank, as the hygienist first sees them)

#### SRP Quad 1 (source: SRP Upper)
```
S:  Patient presents for SRP appointment.  CC: 

O:  Reviewed medical history with patient.  Same
SRP needed due to bone loss: 

A:   STE:   HTE: 

Perio class: 
Perio chart updated: 
Anesthetic sites: PSA, MSA, ASA, 30 short. Topical anesthetic gel benzocaine 20%.
Anesthetic: 
Total Carps: 
Cavitron and hand scaled Quad 1
Calculus: 
Plaque: 
Bleeding: 
Inflammation: 

P:  Return for Recall

RTC: 
```

#### SRP Quad 2 (source: SRP Upper)
```
S:  Patient presents for SRP appointment.  CC: 

O:  Reviewed medical history with patient.  Same
SRP needed due to bone loss: 

A:   STE:   HTE: 

Perio class: 
Perio chart updated: 
Anesthetic sites: PSA, MSA, ASA, 30 short. Topical anesthetic gel benzocaine 20%.
Anesthetic: 
Total Carps: 
Cavitron and hand scaled Quad 2
Calculus: 
Plaque: 
Bleeding: 
Inflammation: 

P:  Return for Recall

RTC: 
```

#### SRP Quad 3 (source: SRP Lower)
```
S:  Patient presents for SRP appointment.  CC: 

O:  Reviewed medical history with patient.  Same
SRP needed due to bone loss: 

A:   STE:   HTE: 

Perio class: 
Perio chart updated: 
Anesthetic sites: IA, LB, Mental, Anterior Infiltration, 30 short. Topical anesthetic gel benzocaine 20%.
Anesthetic: 
Total Carps: 
Cavitron and hand scaled Quad 3
Calculus: 
Plaque: 
Bleeding: 
Inflammation: 

P:  Return for Recall

RTC: 
```

#### SRP Quad 4 (source: SRP Lower)
```
S:  Patient presents for SRP appointment.  CC: 

O:  Reviewed medical history with patient.  Same
SRP needed due to bone loss: 

A:   STE:   HTE: 

Perio class: 
Perio chart updated: 
Anesthetic sites: IA, LB, Mental, Anterior Infiltration, 30 short. Topical anesthetic gel benzocaine 20%.
Anesthetic: 
Total Carps: 
Cavitron and hand scaled Quad 4
Calculus: 
Plaque: 
Bleeding: 
Inflammation: 

P:  Return for Recall

RTC: 
```

#### Sealant (source: none)
```
S:  Patient presents for sealant appointment.  Chief complaint: 

O:  Reviewed medical history with patient.  Same

A:  Teeth isolated, etched, rinsed and dried. Sealant placed and light cured. Occlusion checked.
Findings: 

P:  Return for Recall

RTC: 
```

#### Laser (source: LAPT CO2 laser)
```
Laser Periodontal Therapy, bacterial reduction with CO2 laser.
Quadrants: 
1.5/20 HZ @ .7 watts, PW 100mm handpiece, perio insert with perio tip, 30 sec or less per tooth.
No adverse reactions. Post op instructions given. Laser safety glasses worn.

RTC: 
```

#### FMD (source: FMD/4346)
```
S:  Patient has irritated gum tissues causing bleeding and sensitivity.

O:  Reviewed medical history with patient.  Same
Inflammation/bleeding: 

A:  FMD needed to get gums to ideal health.

P:  FMD

STE:   HTE:   Cavitron and hand scaled full mouth, flossed and checked.

OH: 
Perio: 
Calculus: 
Plaque: 
Bleeding: 
Stain: 
Mallampati: 

Pediatric behavior: 

RTC: 
```

#### 4346 (source: FMD/4346)
```
S:  Patient has irritated gum tissues causing bleeding and sensitivity.

O:  Reviewed medical history with patient.  Same
Inflammation/bleeding: 

A:  4346 needed to get gums to ideal health.

P:  4346

STE:   HTE:   Cavitron and hand scaled full mouth, flossed and checked.

OH: 
Perio: 
Calculus: 
Plaque: 
Bleeding: 
Stain: 
Mallampati: 

Pediatric behavior: 

RTC: 
```

#### Fl2 (source: Fluoride Varnish)
```
S:  Patient presents for fluoride application.  Chief complaint: 

O:  Reviewed medical history with patient.  Same

A:  5% sodium fluoride varnish applied.

P:  Return for Recall

RTC: 
```


## C. TC handoff availability

**What Beau hit on staging.** The handoff, and its staging card, needed at least one "Treatment identified today" item. A visit whose only TC work was in the existing-treatment answers could not be staged or sent.

**Fix: refuse only when there is neither.** "TC-actionable" means an answer of ready to schedule, see the plan again, or cost questions. The set is defined once, as `EXISTING_TX_TC_ACTIONABLE` in `shared/hyg/existingTx.ts`.

| Where | Change |
| --- | --- |
| Composer, `tc-handoff` | Refuses only with no items AND no TC-actionable answer. Otherwise it stages with an **explicitly empty** list: payload `items: []` and the preview line "Treatment identified today: none". The preview prints a **fixed** line about the existing answers, never the answers themselves, because the handoff reads them at send. So it still cannot go out of date (the #281 ruling). |
| Stage route | Loads the stored existing-treatment answers for `tc-handoff` too. |
| `tcHandoffClient.buildIntake` | Re-checks the same rule **at send**, against the answers as they stand then. A handoff staged and then invalidated fails honestly, with nothing sent. With no items, `suspectedTreatment` is `''`, the existing items ride in `existingTx`, urgency is urgent if any existing item is marked "getting worse -> urgent" and preventative otherwise, and the category is `single_tooth` (deliberate, and pinned by a test). |
| `sendVisit` payload schema | `tc-handoff.items` no longer requires at least one item. The rule lives in `buildIntake`, which has the answers. |
| Checkout alert | It never required items. This is now pinned by a test, with a TC-actionable answer carried. |
| Day progress | `progressStore` adds one count query: TC-actionable dispositions per visit, office-scoped, our own table, with column names. `visitProgress` makes the tc step apply when items > 0 OR TC-actionable > 0. No existing test premise needed to change, and rows (a)–(g) are unchanged. |
| Tray | The card is stageable when the page's read shows a TC-actionable answer, and says why ("No new treatment today — it carries the existing treatment the patient wants to act on"). The empty copy now names both ways in. |

Tests:
- **Route level, through the real Send:** "ready to schedule" stages and sends with an empty treatment list. "Declined" alone is refused with `NOTHING_TO_STAGE`. The checkout alert goes with no items.
- **Pure tests** cover each of the three actionable answers, the three non-actionable ones, the re-check at send, urgency, category, and the progress step.

## Sample composed note (test data only)

This is Adult Prophy Recall. The slip has:
- an examining doctor picked;
- one SSC on primary B and I;
- one crown on #30;
- one existing item answered "ready to schedule".

It comes from the real composer. The hygienist is a synthetic roster entry with no licence yet, so she prints her full name alone. The doctor is a synthetic name, so they print alone too. With an office's configured doctor, that line reads `<Full Name> DDS #<licence>`, and it is the ONLY doctor line.

```
S:  Patient presents for recall appointment.  Chief complaint: Cold sensitivity upper right.

O:  Reviewed medical history with patient.  Same
    Radiographs taken: BW-4

A:   STE: WNL  HTE: RD #14  Polished, flossed, scaled as needed.  Dr. Sample Doctor performed periodic exam.  Findings: Light calculus lower anterior.

P:  Return for Recall in 6 months

Perio: 
Plaque: Minimal
Calculus: Slight Lower ant
Bleeding: 
Stain: 
Mallampati: 
RTC: 6 mo recall

Treatment identified today (2):
  B, I - SSC - Urgent - Restorative - Dx D - proposed
  #30 - Crown - O - Urgent - Restorative - Dx D - proposed

Existing treatment reviewed (1):
  #19 D2740 Crown - porcelain/ceramic -- no change; patient ready to schedule.

Sample Hygienist
Sample Doctor
Entered in CareIN by hygienist@carein.ai. Unsigned.
```

And the handoff preview for a visit with no new treatment and a TC-actionable answer:

```
Category: Other
Treatment identified today: none
Existing treatment answers go with it, as they stand when it is sent.
```

## Guardrails

- **No new Open Dental write or read.**
  - The note and Router still reach Open Dental only through the existing approved Send.
  - The fixture gate is untouched, and `hygNoOdWrites` is green.
  - The day-progress count is a SELECT on our own table.
- **Office and PatNum are server-derived.** The examining doctor comes from the **stored** slip, never from a request field.
- **No `SELECT *`.**
- **No new real patient or staff names** in code, tests, fixtures, this report, the PR or the commits. The doctor and hygienist names already in `hygStaff.js` were there before this round. New tests use "Sample Hygienist", "Pending Hygienist" and "Temp Hygienist".
- **Code checks.** TS strict, no `any`, `tsc` clean. Both contract bundles were regenerated with the pinned esbuild, and the bundle byte-compare test passes.
- **Changed expectations.** Existing test expectations changed only where A, B or C requires. Each one is labelled `RULING (feedback round 1)`:
  - **`hygStaff.test.js`:** examining-doctor rows.
  - **`autonoteParity.test.js`:**
    - The examining-doctor snapshot lines.
    - The fixture's doctor pick is now a configured name.
    - Draft and typed-row exemptions.
  - **`hyg-existing-tx-compact.test.tsx`:** "A" not "#A".
  - **`hyg-visit.test.tsx`:** the empty handoff card's copy.

## Review

A fresh-context reviewer ran two rounds.

**Round 1: no critical findings, 1 HIGH, 4 MEDIUM.**
- **H1, fixed.** A doctor picked on an exam template survived a switch to Perio Maint or an exam-less draft, because switching the type keeps the slip's answers. The doctor would then have printed in the signature block.
  - `signatureFor` now reads the pick only when the stored visit type's template has an exam.
  - The regression test covers Perio Maint, SRP Quad 1, Laser, Fl2 and no type, and fails without the fix.
- **M1, fixed.** The Sealant draft's "Teeth sealed:" label sat on the hygiene-findings box, which also reaches TC as areas of concern. It now prints the ordinary "Findings:" line.
- **M2, made deliberate.** An existing-treatment-only handoff files as `single_tooth`, the same as a restorative case. This is commented and pinned.
- **M3, flagged, not changed.** The drafts' flat statements are listed in "Deviations from the source notes" above. They are drafts, labelled so in the picker.
- **M4, noted.** The day card counts stored answers, while send builds from items that pass the handoff schema. No path with well-formed data was found where they disagree, and if they ever did, the send refuses honestly.
- **LOW:**
  - **Fixed:** the TC value-engineering panel prefixed Open Dental tooth text with "#", so a primary tooth printed as "#B".
  - **Left:** the referral *edit* boxes show a stored primary tooth as its number. These are input fields, not chart text, and a follow-up should parse letters there.
  - **Dormant until the practice sends emails:** the roster's email aliases.

**Round 2:** approved, with no critical or high findings. It confirmed the H1 guard cannot drop a legitimate examiner: it passes the pick exactly when the template prints a "Dr. ___ performed … exam" clause. It also confirmed the M1, M2 and "#B" fixes.

## Tests

```
backend  node --test                          tests 4308, pass 4305, fail 0, skipped 3 (full run before the review fixes);
                                               hyg + tc + config + test/ 1839/1839 after them
           feedbackRound1.test.js              16  teeth (evidence, 3 selections x note/Router/handoff/TC), examining
                                                   doctor, drafts, laser quads, Polish, handoff without items (C),
                                                   progress, category, Sealant findings
           hygFeedbackRound1.test.js           5   route-level C (stage + Send, refusal, checkout alert), A1, H1 regression
           hygStaff.test.js                    18  (rulings labelled; A1 + A3 cases added)
           autonoteParity.test.js              27  (rulings labelled; every draft under the parity rules)
dashboard pnpm run check (tsc)                 clean
          pnpm run test                        Test Files 194 passed | 39 skipped; Tests 2966 passed | 225 skipped
           hyg-feedback-round-1.test.tsx       10  one mapping, B/I + SSC on primary and #30, Done-today chips, Polish
                                                   kept when saved, drafts, handoff card both ways
```

## For Beau

1. **Approve or edit the nine drafts.** Each deviation above needs a yes or no from the hygienist. The drafts are usable today and labelled "(draft)".
2. **Send the full names and licence numbers**, plus each hygienist's sign-in email, for `HYGIENISTS` in `backend/config/hygStaff.js`. Until then, an unknown or short sign-in prints the name she signed in with, never an invented licence.
3. **A staged note does not re-stage itself after a slip edit.** That includes changing the examining doctor. This is **pre-existing**, as confirmed in review round 2. Only a perio chart un-stages on save. A staged note or Router keeps its words until it is staged again, and that was already true of every slip field. This round adds one more such field, the examiner. Closing the gap means a slip digest on the note and Router, like the existing-treatment one. I suggest a follow-up for that, not a change in this round.
