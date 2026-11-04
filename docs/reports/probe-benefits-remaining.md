# Benefits-remaining probe: results (roland + valley)

Run 2026-11-03, 17:30–19:24 CT, on staging (`ca-carein-backend--0000286`), script
`backend/scripts/probe-benefits-remaining.js` at `dc0eba7`.

- Read-only: GETs only, at least 1.2 s apart.
- Office-scoped through `getOdOffice` + `assertOfficeMatch`.
- The `:13–:17` pause was honoured.
- Checkpointed to `/data/probe-benefits-results.json` after every patient.

The run never needed a resume: 0 restarts, 0 errors, and every one of the 915
requests returned 200 (no 429s).

Everything below is aggregates and field names. No patient names, no cohort
PatNums, no per-patient dollar figures. The only PatNums are the fixture test
patients, roland 12827 and valley 7115.

Window: appointments from 2026-11-04 to 2026-11-10 (7 days, starting tomorrow).

## Summary

| | roland | valley |
| --- | --- | --- |
| Hygiene patients in the 7-day window | 74 | 48 |
| … with at least one insurance plan | 58 | 33 |
| OD requests for the whole sweep | 568 | 347 |
| Wall time at 1.2 s spacing | 11.7 min | 11.8 min* |
| 429s / errors | 0 / 0 | 0 / 0 |

\*Valley's wall time includes one `:13–:17` pause. Its request time alone is 6.5 min.

**Verdict:** a nightly sweep is cheap. Even a full week of hygiene patients for both
offices is about 900 requests, roughly 18 minutes sequential at 1.2 s. A next-day sweep is about a fifth
of that. It fits comfortably before the 01:55–04:00 CT blackout.

**Two defects in `readBenefits` matter more than the cost:**

- **Deductible:** the wrong row is picked on most plans.
- **Annual max:** a category-scoped row is picked on about a third of plans.

Neither is fixed. Details are in Q3.

## Q1 — Hygiene appointments by date range

- **One range read is enough.** `GET /appointments?dateStart=&dateEnd=` returned exactly
  the same rows as seven `?date=` reads.
  - roland: 178 rows = 178.
  - valley: 90 rows = 90.
  - 0 rows outside the window, and 0 in one set but not the other.
  - roland needed 2 pages and valley 1.
- **`ClinicNum` is 0 on every row in both databases.** Office isolation comes from the
  customer key, not from ClinicNum. There is nothing to filter on.
- **Status mix:**
  - roland: Scheduled 161, Broken 17.
  - valley: Scheduled 77, Broken 12, UnschedList 1.
  - The sweep keeps Scheduled only.
- **What counts as "hygiene":** `appointment.IsHygiene` alone is a clean signal.
  - On scheduled rows, IsHygiene=true always came with ProvHyg set and a hygiene
    operatory.
  - The provider on those rows is often *not* flagged as a hygienist
    (roland 41 of 74, valley 26 of 48). Don't gate on the provider.
  - A few non-hygiene rows have ProvHyg set (roland 5, valley 1). That is another
    reason not to use ProvHyg.
  - The appointment type is no help: most hygiene rows have none (roland 48 of 74,
    valley 41 of 48).
- **Cohort size:**
  - roland: 74 distinct patients, 74 probed, no cap hit.
  - valley: 48 distinct patients, 48 probed, no cap hit.
- **Fixed cost** (operatories, providers, appointment types, range read): 5 requests
  for roland and 4 for valley.

## Q2 — Treatment-planned procedures per patient

`GET /procedurelogs?PatNum=&ProcStatus=TP`:

| | roland | valley |
| --- | --- | --- |
| Requests per patient (median / max) | 1 / 2 | 1 / 1 |
| TP rows per patient (median / mean / p90 / max) | 8 / 12.2 / 24 / 100 | 7 / 10.1 / 20 / 78 |
| Patients filling a whole 100-row page | 1 (true count 111) | 0 |
| Patients with any TP row | 74 of 74 | 48 of 48 |

- **The status filter works.** Every row returned was TP (901 roland, 484 valley).
- **Paging is rare but real.** Keep the `Offset` loop.
- **Caution: every hygiene patient had TP rows.** In OD, procedures attached to a future
  scheduled appointment are themselves TP. So this count almost certainly includes the
  upcoming hygiene visit's own codes. A "pending treatment" figure would need to exclude
  procedures whose `AptNum` is the scheduled hygiene appointment.

## Q3 — Benefits: max, deductible, used, remaining

### Endpoints and cost

A plan costs about 7 requests per insured patient (median 7, p90 8, max 14 when the
patient has two plans):

```
/patplans → /inssubs/{n} → /insplans/{n} → /carriers/{n} → /benefits (plan + patplan) → /claimprocs (paged)
```

- **`/carriers/{n}` is not needed for "remaining".** Dropping it saves about 11% of
  requests: roland 547 → 486, valley 326 → 292.
- **Every plan seen is on a calendar benefit year.** `MonthRenew` is 0 on all 61 roland
  and 34 valley plans. `benefitYearStart` handles a non-zero value, but this data never
  exercised it.

### `/claimprocs` ignores the `DateCP` filter

On the cohort patient with the most claimproc rows:

| | roland | valley |
| --- | --- | --- |
| Rows without the filter | 254 | 257 |
| Rows with the filter | 254 | 257 |
| … dated before the requested start | 231 | 240 |

- **The parameter is silently ignored.** The filtered read returned every row, so the
  "used this year" figure must page through all of a patient's claimprocs and filter
  client-side.
- **Rows per insured patient:**
  - roland: median 36, p90 105, max 254.
  - valley: median 51, p90 129, max 257.
- **This is the main cost driver.** A history-heavy patient costs 3 pages.
- **No NotReceived row had a null DateCP**, so "pending" rows can be dated.

### Annual max and deductible pick (`readBenefits`): defects confirmed at scale

**Deductible: wrong row picked on most plans.** This is the defect chart 1 exposed.

- `readBenefits` takes the *first* Deductible row.
- On most plans that first row is a category-scoped row (a Diagnostic or Preventive
  waiver), not the general Individual deductible.

| `dedPick` | roland (61 plans) | valley (34 plans) |
| --- | --- | --- |
| category-scoped (wrong) | 54 | 30 |
| ok | 6 | 3 |
| no deductible row | 1 | 1 |

- **Deductible rows per plan:** usually 2–4, typically several Individual rows plus one
  Family row (roland 15 plans, valley 10).
- **A correct pick needs a filter:** `CovCatNum` = 0 and `CodeNum` = 0, with
  `CoverageLevel` chosen explicitly (Individual vs Family).

**Annual max: category-scoped row picked on about a third of plans.** This is new; chart 1
did not show it.

- `readBenefits` takes the *largest* code-less Limitations row.
- On a third of plans that is a row with `CovCatNum` set. Most likely it is a lifetime
  ortho maximum: 48 roland rows and 23 valley rows have the shape
  `Limitations|Lifetime|category`.

| `maxPick` | roland (61 plans) | valley (34 plans) |
| --- | --- | --- |
| category-scoped (suspect) | 21 | 13 |
| ok | 40 | 21 |

- **Two roland plans** had more than one clean annual-max candidate.
- **The fix shape matches the deductible:**
  - require `CovCatNum` = 0 and `TimePeriod` ∈ {CalendarYear, ServiceYear};
  - prefer Individual.
- Chart 1's annual max matched OD, so chart 1 was one of the clean plans.

### "Used" and "remaining": formula A vs B

Both formulas were computed for every insured plan:

- **A:** Received + Supplemental `InsPayAmt`, by `DateCP`. This is the current code.
- **B:** the same paid rows by `ProcDate`, plus Adjustment, plus NotReceived
  (`ClaimNum` > 0) at `InsPayEst`.

| | roland | valley |
| --- | --- | --- |
| Plans with a known max | 61 | 34 |
| Patients with pending (NotReceived) claim rows | 8 | 5 |
| Plans where A and B differ | median 0, mean $39, p90 $189, max $527 | median 0, mean $100, p90 $274, max $1,541 |
| Plans where A and B differ by $50 or more | 11 | 11 |

- **The two formulas agree on most plans** but diverge materially on about 18% of roland
  plans and 32% of valley plans.
- **Pending claims drive most of the divergence.** Chart 1 (zero pending) could not
  separate them. **A vs B stays undecided** until a chart with nonzero Pending is checked
  against OD's insurance panel.

Remaining-max distribution (after the max pick above, so the suspect plans are in here
too):

| Bucket | roland A | roland B | valley A | valley B |
| --- | --- | --- | --- | --- |
| >$2000 | 37 | 37 | 9 | 9 |
| $1001–2000 | 16 | 16 | 13 | 12 |
| $501–1000 | 7 | 8 | 10 | 10 |
| $251–500 | 1 | — | 1 | 1 |
| $1–250 | — | — | — | 1 |
| $0 | — | — | 1 | 1 |

The large share above $2000 is consistent with the annual-max defect inflating the max
on some plans. Expect these buckets to move once the pick is fixed.

### Is there a precomputed "remaining" anywhere?

**No.** Every field name across all 12 endpoints was searched.

- The only hit was `/insplans/{n}.InsPlansZeroWriteOffsOnAnnualMaxOverride`, a
  write-off setting that matched on the name "AnnualMax". It is not a balance.
- `/familymodules/{PatNum}/Insurance` (checked on both test patients) returns
  plan/carrier/subscriber fields only: no max, no used, no remaining.
- "Remaining" must be computed.

## Q4 — Cost model and nightly budget

| | roland | valley |
| --- | --- | --- |
| Cohort (7-day window) | 74 | 48 |
| Requests per patient (median / mean / p90 / max) | 8 / 7.3 / 9 / 15 | 8 / 6.7 / 9 / 15 |
| Fixed requests (config + range read) | 5 | 4 |
| Full sweep requests | 547 | 326 |
| … at 1.2 s spacing | 10.9 min | 6.5 min |
| … at 1.0 s spacing | 9.1 min | 5.4 min |
| Without `/carriers/{n}` at 1.2 s | 9.7 min (486 requests) | 5.8 min (292 requests) |
| Observed 429s | 0 | 0 |

**Cost model:**

```
requests ≈ fixed (4–5) + uninsured × ~2 + insured × ~7.4, plus 1–2 more per claimproc page past the first
```

Budget for a nightly run:

| Window | Combined requests | Combined time (sequential, 1.2 s) |
| --- | --- | --- |
| Next day only | about 180 | about 4 min |
| Full 7 days | about 875 | about 17.5 min |

- **Next-day load varies a lot by weekday.** Scheduled hygiene volume was uneven:
  roland ran 49 / 48 / 10 / 0 / 0 / 37 / 34 appointment rows per day across the window.
- **Room to spare:** both are a small fraction of the 20:00–01:55 CT slot, and of the
  one `:13–:17` pause per hour.
- **Even a full week for both offices every night** stays well under an hour.
- **Concurrency is not needed.** Running the offices in parallel would need confirmation
  that OD's rate limit is per customer key and not per developer key. This probe ran
  them sequentially.

## Open items (not done here)

1. **A vs B:** waiting on a second chart with nonzero Pending (validator ready on `/data`).
2. **Deductible pick:** filter to `CovCatNum` = 0 / `CodeNum` = 0 and choose
   `CoverageLevel` explicitly. Held until the go-ahead.
3. **Annual-max pick:** exclude category-scoped and Lifetime rows. New finding, also held.
4. **TP count:** decide whether "pending treatment" excludes procedures attached to the
   scheduled hygiene appointment.
5. **`/claimprocs`:** client-side date filtering is mandatory, because the `DateCP`
   parameter is ignored.
