# Field confirm — checking a scanned read against the page

**Written for: Beau, plus whoever reviews this PR.**

---

## 0. The case

The first real scanned EOB was a category-subtotal layout: it stated payment **only** at
benefit-type subtotals, never per line. The read promoted each line's **covered** amount
into **paid**, and one line rendered a fabricated **$1,229.00 paid** — a figure nowhere on
the page, which understated what the patient owed. Claim-level totals were read correctly,
the existing non-summing warnings fired, and approve was blocked.

So no money moved. The refusal worked.

The numbers on screen were still invented, and a refusal a biller cannot check against the
paper asks her to trust a reader she cannot see. **A refusal is not a correct read**, and
that gap is what this slice closes.

### Why it was structural, not a prompt failure

`paidCents` was a **required integer**. The model had no way to say "this document does not
state a per-line payment", and a required integer cannot express absence — so it filled the
field with the nearest number on the row. Any prompt wording sits on top of a schema that
left one legal answer, and that answer was wrong.

---

## 1. Pre-flight

`origin/develop` carries the prod EOB stand-up commit — `4e0efc7` *"Say when this deployment
cannot read a scanned document"*, merged via PR #205. Verified by content, not just by
subject: `EOB_OCR_UNAVAILABLE` is in `routes/rcm/eob.js`, and `ocrStatus()` returns
`configured` / `reachable`. Branch cut from `b67d47d`.

---

## 2. Part 1 — the read stops inventing numbers

### The schema

`procedures[].paidCents` becomes `type: ["integer", "null"]`, still **required**. Dropping
it from `required` would let the key go missing, which is indistinguishable from a model
that forgot to look; null is an *answer*.

### The prompt

A new rule block headed **COVERED IS NOT PAID**, which names all four columns a layout might
print — `"allowed"`, `"covered"`, `"eligible"`, `"approved"` — so the model cannot reason
that only one of them was meant. It names the subtotal layout explicitly, forbids spreading
or dividing a subtotal across the lines beneath it, and forbids filling a null to make a
total reconcile.

### The coercion

`intOrNull` beside the existing `int`. `int()` answers *"give me a number whatever happens"*,
which is right for a billed amount — a missing one is 0 and 0 is harmless. It is wrong where
absence is data: 0 asserts the plan paid nothing for this line, which is a claim about a
patient's balance.

There is **no fallback to `allowedCents`** anywhere on the path, and the test asserts the
specific value `122900` never reappears as paid.

**A stated zero survives as zero.** "The plan adjudicated this line and paid nothing" and
"nobody printed a figure" are different facts, and flattening them would make a denial
indistinguishable from a silence.

### The arithmetic

`Σ(line paid)` over an unstated figure is **not a sum**. The old `reduce((n, p) => n + p.paidCents, 0)`
coerces null to 0 and then "discovers" that the lines do not reach the claim total —
reporting `paid_total_mismatch`, which says the printed numbers disagree and sends a biller
to re-read a column that is correct.

So the two cases are separated:

| Situation | Reason raised |
| --- | --- |
| Any line states no payment | `line_paid_not_stated` (new) |
| Every line states one, and they do not add up | `paid_total_mismatch` (unchanged) |

`line_paid_not_stated` is **annotating, not blocking**. The document is not wrong — a payer
is allowed to print payment at a subtotal — and what keeps the money safe on these documents
is the confirm gate below, not a review reason she cannot clear. Blocking would withhold the
claim a second time for the same fact and name a cause she cannot remove. Pinned by a test,
because `isBlockingReason` defaults anything unlisted to blocking.

---

## 3. Part 2 — the schema

### `rcm_procedure_lines.paid_cents` becomes nullable

`DEFAULT 0` **stays**. The ERA path always supplies a per-line payment — an 835 states one by
construction — so the default only serves a caller that omits the column, and turning that
into a null would mean "unstated" when the truth is "not supplied". That is the exact
ambiguity this slice exists to remove.

### `rcm_eob_field_confirmations`

| Column | Notes |
| --- | --- |
| `confirmation_id` | uuid PK |
| `office_id` | `OFFICE_CHECK`, like every RCM table |
| `batch_id` | → `rcm_payment_batches`, CASCADE. **The check is the row's home**, even for a line-scoped field: the thing being established is "this check has been read correctly", and it makes the whole confirm state one indexed read |
| `claim_id`, `line_id` | NULL for a check-level field; the scope CHECK enforces the combination |
| `field` | CHECK against `CONFIRMABLE_FIELDS` |
| `state` | `confirmed` \| `corrected` |
| `extracted_cents` | **What the read said, pinned at the moment a person looked.** NULL is meaningful — it records that the extraction stated nothing, so "the machine said nothing and she typed 0" and "the machine said 0 and she agreed" are distinguishable rows |
| `confirmed_cents` | What she says it is. NULL = she read the page and it genuinely states nothing |
| `confirmed_by` | → `rcm_user_map`, **NOT NULL**: a confirmation with no author is not one |
| `confirmed_at`, `created_at`, `updated_at` | |

Four constraints do real work:

- **scope** — `check_total` may not carry a `claim_id`; a `line_` field must carry both. Without
  it, a row exists that the accessor would have to guess the meaning of, permanently, about money.
- **state agrees** — a `confirmed` row whose value *differs* from the extraction, or a `corrected`
  row whose value *matches*, is refused. Otherwise the word and the arithmetic come apart, and
  "corrected by …" appears under a figure nobody changed. Uses `IS DISTINCT FROM`, so null
  compares as a value.
- **unique, `NULLS NOT DISTINCT`** — load-bearing (PG15+). Under the default, `(batch, NULL, NULL,
  'check_total')` does not conflict with itself, so every confirmation of the anchor would insert
  a new row and the accessor would read one of N arbitrarily.
- **the vocabulary CHECK**, mirrored from `rcmVocabulary.CONFIRMABLE_FIELDS` and drift-tested.

**Nothing overwrites the extraction.** No statement in this slice updates `rcm_claims`,
`rcm_procedure_lines` or `raw_extracted_json`. History is `audit_log`, which is append-only
by grant; this table holds current state and is upserted. A second history here would be a
second thing to keep honest.

The GRANT block is in the same migration, role-guarded, `SELECT, INSERT, UPDATE` — **no
DELETE**, because a confirmation is never withdrawn, only superseded.

`down()` **refuses** rather than silently creating an inconsistent database: it will not narrow
the review-reason vocabulary over claims carrying `line_paid_not_stated`, and it will not
restore `NOT NULL` over lines with an unstated payment.

### The seven confirmable fields

`check_total`, `claim_total_paid`, `line_paid`, `line_billed`, `line_allowed`,
`line_deductible`, `line_copay`.

Exactly the figures that decide money movement or a patient's balance. A misread procedure
code or service date is a different problem with a different remedy — the match refuses to
pair a line it cannot find in the chart, and says so. Adding them here would add clicks
without making any figure safer, which is how a review step becomes something people route
around.

---

## 4. The accessor — one place decides which number is real

`backend/services/rcm/confirmedFigures.js`.

Four surfaces need the answer — the confirm screen, the match, the workbench verdict, the
approval gate — and four hand-written joins would diverge the first time one was edited.
Two screens disagreeing about a dollar figure is the same class of defect as the fabricated
$1,229.00, so there is exactly one function that decides, `figure()`.

**Three outcomes on two axes**, and collapsing them is how the bug happened:

| `stated` | `confirmed` | Means |
| --- | --- | --- |
| false | false | the read found nothing, nobody has looked. Screen says "Not stated" |
| false | true | **a person read the page and there is genuinely no figure there.** A real answer the gate accepts — demanding a number would force an invention |
| true | source `corrected` | a person typed a figure that differs from the read |

`cents` is null whenever `stated` is false. Never 0 as a stand-in.

**No I/O.** It is a pure mapping over rows the caller already read, so the gate can
re-evaluate inside its own transaction and a test can drive it with no database.

Two static guards, and they are deliberately different:

- **Exactly one file READS the table** — the accessor. The invariant is about who gets to
  *answer* "which figure is real", and only a reader answers that.
- **Exactly one file WRITES it** — the confirm route. The write stays out of the accessor so it
  keeps its no-I/O property, but there must be one writer or two routes could record a
  confirmation with different ideas of what `state` means.

The scan looks for the table after `FROM`/`JOIN`/`INSERT INTO`/`UPDATE`, not for the name —
a comment naming the table is signposting that should be encouraged, and a scan that banned
it would teach people to describe the table without naming it.

`requiredFields` is **derived from the rows**, not a maintained list: a claim added by a
re-extraction is covered by construction.

---

## 5. The gate — two conditions, OCR-sourced checks only

Added to `CHECKS` in `approvalGate.js`, so they appear on **every** checklist in
`CHECK_ORDER`. They pass unconditionally for an 835 and for a text-layer PDF.

| Condition | Fails when |
| --- | --- |
| `FIELDS_CONFIRMED` | any money field on this check is unconfirmed; detail names the count |
| `CONFIRMED_SUMS_TO_CHECK` | the confirmed claim totals do not equal the cheque; detail names the difference in dollars |

**Present rather than omitted on the 835 path.** A condition that appeared on some checks and
not others would read as a missing check.

**Why a gate condition and not a blocking review reason.** A review reason says something
about the *document* and is cleared by disposing of the claim. This says a *person* has not
done a piece of work yet, and is cleared by doing it. In the checklist, the refusal names the
confirm step; as a review reason it would name a document property she cannot change.

**EXACT, no tolerance.** The extraction path allows a few cents of slack, which is right for a
read judging itself. This is a person reading a cheque and typing what is printed on it, so a
cent nobody can account for is a cent nobody can account for.

**An unstated total makes the sum unknowable, not zero** — `comparable: false`, and the
refusal says "nothing can be added up yet" rather than naming a difference computed from a
missing value. A difference we invented is one a biller would go looking for on the page.

One division of labour worth stating: an *unconfirmed but extracted* anchor still adds up,
using the best figure available, and `FIELDS_CONFIRMED` is what withholds the check. Making
the sum refuse as well would show two failures for one piece of undone work, and the second
would name arithmetic that is fine.

`loadForApproval` reads the confirmations and the provenance **inside the same transaction**,
so a screen that showed "all confirmed" a moment before somebody corrected a figure cannot
get a claim past the gate. Both `previewApproval` and `approveRemittance` spread `...loaded`,
so neither could be wired and the other forgotten.

`CLAIM_TOTALS_AGREE` also stopped coercing: an unstated line payment now produces *"3 line(s)
state no payment of their own"* rather than *"claim 139100, lines 0"*. The claim is refused
either way; what changed is that the sentence is true.

---

## 6. The confirm route

`GET /api/rcm/field-confirm/:batchId?office=…` · `POST` the same path.

**The server decides what was extracted.** A request carries a field and a figure, never the
extracted value it is compared against — that is read from the extraction rows and `state` is
derived from the comparison. A client that could supply both sides could file a correction as
an agreement, and the "corrected by" line would never appear over a changed number. There is
a test that sends both and asserts the lie is ignored.

**`null` is a legal figure; an omitted key is not.** Recording "the page says nothing" on a
field nobody looked at is the same class of lie as inventing a number for it.

**All or nothing.** One bad field refuses the whole request. A partial write would leave a
line with four figures confirmed and one silently not, under a success toast, with an
outstanding count that agreed with the database and disagreed with the screen.

**On `rcm.write`**, and deliberately not one of the mount's read-tier exceptions: confirming a
figure is what lets money reach a chart, so it sits with approving.

Refusals: `UNKNOWN_FIELD`, `FIELD_SCOPE`, `CLAIM_NOT_ON_CHECK`, `LINE_NOT_ON_CLAIM`,
`FIGURE_MISSING`, `FIGURE_NOT_AN_INTEGER`, `FIGURE_NEGATIVE`, `DUPLICATE_FIELD`, `NO_FIELDS`,
`TOO_MANY_FIELDS`, `NOT_A_SCANNED_CHECK` (409), `BATCH_NOT_FOUND` (404). One audit row **per
field**, because "she confirmed this line's five figures" and "she corrected the paid amount
on line 3" are different events.

Two office-scoped reads rather than a join for the batch's claims, following
`approvalGate.loadForApproval` — every read in this module is a flat office-scoped SELECT,
and the fake database enforces it.

---

## 7. The screen

`/rcm/remittances/:id/confirm`, registered above `/rcm/remittances/:id` (wouter matches in
order).

**The anchor is the first line.** The cheque total, large, with the payer under it — and it is
confirmable and correctable like any other field, because the biller is holding the paper.

**No invented confidence.** The brief asks for `read confidently / uncertain / not stated`.
There is no per-field confidence in this system: the reader gives **one mean word confidence
for a whole document** and the extraction model gives a **per-line** confidence, which already
reaches her as an `uncertain_line:N` review reason on the check page. Neither is a number
about an individual amount.

So the brief's own escape hatch applies — *"if the OCR gives no per-field confidence, the
honest framing is 'these came from the scan — check them'"* — and the states are
**From the scan · Not stated · Checked · Corrected · Not on the page**, under a caveat that
says where they all came from. Nothing on this screen prints a percentage, and a test asserts
that.

**The trail, in a sentence**, under the figure for as long as it exists:

> corrected by Jo Biller from the page image — the scan read $1,229.00

**No dead button.** There is no disabled primary at all. Until the work is done the screen says
what is left (*"6 figures still to check"*, or *"…they do not add up to the check yet"*), and
the single primary appears only when it is done.

**Teaching empty state** for an 835: *"Nothing to check by hand — this check came in as a file
the computer could read directly."*

**Images are evidence, not controls.** The document panel is an iframe over the existing
audited, office-scoped `/uploads/:id/document` proxy — the container is private, shared-key
auth is off, no SAS token is minted, so the bytes can only reach the browser that way.
Nothing on it is clicked to change a figure and no colour is drawn over it. Amber appears
exactly once on the whole screen, on the difference, because red and amber are reserved for
disagreement.

### Addendum item 1 — per-line crops

**Not built, and not faked.** The stored OCR result carries **no geometry**:
`documentOcr.summarize` keeps `text`, `pages`, `meanConfidence`, `words`, `model` and
`elapsedMs`, and discards the `polygon` on every word and line Azure returns. The addendum
rules out re-running OCR to recover a box, so the fallback applies: the whole page, with the
selected row scrolling the viewer to it (`#page=N`, with the frame keyed so a PDF viewer
actually re-navigates).

`region` is on the wire as an explicit `null` — the seam a later slice fills — so a client can
tell "there is no crop" from "this server does not say".

**Storage cost of adding geometry**, as the addendum asks. `prebuilt-read` returns a
`polygon` of 8 floats per word and per line. A one-page EOB runs ~80 words; a dense multi-page
remittance ~250 words/page. Storing line-level polygons only, as JSON on `rcm_procedure_lines`
or in `raw_extracted_json`: **~60–120 bytes per line**, so ~1 KB for a typical claim and
~20 KB for a 20-page bulk check — noise beside the PDF itself, which is already stored. Word
level would be ~15× that and buys nothing this screen needs. **Recommendation: store line
polygons only, when Part 1 next touches the read path.**

### Addendum item 2 — the check snapshot slot

Reserved beside the anchor, typed as `checkImage`, and it **renders nothing at all** today —
not a placeholder, not an upload prompt, because an empty frame inviting an action that does
not exist is a dead end. A test pins both halves: absent when null, rendered when present.

---

## 8. Budget math

Measured by the constitution sweep in `rcm-smoke.test.tsx`, which walks to the screen and
counts prose words (names, amounts, dates and codes struck out as "the work").

| Screen | Measured | Budget | Note |
| --- | ---: | ---: | --- |
| **Check the figures against the page** | **161** | **170** | New. Measured figure rounded up to the next ten, per the file's own rule |
| Approve | 239 | 240 | Was 230 |

**The confirm screen came in at 186 first.** The 25 words were the same instruction printed
twice — the caveat at the top and the row at the bottom both said "work down the list, each
one is either right or you type what the page says". Cutting the duplicate is why it fits;
the budget was not raised to accommodate it.

**Approve rises 230 → 240**, and the nine words are two checklist rows. The gate now emits
`FIELDS_CONFIRMED` and `CONFIRMED_SUMS_TO_CHECK` on every checklist, including the electronic
checks in the smoke world where they pass, and the approve screen renders the conditions the
gate sent. The rows are load-bearing — a condition appearing on some checks and not others
would read as a missing check — so the ceiling moved, which is the documented escape hatch
and a reviewable line in this diff.

The confirm screen reports **0 primary buttons** in the inventory, which is correct: in its
worst case (work outstanding) there is deliberately nothing to press, and the one primary is
a `Link` that appears only when the screen is finished.

---

## 9. Mutation proofs

Both guards the brief names, plus the touched expectations.

### Guard 1 — covered never becomes paid (9/9 caught)

| Mutation | |
| --- | --- |
| paid coerced back to an integer (the original bug) | ✅ |
| paid falls back to the COVERED amount | ✅ |
| `intOrNull` invents a zero for an absent value | ✅ |
| `intOrNull` invents a zero for a malformed value | ✅ |
| schema reverts to a required integer | ✅ |
| the prompt drops the COVERED IS NOT PAID rule | ✅ |
| unstated lines summed as zero, reporting a false mismatch | ✅ |
| `line_paid_not_stated` becomes blocking instead of annotating | ✅ |
| a stated zero payment flattened to "not stated" | ✅ |

### Guard 2 — the sum-to-check gate (11/11 caught)

| Mutation | |
| --- | --- |
| sum gate always passes | ✅ |
| a tolerance is introduced on the anchor | ✅ |
| an unstated claim total summed as zero | ✅ |
| the sum taken over the EXTRACTED figure, ignoring corrections | ✅ |
| an incomparable sum reports a difference it never computed | ✅ |
| confirm gate always passes | ✅ |
| OCR provenance no longer triggers the confirm step | ✅ |
| an 835 dragged into the confirm step | ✅ |
| only the check total required, not the line fields | ✅ |
| a row outside the vocabulary trusted as a confirmation | ✅ |
| unstated line payments summed as zero in `CLAIM_TOTALS_AGREE` | ✅ |

**Two mutations initially survived, and both found real gaps rather than test gaps.**

1. *`line_paid_not_stated` becomes blocking* — nothing pinned the verdict, and
   `isBlockingReason` defaults anything unlisted to **blocking**. One edit away from silently
   withholding every remittance from a payer who prints subtotals. Test added.
2. *a row outside the vocabulary is trusted* — unobservable through `figure()`, because lookups
   are built from the vocabulary and an unknown key is one nothing ever asks for. The guard is
   on the **structure**, so it is now asserted against the index directly.

### Front-end

Four mutations on the confirm screen's copy and state handling, all caught (banner never
rendered, `undefined` treated as "no reader", cap printed for a rail that cannot run, copy
reverting to blaming the file) — carried over from the parent slice's guards, which this one
did not disturb.

---

## 10. Data wants

Things this slice worked around, in the order I would fix them.

1. **Per-line OCR geometry** (§7). The one thing that would let the screen show a biller the
   exact strip of paper a figure came from instead of a whole page. Cheap to store, and the
   read path is already being touched.
2. **A per-field confidence**, or an honest statement that there will never be one. Today the
   screen asks a person to check every money figure equally, because it has no basis for
   saying which ones deserve a harder look. `prebuilt-read` gives word-level confidence — if
   the extraction recorded which words a figure came from, a genuine per-figure confidence
   would follow, and the "check them all" caveat could become "check these three".
3. **The check's own image.** The slot is reserved (§7) and the biller is holding the cheque;
   a photo of it beside the anchor would make the one figure everything reconciles to
   verifiable on screen rather than from memory.
4. **`lineDecisions` reading through the accessor.** The verdict and the workbench still read
   the extraction rows directly. That is safe today — the gate blocks an OCR-sourced check
   until every money field is confirmed, so a null or an unconfirmed figure cannot reach
   posting — but it is safe by *ordering*, not by construction, and the accessor exists
   precisely so it could be by construction.

---

## 11. Gates

| Gate | Result |
| --- | --- |
| `pnpm run check` (tsc --noEmit) | ✅ clean |
| `pnpm run test` (vitest) | ✅ **2013 passed**, 130 skipped, 0 failed |
| `node --check server.js` | ✅ |
| `node scripts/shard-runner.mjs` (what CI runs) | ✅ **2794 tests, 2791 pass, 0 fail**, 3 skipped |

New tests: 10 extraction, 4 vocabulary, 15 accessor, 16 gate, 24 route, 29 screen, 4 shot dumps.

**No Open Dental writes anywhere in this slice.** `rcmNoOdWrites.test.js` and
`eobNoOdImports.test.js` both pass; nothing added here imports an OD module.
Review-then-send is untouched, the W-16/D-17/Q2 blocks are byte-untouched, office keys never
render, and machine slugs and routes are additive only.

---

## 12. Screenshots

`docs/screenshots/rcm-eob-field-confirm/` — four states, 1280 wide, light and dark.

| Shot | Shows |
| --- | --- |
| `fc-01-read-from-the-scan` | a figure read off the scan, with both answers offered |
| `fc-02-not-stated` | **"Not stated"** for Paid, beside **$1,229.00** as Covered — the two facts the bug conflated |
| `fc-03-corrected-with-trail` | *"corrected by Jo Biller from the page image — the scan read $1,229.00"*, and the single primary |
| `fc-04-does-not-add-up` | the anchor, and **"$1,045.00 apart"** |

All synthetic: invented payer "MERIDIAN MUTUAL DENTAL", invented patient "Synthetic, Patient
A", invented amounts. The document panel renders as an empty frame in a static dump because
the iframe has no server to fetch from — in the app it is the PDF.

---

## 13. Before merging

- This is the first slice to make `rcm_procedure_lines.paid_cents` nullable. The migration
  has been run against the schema in CI's ephemeral Postgres by the standard gate, but **not**
  against staging data. Worth a staging migrate + a look at the EOB screens before prod.
- An OCR-sourced check now **cannot be approved** until a person has worked the confirm step.
  That is the intent, and it is also a change in what a biller has to do — worth saying out
  loud to whoever handles the scanned payers before this reaches them.
- `line_paid_not_stated` will start appearing on real claims from the first subtotal-layout
  EOB after deploy. It is annotating, so it widens review and blocks nothing.
