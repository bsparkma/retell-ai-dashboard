# Fees: the schedule picker, and measurement units read as fees

**Branch** `feature/fees-picker-and-units` (off `origin/develop`, d593620) ·
**Worktree** `C:\Users\beau\carein-wt\fees-picker`

Three things reported from real use. **No new Open Dental surface** — `odFeesWrites.js` was
not touched at all in the end, the delete/write patterns are unchanged, and the
`feesNoOdAccess.js` allow-list did not grow.

---

## 1. The missing fee schedule — root cause was not paging

**The brief's hypothesis was that `listFeeSchedules` read only the first page. It does
not, and there is no server-side cache.** Both were checked before anything was changed:

- `listFeeSchedules` and `fetchProcedureCodeMap` share **one** pager, `listAll`, which
  walks `Limit: 100, Offset: page * 100` and stops on a short page, with a `MAX_PAGES`
  circuit breaker. Paging is correct, and for an office with fewer than 100 schedules it
  never even takes a second lap.
- There is no cache anywhere on the server path — `grep` over `services/fees`,
  `routes/fees` and `config/openDental.js` finds none, and the route calls straight
  through to Open Dental on every request.

**The staleness was entirely in the browser.** `PostingPanel` had:

```ts
useEffect(() => {
  if (!needsTarget || schedules !== null) return;   // ← the bug
  listFeeSchedules(office, abort.signal)...
}, [needsTarget, schedules, office]);
```

Once `schedules` was set — even to `[]` — the effect never ran again. The panel stays
mounted across a re-read of the batch, so **nothing short of a full page reload could
refill that list**, and nobody had been told to reload. A schedule created in Open Dental
after the panel first loaded simply "was not there".

The same guard made the `office` dependency dead. Had the office ever changed under a
mounted panel, it would have gone on showing the previous office's schedules — a latent
version of the same defect, and the more dangerous one, since Roland and Riley hold
different contracts with the same payers. The new shape closes both.

### The fix

The guard is gone; the read is keyed on a token that **Refresh** bumps. A deliberate
re-read also passes `cache: "no-store"`, because Express puts an ETag on every JSON
response and a Refresh answered from the browser's cache is the one response that cannot
help somebody who pressed it *because* they distrusted what they were looking at.

---

## 2. The picker

- **Type-to-search** over name and FeeSchedNum. Client-side over the already-fetched
  list, deliberately: a server read costs an Open Dental request against a credential
  paced at one per second and shared with every other module, so typing must not issue
  one. `filterSchedules` is pure and exported, so the matching rule is testable without a
  screen. Substring and case-insensitive, **not fuzzy** — a fuzzy match on a list this
  consequential would offer "Delta Premier" to somebody searching for "Delta PPO".
- **Refresh**, with its own spinner and disabled state, and an empty-search message that
  names it: the likeliest reason a search finds nothing is the bug above.
- **Hidden schedules are still shown**, drawn with a dashed border and a `hidden` tag.
  They are offered because a rolled-back batch's schedule is hidden and posting into it
  again is legitimate — but hidden in Open Dental usually means retired, so choosing one
  should be a deliberate act rather than a slip of the eye.
- **The FeeSchedNum is on every option.** Two schedules commonly share a name across
  years, and the number is what the confirm dialog quotes back.
- **"Create a new fee schedule" is now a labelled block** with its own explanation, rather
  than an unlabelled text box under the list reading "…or name a new schedule". That made
  the *safest* option — a brand new schedule attached to no plan, which reprices nothing —
  look like an afterthought, while posting into a live schedule looked ordinary. That is
  the wrong way round. **Presentation only:** the server path, the validation and the
  create-on-Post-click behaviour are untouched.

---

## 3. Measurement units read as fees

The D74xx surgical family prints its size threshold in the description:

```
D7410   Excision of benign lesion up to 1.25 cm              285.00
```

`1.25` is money-shaped — digits, a point, two decimals — so the scanner found **two**
amounts, flagged the row `ambiguous_amount` and took the first. **The office was offered
$1.25 as the fee for a surgical excision**, under a warning that blamed the line rather
than naming the number.

`feeValues.js` now splits a line's money-shaped tokens into fees and measurements with
one scanner, so `findAmounts` and `findMeasurements` cannot disagree about which bucket a
token fell into. The rule is the narrowest that covers the defect:

| | |
| --- | --- |
| **`cm` and `mm` only** | `%` is excluded on purpose — a schedule really does print "80%" beside a fee, and a percentage is not money-shaped anyway. `x` too: "2 x 285.00" is the fee twice over, not a dimension. |
| **At most one space** | The gap between two columns in a PDF text layer is several spaces. One space is what stops a real fee being discarded because the next column happens to begin with "cm". |
| **Word-bounded, case-insensitive** | "1.25 cmx" is not a measurement. "1.25 CM" is. |

Outcomes, exactly as specified:

- **One candidate after exclusion → clean, no warning.** The three excision rows now parse
  at $285.00, $395.00 and $470.00 with nothing for a person to adjudicate. The point of
  the fix is that these rows stop consuming a human decision each.
- **Still multiple candidates → unchanged.** The multi-column fixture still raises
  `ambiguous_amount`; the filter did not quietly resolve genuine ambiguity.
- **Exclusion empties the set → it warns.** A code line with no number at all is most of a
  PDF and is still skipped in silence. A line where the filter removed the only candidate
  is one this parser *decided* not to read a fee from, and a new `measurement_not_a_fee`
  file warning names the code, the number and the raw line. Without it, tightening the
  scanner would have turned "wrong fee, flagged" into "no fee, silent" — better, but still
  not honest.

**Both lanes, through the shared module.** The PDF lane gets it via `findAmounts`. The CSV
lane never used `findAmounts` — it hands a whole cell to `parseFeeCents`, which already
refused `1.25 cm`, but refused it as "could not be read as a dollar amount". It now says
`measurement_not_a_fee`, so somebody can see they pointed the importer at a size column.

One honest detail: **`1.25cm` with no space was already excluded, incidentally.**
`MONEY_IN_TEXT` ends in `\b`, and `5` followed by `c` is not a word boundary, so that form
never matched in the first place. It is asserted anyway — the outcome is the promise, not
the mechanism, and a future widening of the money scanner must not reintroduce it.

Recorded as **deviation D15** in `README-PORT.md`.

---

## Tests

```
backend:     node --check server.js → OK
             node --test            → 2720 tests, 0 fail, 3 skipped
dashboard:   pnpm run check         → clean (strict, no `any`)
             pnpm run test          → 1978 passed, 126 skipped, 0 failed
```

New: 7 unit tests in `feeValues.test.js`, 4 lane tests in `feeSchedule.test.js`, two new
fixtures (`PDF_LESION_UNITS`, `PDF_SMALL_REAL_FEE`), and
`new-dashboard/tests/fees-target-picker.test.tsx` (13).

### Negative tests

**The unit filter.** Replacing `MEASUREMENT_UNIT` with a regex that matches nothing turned
**exactly five** tests red — the two lane tests, the two scanner tests and the CSV cell
test — and nothing else in the 54-test parser suite. The other new tests stayed green
*correctly*: "a genuine $1.25 fee is still a fee", "two spaces is the next column" and
"only cm and mm" all assert behaviour that does not depend on the filter being on.

**The picker.** Restoring the `schedules !== null` guard turned **exactly two** red — the
refresh test and the no-store test — out of 13. Restoring both brought everything back.

### One flake, dismissed

On one of three full backend runs, `routes/sendToTc.test.js` reported a file-level failure
with no failing assertion; it passes 18/18 in isolation and references nothing in this
change. The run totals differed between runs (2720 vs 2704), which is itself the
signature. This is the known Node 22 runner parent-decode bug already recorded for this
repo; CI shards the backend suite, which is the existing mitigation.

---

## What this does not do

1. **`odFeesWrites.js` was not modified.** The brief allowed a change to its read half;
   none turned out to be needed, because the paging was already correct. Worth knowing
   before somebody looks for one in the diff.
2. **The schedule list is still read once per panel mount plus once per Refresh.** There
   is no polling, deliberately — every read is an Open Dental request on a shared 1/sec
   credential. If offices start creating schedules mid-review often enough that pressing
   Refresh feels like a chore, the next move is to re-read automatically when the tab
   regains focus, which costs one request per return rather than one per interval.
3. **The unit filter covers two units.** If a payer turns out to print thresholds in `in`
   or `sq cm`, that is a one-line addition to `MEASUREMENT_UNIT` plus a fixture line —
   but adding them now would be inventing rules for cases nobody has hit, which is how
   the reference importer accumulated the defects this module was written to undo.
4. **No fixture exercises a measurement in a CSV fee column end to end.** The unit test
   covers `parseFeeCents` directly, which is where the decision is made; a CSV fixture
   would exercise the same call through the column picker. Cheap to add if a real file
   turns up with one.
