# The confirm screen under real work

Two things, on the screen a biller actually uses to check a scanned EOB against
its page image.

**1. Confirming a figure no longer resets the page.** Every confirm threw both
panes back to the top. That is fixed, and the work now moves itself on to the
next figure.

**2. She can add the line the scan missed** — and strike the one it invented.

Branch `fix/rcm-confirm-in-place`, off `origin/develop` at `4f1a440`, which
carries PR #208. Three commits plus this report. **Not merged.**

---

## 1 · Confirming a figure never resets the page

### The defect

`send()` ended in `load()`, and `load()` opens with `setState({ kind: "loading" })`.
So the whole tree came down and went back up on every single confirm:

- the document viewer **remounted** — losing its scroll position and its page
- the figure list reset to the top

A biller working thirty money figures down a scanned EOB lost her place thirty
times.

### Why it was written that way, and what was actually wrong with it

The comment above `load()` was right about the *reason*:

> the server derives whether a figure was confirmed or corrected, recomputes the
> outstanding count and re-runs the sum against the anchor — and a screen that
> guessed any of those would be a second opinion about which number is real

That is still true, and nothing here weakens it. It was wrong only about what it
*requires*. Re-reading the page is not the only way to get the server's answer:
the server can simply say what it now holds.

**So `POST /field-confirm/:batchId` returns its whole recomputed state**, built by
the same `shapeState()` the GET uses, from one indexed re-read of the
confirmations inside the same transaction. The screen swaps that in under a tree
that stays mounted. Nothing is computed in the browser, and nothing unmounts.

The re-read is a whole read, not a merge of the rows just written: a request may
confirm five fields of which two were already confirmed, and the upsert's
`RETURNING` describes those five only. Merging would be right by accident on a
fresh check and wrong on a resumed one.

### Then the work moves on

After a successful save, focus and the highlight go to **the server's own
`outstanding.first`** — the same accessor that produces the count beside it,
walking the check in the order the remittance prints it. Picking the next row in
the DOM would have been a second ordering, and the two would disagree the first
time a re-extraction added a claim.

The row is scrolled into view with `block: "nearest"` (the smallest move that
brings it into view — centring would scroll on *every* confirm, which is a milder
version of the defect being fixed) and its confirm button is focused, so **Enter**
answers it. Enter is an explicit handler on the row rather than a focused
button's native behaviour, because "Enter saves what I typed" has to hold inside
the text box too, where the native behaviour would be nothing at all.

The selected line follows the work, so the document panel can follow once the
stored read carries geometry. It carries none today, so the page does not move —
the selection is the seam.

### A failed save keeps her place

The error is **inline, at the control that was pressed** — a field's row, or the
line for the "these N are right" button. A banner at the top of a long list is a
message about a figure she cannot see from where the banner is, and it cannot say
which of fifteen rows it is about.

On failure: no state swap, no focus change, and the typed figure stays in its box
so Save can be pressed again without retyping it. The same rule now covers the
add-a-line and strike forms — `mutate()` returns whether the save took, and the
forms close on `true` only. *(That was a real bug my own test caught: the add form
cleared itself on a refusal, throwing away what she had typed.)*

### What is pinned

| Pin | How |
| --- | --- |
| **No remount** | The viewer's frame is the **same DOM node** afterwards. A remount hands back a different node for the same testid; a re-render of a mounted tree hands back the identical one. Nothing else in jsdom distinguishes the two, and the distinction is the whole defect. |
| **Scroll preserved** | `scrollTop` set to 420, asserted unchanged after a confirm. |
| **No refetch** | The page read count stays at 1 — the mount — across a confirm. |
| **Advance** | The next unconfirmed figure is highlighted *and* holds focus, in the server's order; nothing is highlighted on mount (a screen that grabbed focus would move the page out from under someone reading it); nothing is highlighted once the work is done. |
| **Enter** | Confirms the focused row and advances; saves the **typed** figure when the box is open; does nothing at all when what is typed is not a figure — it must never fall back to confirming the machine's figure while she is partway through disagreeing with it. |
| **Failure keeps place** | Still unconfirmed, no trail line, nothing highlighted, the viewer never came down, the count unchanged, and the typed figure still in its box. |

---

## 2 · A line the scan missed, and a line it invented

### Why this is not a bypass

A read that misses a procedure line leaves a claim whose lines do not sum to its
total. `CLAIM_TOTALS_AGREE` refuses it — correctly — and the refusal is one a
biller **can do nothing about**: every figure on screen is right, and the missing
one is not on screen to correct.

So she types it in from the page, and **the added line counts in the claim's sum
exactly like one the reader found.** The arithmetic goes from "does not add up" to
"adds up" by becoming *more complete*, never by being relaxed. A line that does
not close the gap leaves the refusal standing; a cent out is still out.

The mirror case is the same act backwards: a line the read invented — a benefit
subtotal row read as a procedure — is **struck, with a reason**, and stops
counting.

### What it does *not* do: posting

A hand-entered line has no ClaimProcNum, and **this slice does not extend the
posting spine to give it one** (W-16 / D-17 / Q2 / the proof block are
byte-untouched). A struck line is the same problem from the other side: the
posting plan still holds a pairing for a line a person has just said is not on the
page.

Both therefore withhold the claim, by name, through one new gate condition:

> **The lines are the ones the scan read** — *Post this claim in Open Dental by
> hand — a line on it was typed in or struck on the confirm screen, and CareIN
> will not pay money against a line it never matched to the chart.*

The detail says which of the two happened; the `fix` is shared because the remedy
is. **The arithmetic going honest and the money moving are two different
permissions**, and this slice grants only the first.

### Storage — beside the extraction, never in it

`backend/migrations-tenant/1789900000000_rcm_eob_added_lines.js`, additive:

**`rcm_eob_added_lines`** — one row per line typed in. The same five money
columns the extraction stores and the confirm step confirms, so an added line and
a read line are the same shape downstream. **Every money column nullable**: "the
page does not state an allowed amount for this line" is the ordinary case on a
category-subtotal EOB, and a `NOT NULL DEFAULT 0` would force her to invent a
zero. CHECKs: office, non-empty code, no negative figure (a negative on an EOB is
a takeback, which is a different lane).

**`rcm_eob_line_strikes`** — one row per strike. **Two nullable foreign keys with
an XOR CHECK** (`num_nonnulls(line_id, added_line_id) = 1`) rather than one
polymorphic id column: a single column would need its own "which table" flag, and
nothing but application code would stop the flag and the id disagreeing. Reason is
`NOT NULL` and non-empty — a line leaving a claim's arithmetic with no recorded
reason is money that changed and cannot be accounted for.

**A strike can be withdrawn.** Striking a real line takes its money out of the
sum, so a mis-strike would otherwise leave a check that can never reconcile and a
biller with nothing to press. Withdrawal is an `UPDATE`, so the trail keeps both
halves of "she struck it, then changed her mind". Partial unique indexes keep one
*live* strike per line.

**Grants are role-guarded, `SELECT, INSERT, UPDATE`, no `DELETE`** on either
table — an added line is never removed, only struck; a strike is never removed,
only withdrawn. `down()` **refuses** while either table holds rows: every row is
something a person read off a document and typed, and it exists nowhere else.

Nothing here touches `rcm_procedure_lines`, `rcm_claims` or `raw_extracted_json`.
Two backend tests assert that by snapshotting the extraction rows across an add
and across a strike.

### One accessor, still

`services/rcm/confirmedFigures.js` gains the functions that *decide*, and nothing
else joins these tables by hand:

- **`effectiveLines()`** — what a claim's lines *are*: what the read produced,
  minus what a person struck, plus what she added. A struck line is **returned,
  not dropped**: a line that silently vanished would be a claim whose arithmetic
  changed with nothing on screen to account for it, and the only way back from a
  mis-strike is to be able to see it.
- **`countableLines()`** — the one predicate for "counts towards a sum".
- **`addedFigure()`** — `source: 'added'`, its own value and not `corrected`: a
  correction is a person disagreeing with the machine about a figure, and this is
  a person supplying one the machine never offered. `extractedCents` is `null`
  because the read produced no figure, not because it produced a blank one.
  `confirmed: true`, because **typing it off the page IS the confirmation** — the
  same act the confirm step records for a read figure, so an added line is not
  then confirmed a second time.
- **`claimLineSum()`** — lifted out of `evaluateClaim` so the confirm screen
  renders the same arithmetic the gate refuses on. *One arithmetic, two
  renderers*, the guarantee `lineDecisions` already gives the workbench. The whole
  existing gate suite (95 tests) passed unchanged across the extraction, which is
  what says the behaviour was preserved exactly.
- **`requiredFields()`** now skips struck lines (she has said they are not there;
  demanding she confirm them would be a count that can never reach zero — a wall)
  and added lines (asking her to confirm her own transcription would be ceremony,
  and a review step that teaches billers it is ceremony is worse than none).

A **malformed strike is ignored**, which leaves the line *counting*. That is the
safe direction: a line nobody can account for keeps the claim from reconciling,
where trusting a malformed strike would quietly remove money from a sum.

`extractedFor()` learned to read the same `FIELD_COLUMNS` mapping in either
spelling (`paid_cents` / `paidCents`), because the route hands in raw `pg` rows
and the gate hands in rows it has already mapped. One mapping, read two ways — a
second table keyed by camelCase is exactly the drift that function exists to
prevent.

### The screen

- **"Add a line from the page"**, per claim, under its lines. Code, description
  and the five money boxes. A blank box is sent as `null` with **the key
  present** — an omitted key would have the server record "the page says nothing"
  about a figure nobody looked at. A box that will not parse keeps the button
  disabled rather than being sent as a null, with a `DisabledReason` saying which
  (no reason-less greyed button).
- **The claim's own line-sum row** — "Lines $153.00, claim $184.00 — **$31.00
  apart**. A line may be missing." The direction of the difference *is* the
  instruction. This is the line that turns green when she adds the missing one.
- **The human-added mark** — "Typed from the page", a plain label and **not a
  colour**: red and amber stay reserved for disagreement, and a line somebody
  typed in correctly is not a disagreement. Each figure carries "added by
  &lt;name&gt; from the page image", and its state chip reads **"Typed"**, not
  "Checked" — "checked" claims a comparison against a read that never happened.
- **"Not a line on the page"**, per line, with a required reason; a struck line
  is greyed and struck through, carries "struck by &lt;name&gt; — &lt;reason&gt;",
  stops offering to confirm its figures, and offers **"Put this line back"**.

### The workbench

`matchService.loadClaimBundle` reads both tables through the accessor and the
claim page shows them. **Typed lines are their own list, not folded into
`lines`.** That table is the lines paired to a chart claim, and
`buildWorkbenchView` measures each one against what Open Dental holds for it; a
typed line has no chart counterpart — which is exactly why the gate withholds the
claim — so putting it there would make the verdict compare a line against nothing
and report the difference as a patient's balance.

A struck carrier line keeps its row, its figures and its verdict, and gains the
mark. Without it, the gate's refusal would name an edit the biller cannot see from
where the lines are.

---

## Out of scope, and what it would take

**Adding an entire missing patient or claim is not built.** The brief asks for it
to be described rather than attempted, and the gap is much wider than one more
form:

- **Storage.** An added *line* hangs off a claim that already exists, so
  `claim_id` is a real foreign key. A whole claim has no such anchor: it would
  need its own table mirroring `rcm_claims` (patient name, claim number, service
  date, total paid, plus a `rcm_batch_claim_payments` equivalent so the check's
  own balance can account for it), and every reader that walks a batch's claims
  would have to merge two sources rather than one.
- **The batch balance.** `CONFIRMED_SUMS_TO_CHECK` reconciles Σ(claim totals)
  against the cheque, and the batch-balance rule subtracts the PLB. A claim the
  extraction never produced changes both sums, so both would have to be taught
  about a second origin — and until they are, adding a claim would make a check
  that balanced stop balancing.
- **Identity.** A line is identified by a procedure code. A claim is identified by
  a *patient*, and this module has no patient search by design (RCM reads
  patients only through a confirmed Open Dental claim match). Typing a patient
  name into RCM would be a new identity surface with its own cross-office risk —
  PatNum numbering restarts in every OD database, so a patient typed without an
  office is unresolvable.
- **Matching and posting.** A typed claim has no `od_claim_num`, so it cannot be
  matched, cannot pair lines, and cannot post — the same wall a typed line meets,
  but for the whole claim, so the gate would withhold 100% of it rather than
  bringing a reconciled read one step closer.

My read: **the right next slice is not adding claims but storing OCR geometry**,
so the per-line crop the addendum asked for can be built and a biller can see
*where* on the page a figure came from. A missed whole claim is better handled by
re-uploading a better scan than by retyping a patient into a module that has
deliberately never held one.

---

## Constitution

| Rule | How it held |
| --- | --- |
| Machine slugs/routes additive only | `LINES_UNEDITED_BY_HAND` added to `CHECKS`; `source: 'added'` added to the figure union; two new POST routes under the existing `/field-confirm` mount. Nothing renamed, nothing removed. |
| One primary per screen | The confirm screen's primary is still the single bottom control. Add, strike and put-back are secondary. The smoke sweep's primary check passes. |
| Budgets pinned, pay by cutting | 203 measured → **8 paid by cutting** → 195. Re-pinned 180 → 200 in its own commit, counts in the message and in `rcm-smoke.test.tsx`. |
| Banned-words guard | `rcm-plain-language.test.ts` green. |
| No reason-less greyed button | Both new disabled controls carry a `DisabledReason` naming what is missing. |
| W-16 / D-17 / Q2 / proof block / posting spine | Untouched, checked two ways: no file matching `posting|drain|queue` is in `git diff --name-only origin/develop..HEAD`, and `verdictBlock.ts` / `posting.ts` are not in it either. Of the files that ARE touched, no diff hunk in `approvalGate.js` or `ClaimWorkbench.tsx` mentions `W-16`, `D-17`, `Q2`, `verdictBlock` or `readback`. |
| 835 checks untouched | By construction: every new table, route and gate branch is behind `isOcrSourced(provenance)`, and `NOT_CONFIRM_REQUIRED` carries empty maps so an ERA's arithmetic is the one it always had. Pinned by a test. |
| No OD writes | No OD module is in the require graph of any file added here. |
| Office server-side | Both new routes derive office from `req.rcmOffice` under `requireOffice`; both are `rcm.write` through the mount's method gate; a cross-office batch is a 404, not a refusal. |
| Fictional fixtures | Every payer, patient, code, check number and amount in tests, screenshots and this report is synthetic. The owner's real EOB appears nowhere. |

---

## Evidence

| Gate | Result |
| --- | --- |
| `pnpm run check` | clean |
| `pnpm run test` (dashboard) | **2215 run · 2077 passed · 0 failed · 138 skipped** |
| `node --check server.js` | clean |
| `node scripts/shard-runner.mjs` (backend) | **2866 tests · 2863 pass · 0 fail · 3 skipped**, 4/4 shards green (2802 before this slice) |
| Mutation harness | **42/42 caught** |

New suites: `tests/rcm-confirm-in-place.test.tsx` (13), `tests/rcm-add-line.test.tsx`
(17), `routes/rcm/fieldConfirmRoutes.test.js` (+25),
`routes/rcm/rcmFieldConfirmGate.test.js` (+9),
`services/rcm/confirmedFigures.test.js` (+18), `tests/rcm-workbench.test.tsx` (+5).

### Screenshots

`docs/screenshots/rcm-confirm-in-place/`, 1280×900, light and dark, from a jsdom
render of synthetic fixtures through the app's real built CSS.

| Shot | What it shows |
| --- | --- |
| `al-01-gap` | the claim $31.00 short, the gap named, the add control under its lines |
| `al-02-form` | the form open with the missing x-ray line typed in |
| `al-03-reconciled` | the added line marked "Typed from the page" with "added by … from the page image" under every figure, and **"The lines add up."** |
| `al-04-advanced` | a figure just confirmed carrying its trail, and the next one highlighted and focused |
| `al-05-struck` | a line struck, greyed and struck through, with who, why, and "Put this line back" |

`al-01` → `al-03` is the before/after the brief asks for: same screen, no reload,
the sum going from amber to green because a line was added.

**What a still frame cannot show.** The scroll positions surviving a confirm are
pinned by **DOM-node identity** and a `scrollTop` assertion in jsdom, and by the
mutation that reinstates `load()`. A photograph of one state cannot carry that, so
`al-04` shows the observable half — the trail appearing and the highlight moving
on — and the no-remount guarantee lives in the test, not in a picture. Said here
rather than left for a reader to notice.

---

## Worth a reviewer's attention

- **The POST response got much bigger.** It now carries the whole screen state on
  every confirm. On the real case — one check, a few claims — that is a few KB
  against a round trip saved, and it is the same payload the GET was sending
  anyway. On a 50-claim remittance it would be worth measuring before assuming.
- **An added line's figures cannot be corrected through the confirm step.** The
  confirmations table's `line_id` is a foreign key to `rcm_procedure_lines`, so a
  typed line has no row to confirm against. A typo is fixed by striking the line
  and adding it again, which leaves the whole story on screen. Deliberate, but it
  is a rougher edge than correcting a read figure.
- **The gate's `CLAIM_TOTALS_AGREE` was rewritten** to call `claimLineSum()`
  rather than compute inline. The 95 existing gate tests passed unchanged, which
  is the evidence that the behaviour is identical — but it is the largest
  behaviour-preserving change in the diff and the one most worth a second pair of
  eyes.
- **Middle commit is red on one sweep, by design.** `5eea5e3` leaves the confirm
  screen's word budget exceeded; `af50232` re-pins it in its own commit with the
  counts, per the brief. Review them as a pair.
