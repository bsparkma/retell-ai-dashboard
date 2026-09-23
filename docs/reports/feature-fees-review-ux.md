# Fee Schedule module — review UX: inline editing, warning navigation, sections

**Branch** `feature/fees-review-ux` (off `origin/develop`, carrying merged #192, #195 and #197) ·
**Worktree** `C:\Users\beau\carein-wt\fees-review-ux`

Slice 1 parsed a payer file. Slice 2 showed it. Slice 3 wrote it into Open
Dental. This slice is about the part in between: a person reading 400 rows and
deciding whether the numbers are right.

**No new Open Dental surface.** `odFeesWrites.js` is untouched, and
`feesNoOdAccess.test.js`'s one-file allow-list did not grow. The only change the
posting path sees is *which number* it writes.

---

## 1. The problem this slice is answering

The commonest warned row in the corpus is the multi-column one:

```
D2740   Crown - porcelain/ceramic   1,150.00   920.00   805.00
```

The parser takes the first amount and says so. The office knows their contract
is Tier 2. Until now they had two answers, and both were bad:

- **Accept** — post $1,150 into a live practice, knowing it is wrong.
- **Exclude** — leave a crown with no fee in the schedule.

Typing $920 is the answer anyone would actually want, and it did not exist.

Alongside that, a 400-row schedule as one flat list has no way to find the four
crowns, no way to say "restorative is checked", and no way to reach the six
flagged rows without scrolling past the clean ones.

---

## 2. The parsed value is never overwritten

The override is a **new column**, `fees_import_row.edited_fee_cents`.
`fee_cents` keeps saying what the file said, forever, and `raw_line` keeps the
line it said it on.

That is not caution — it is the module's founding complaint. The reference
importer this was ported from made its interpretations in place and in silence,
and nobody could reconstruct what the payer had actually sent. After an edit
there are three facts on the row and all three survive:

| column | what it holds |
| --- | --- |
| `fee_cents` | what the file said |
| `edited_fee_cents` | what a person says it should be |
| `decided_by` / `decided_at` | who said so, and when |

So the screen can always show **“edited from $1,150.00 · manager@carein.ai”**,
and the audit trail can always answer what the file contained before somebody
changed it.

### The pair CHECKs, and why both directions

```
decision =  'edited'  ⇒  edited_fee_cents IS NOT NULL AND >= 0 AND <= 2,000,000,000
decision <> 'edited'  ⇒  edited_fee_cents IS NULL
```

The first stops an `edited` row with no value, which would post the parsed
number while the screen said it had been corrected — a silent revert of
somebody's correction.

The second is the one that is easy to leave out and costs more. Without it a row
could carry an override while sitting at `accepted` or `pending`, and every
reader — the job, the totals, the confirm dialog — would have to decide for
itself whether that counts. They would not all decide the same way.

`>= 0`, never `> 0`: **$0.00 is a real fee** meaning not covered, bundled, or no
charge. The reference discarded every zero with a `> 0` guard and this module
has spent four slices not doing that.

**No new table, so no GRANT block.** A grant follows the table, not its columns.
The repo's rule is that a CREATE without a GRANT is a defect; an ALTER without
one is correct, and the migration says so rather than leaving the next reader to
check.

---

## 3. One function decides what gets written

`backend/services/fees/effectiveFee.js` holds the rule in both forms:

```js
EFFECTIVE_FEE_CENTS_SQL = "CASE WHEN decision = 'edited' THEN edited_fee_cents ELSE fee_cents END"
effectiveFeeCents(row)  // the same rule, per row, in JavaScript
```

Four things need the answer and they do not get it the same way — the job
(per row, in JS), the summary totals (a SQL `SUM`), the confirm dialog (from
those totals), and the audit row (likewise). Written out at each site, the
plausible defect is not that one is wrong today; it is that somebody adds a
fifth decision later and updates three of the four. **The confirm dialog would
then state a total the job does not write, and the person approving it would be
approving a number that never existed.** That failure looks like
review-then-send without being it.

Two smaller decisions inside that file:

- **The SQL is a `CASE`, not `COALESCE(edited_fee_cents, fee_cents)`.** The
  COALESCE computes the same answer today *only* because the pair CHECK exists
  somewhere else. The CASE is correct on its own terms, and states the rule a
  reader is trying to learn.
- **An `edited` row with no value throws.** The CHECK makes it unreachable; if
  it ever were reachable, falling back to the parsed value would write the
  number somebody corrected away. The job's catch turns the throw into
  `post_failed` with the reason, which is a state somebody can act on.

The client has a three-line mirror of the JS form, because the preview must
render the same number *before* a post exists to be asked. It is deliberately
trivial for that reason.

---

## 4. `edited` resolves a warned row, and it got that for free

The posting gate is unchanged:

```
blocking  ⟺  jsonb_array_length(parse_warnings) > 0 AND decision = 'pending'
```

`edited` is not `pending`, so it resolves. Listing the resolving decisions
explicitly instead would have meant a fifth decision silently blocking every
batch until somebody remembered to add it to the list.

Re-deciding is ordinary: `edited → accepted`, a new edited value, and back to
`pending` are the same statement with different parameters. The override is
cleared by every decision that is not `edited`, in the statement *and* in the
schema.

---

## 5. Reviewing 400 rows

**Sections, by CDT category.** `D0 Diagnostic` … `D9 Adjunctive`, one shared
constant (`features/fees/cdt.ts`) read by the headers, the jump menu and the
counts — so the menu can never name a section that is not on the page, and a
section can never render with no way to reach it.

The bucket is the **leading digit**, which is how CDT is defined, how Open
Dental groups its own fee windows, and how every payer PDF in the corpus prints.
That means it is a substring rather than a maintained range table: a code the
ADA publishes next January files itself correctly on the day it appears. Two
buckets hold more than their name suggests (D5 also holds maxillofacial
prosthetics, D6 holds implants *and* fixed prosthodontics); the labels say both
halves out loud rather than pretending to a precision a range table would not
keep.

**File order is preserved inside a section.** The row order is evidence — a
reader checking against the PDF on their desk finds the row where the PDF has
it. Sections sort by code; rows inside one never re-sort.

**The warning chip** counts warned-and-undecided rows and steps between them,
in the order the eye travels (section order, then file order), wrapping. The
count live-updates as rows are answered.

Two details that are not decoration:

- **At zero it says so rather than disappearing.** A counter that vanishes when
  it empties leaves the reader unsure whether they finished or the control
  broke. "No warnings left to answer" is also the sentence that explains why
  Post has just become available.
- **It is a reflection of the server's gate, never a second opinion.** The
  server re-derives the gate from the rows on every post and refuses a caller
  who never opened the page.

**The fee is editable in place** — click the amount, type, Enter or Save.
`inputMode="decimal"` for the number pad, 40px touch targets, and real
Save/Cancel buttons: Enter and Escape are the fast path for somebody at a desk,
not the only path, because a box committable only with a key a phone keyboard
hides is unusable for half the people who need it.

Clean rows are editable too. A warning is not the only reason a fee is wrong —
a parser that read a number confidently can still have read it wrongly.

**Editing stops when posting starts.** A `posting`, `posted` or `rolled_back`
batch renders read-only, with its rows still shown: they are the record of what
was written, and hiding them would leave nothing to check the practice against.
The server refuses the edit as well (409 `BATCH_NOT_EDITABLE`); the absent
control is the courtesy in front of that refusal, not the refusal.

---

## 6. Refusals, server-side

`PATCH /imports/:id/rows/:rowId` now takes `{ decision: 'edited', feeCents }`.
Cents go over the wire, never dollars — dollars are a display format and parsing
them is where rounding gets invented.

| sent | answer |
| --- | --- |
| `-100` | 400 `BAD_FEE` — negative is not a fee |
| `0` | **accepted** — not covered, bundled, or no charge |
| `92000.5` | 400 `BAD_FEE` — not a whole number of cents |
| `"92000"` | 400 `BAD_FEE` — a client that sends money as a string will eventually send `"1,150.00"` |
| `> 2,000,000,000` | 400 `BAD_FEE` — the parser's ceiling, just under what the `integer` column holds, so this is a refusal rather than a 500 from the INSERT |
| anything, on a posted batch | 409 `BATCH_NOT_EDITABLE` |

**The audit row carries old and new.** "Somebody edited a row" does not answer
"who changed a crown from $1,150 to $920, and what did the payer's file actually
say". ASCII only, because these lines get read back through container exec:

```
code:D2740|decision:pending->edited|cents:115000->92000|parsed:115000
```

The post's own audit row gained `edited:N` beside the counts it already carried.

---

## 7. Tests

```
backend:     node --check server.js → OK
             node --test            → 2703 tests, 0 fail, 3 skipped
dashboard:   pnpm run check         → clean (strict, no `any`)
             pnpm run test          → 1923 passed, 125 skipped, 0 failed
```

New: `backend/routes/fees/feesEditedRows.test.js` (18) and
`new-dashboard/tests/fees-review-ux.test.tsx` (26).

`FakeFeesDb` grew the pair CHECKs (both directions), the widened decision list —
imported **from the migration**, not copied — and an effective-fee total summed
through the same function the job writes by. A fake that summed `fee_cents`
would have let the confirm dialog state the parsed total while the job wrote the
edited one, with nothing noticing.

It also now returns **snapshots** rather than live row objects from a SELECT.
That was a real defect in the harness, found by the audit test: a handler that
read a row to record what it was about to change found the row had already
changed, because it was holding the same object the UPDATE went on to mutate.
Postgres hands back values; the fake now does too.

### Negative tests, as the brief required

**Backend.** Replacing `effectiveFeeCents(row)` with `Number(row.fee_cents)` in
`postJob.js` turned **exactly two** tests red — the pin (*a posted batch writes
the EDITED value into Open Dental*) and the resume-comparison test — and nothing
else in the 84-test route suite. Restoring brought both back.

**Client.** Making the TS mirror return `row.feeCents` unconditionally turned
**exactly three** red: the two helper tests and *shows the corrected fee AND the
parsed one it replaced*. The other 60 stayed green, correctly — they do not
assert which amount is displayed.

The pin drives the whole stack: HTTP PATCH → HTTP POST → the background job →
the Open Dental writer, then reads the amount back out of the fake practice's
fee schedule. It also asserts the writer was *asked* for the edited amount, so
it cannot pass on a coincidence in the fake's storage, and that `fee_cents` is
still the parsed value afterwards.

One existing test changed: `tests/fees-posting.test.tsx`'s `decideRow` mock,
because the fourth argument is now a verdict object rather than a decision
string. An `edited` decision carries its amount with it — modelled as a
discriminated union so "edited with no amount" and "accepted with an amount" are
both unrepresentable — and a mock recording only the string could not have
asserted the fee that was sent.

---

## 8. Open items for you

1. **`down()` on the new migration discards corrections.** An `edited` row
   becomes `pending` (which re-blocks its batch) and the override column is
   dropped. `accepted` would assert that the parsed number is the fee the office
   holds — the one thing the row proves it is not — and `excluded` is refused
   outright by `fees_import_row_excluded_unwritten_check` on any row already
   written. `pending` is the only truthful option, and the cost is worth knowing
   before somebody runs this during an incident.
2. **There is no bulk edit.** A schedule where every fee is 80% of the parsed
   column is currently 400 individual corrections. The tier-column case is
   really "use column 2 throughout", and the parser already knows how many
   columns it saw — a "use tier N" action on the *batch* is probably the right
   shape, but it is a new decision about a whole file rather than a row, and it
   belongs in its own slice with its own confirm.
3. **The edit box takes a fee, not a rule.** Somebody who wants "$920, because
   we are Tier 2" has nowhere to put the reason. The audit row records the
   numbers and the person; it does not record why. Worth a look at whether a
   short note per edit earns its place once this has been used on a real file.
4. **Sections are not collapsible.** On a 500-row schedule the jump menu carries
   most of the weight. If reviewers start wanting to close off what they have
   checked, collapse-with-a-checked-marker is the obvious next move — and it
   would want to persist, which makes it a server change rather than a UI one.
