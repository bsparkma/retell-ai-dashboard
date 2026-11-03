# Benefits formula validation — one-patient check against OD's Tx Plan panel

Branch `probe/benefits-remaining`. Read-only, roland only, GETs through
`getOdOffice`/`assertOfficeMatch`, ≥ 1.2 s spacing, outside the protected
windows. The patient was designated by the practice owner; the PatNum was
supplied at runtime only and appears nowhere in this repo. Figures were printed
to the console for the owner to compare against Open Dental's Tx Plan insurance
panel. This report carries **verdicts only** — no amounts, no identifiers.

Script: `backend/scripts/validate-benefits-formula.js`.

## Chart 1 of 2

| Panel field | Our figure | Verdict |
| --- | --- | --- |
| Annual Max | `readBenefits` annual max | **MATCH** |
| Ins Used | figure B "used" (Received/Supplemental `InsPayAmt` by `ProcDate`, + Adjustment) | **MATCH** |
| Pending | figure B "pending" (NotReceived, `ClaimNum > 0`, `InsPayEst` by `ProcDate`) | **MATCH** |
| Remain | annual max − figure B | **MATCH** |
| Deductible | `readBenefits` deductible | **NO MATCH** |

**A vs B: undecided.** This chart had no pending claims and no prior-year
procedure paid this year, so figure A (paid, by `DateCP`) and figure B came out
identical. It cannot tell the two formulas apart. Remain agreed with both.

### Why the deductible does not match

The printed figure is the **plan deductible from a benefit row**, not the
deductible remaining after payments (that is the snapshot's separate
`remainingDeductible`, which the validator did not print).

`readBenefits` (`backend/routes/tc/odReads.js`) takes the **first `Deductible`
row with a non-negative amount**, in API order (plan rows, then patplan
overrides), with no filter on `CovCatNum`, `CodeNum`, `CoverageLevel` or
`TimePeriod`. A follow-up read of this chart's benefit rows confirmed the pick:

- **Picked:** a plan-level `Deductible` row scoped to the **Diagnostic**
  coverage category (Individual, CalendarYear) — a category waiver row.
- **Skipped:** an identical waiver row for **Preventive**, and the
  **general** (no category, no code) Individual CalendarYear deductible row —
  the one OD's panel shows as the plan deductible.

So the defect is the row choice: the plan deductible should come from the
general row (`CovCatNum` 0/none, `CodeNum` 0, Individual, CalendarYear or
ServiceYear), and category-scoped rows are waivers or overrides that apply to
those categories only. This is the same class of weakness the probe flags for
the annual-max pick. **Not fixed** — held until the A/B question is settled.

## Chart 2 of 2

Pending: needs a chart with a nonzero **Pending** on the panel.
