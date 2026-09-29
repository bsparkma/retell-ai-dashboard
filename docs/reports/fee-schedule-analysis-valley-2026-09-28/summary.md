# Fee schedule analysis — Valley Fort Smith (`valley`)

Generated 2026-09-28 · read-only · 52 Open Dental GET requests · 61.7s

**UCR schedule: `89` — Standard 04/2025**  
How it was chosen: modal FeeSched among non-hidden plans with blank PlanType (72 of 86 such plans) — chosen over the providers' schedule by `--ucr-source inference` (they agree, so it makes no difference).

✅ **The two independent routes agree.** The providers' schedule and the insurance-plan inference (modal FeeSched among non-hidden plans with blank PlanType (72 of 86 such plans)) both land on `89`.

Providers (11 non-hidden, excluding non-person entries) carry: `89` ×9, `53` ×2 — **they do not all agree**; the modal value is used.

Every percentage below is **weighted % of that UCR schedule**, over a fixed 22-code general-practice basket, computed only across codes priced in _both_ schedules. Higher is better: 100% means the schedule pays the office's own full fee.

## Schedules ranked, high → low

Schedules pricing at least 12 of the 22 basket codes. 32 of 37 qualify.

| # | Fee schedule | Plans | Cov. | **% UCR** | Hygiene | Restorative | |
|---:|---|---:|---:|---:|---:|---:|---|
| 1 | Standard 04/2025 (`89`) | 420 | 22/22 | **100.0%** | 100.0% | 100.0% | **UCR** |
| 2 | Fee Standard 62023 (`53`) | 13 | 22/22 | **90.0%** | 90.1% | 90.0% |  |
| 3 | Smile Savers plan 2023 (`74`) | 0 | 12/22 | **89.3%** | 89.2% | 89.3% |  |
| 4 | Connection Dental 2024 (`87`) | 545 | 22/22 | **86.1%** | 85.2% | 86.4% |  |
| 5 | Mutural of Omaha 10/2023 (`83`) | 0 | 20/22 | **80.9%** | 77.9% | 81.8% | hidden |
| 6 | Careington CP50 (`71`) | 12 | 22/22 | **79.8%** | 78.2% | 80.3% |  |
| 7 | United Health Care (UHC) 10/2023 (`79`) | 0 | 22/22 | **71.2%** | 73.6% | 70.6% |  |
| 8 | Arkansas BCBS Blue/Grid + 10/2023 (`81`) | 178 | 22/22 | **65.0%** | 51.0% | 68.9% |  |
| 9 | Healthchoice'22 (`72`) | 0 | 22/22 | **64.9%** | 63.8% | 65.2% | hidden |
| 10 | Zelis (`70`) | 5 | 22/22 | **59.9%** | 54.6% | 61.4% |  |
| 11 | Healthchoice (`64`) | 9 | 22/22 | **55.1%** | 53.1% | 55.6% |  |
| 12 | Arkansas BCBS PPP General 10/2023 (`80`) | 0 | 22/22 | **54.5%** | 47.7% | 56.4% | hidden |
| 13 | Municipal Health 10/2023 (`85`) | 0 | 22/22 | **54.3%** | 48.0% | 56.0% | hidden |
| 14 | Delta Arkansas Premier 09/2023 (`62`) | 145 | 22/22 | **52.9%** | 47.0% | 54.5% |  |
| 15 | Cigna PPO (`54`) | 0 | 20/22 | **52.5%** | 66.2% | 49.2% |  |
| 16 | Aetna 2023 (`56`) | 1 | 22/22 | **50.9%** | 68.2% | 46.1% |  |
| 17 | Delta Oklahoma '20 (`69`) | 1 | 22/22 | **50.2%** | 46.6% | 51.2% |  |
| 18 | Arkansas BCBS Medicare Advantage 10/2023 (`82`) | 0 | 22/22 | **50.1%** | 44.3% | 51.6% | hidden |
| 19 | Dental Network of America (`67`) | 0 | 22/22 | **49.5%** | 44.0% | 51.0% | hidden |
| 20 | Standard UMR fees  (`73`) | 0 | 20/22 | **49.4%** | 45.6% | 50.5% | hidden |
| 21 | Delta Dental Arkansas PPO 2023 (`68`) | 36 | 22/22 | **49.3%** | 42.5% | 51.2% |  |
| 22 | Arkansas BCBS PPO General 10/2023 (`66`) | 0 | 22/22 | **49.1%** | 44.2% | 50.5% |  |
| 23 | Metlife 2023 (`76`) | 0 | 22/22 | **48.7%** | 45.6% | 49.6% | hidden |
| 24 | Connection Dental 2024 (`59`) | 0 | 22/22 | **47.5%** | 43.9% | 48.5% | hidden |
| 25 | DNOA BCBS TX/ OK/ IL/ MI/ NM/ KS 2023 (`78`) | 5 | 22/22 | **45.3%** | 41.7% | 46.3% |  |
| 26 | Dentamax (`63`) | 0 | 19/22 | **41.6%** | 39.4% | 42.4% | hidden |
| 27 | United Concordia/TDP/Tricare ONLY '23 (`65`) | 59 | 22/22 | **41.0%** | 37.6% | 42.0% |  |
| 28 | Ar Medicaid Child (`58`) | 3 | 20/22 | **39.5%** | 39.3% | 39.6% |  |
| 29 | MCNA ARK Medicaid 09-2023 (`77`) | 0 | 20/22 | **39.3%** | 38.5% | 39.6% | hidden |
| 30 | Delta Dental Smiles/Child (`60`) | 1 | 16/22 | **37.4%** | 41.1% | 34.7% |  |
| 31 | Cigna 2023 (`75`) | 0 | 22/22 | **35.0%** | 32.3% | 35.7% |  |
| 32 | Delta Dental Copay (`55`) | 0 | 16/22 | **9.6%** | 7.1% | 11.8% |  |

## Low coverage — not ranked

Fewer than 12 basket codes priced against UCR. The percentage, where one exists, is arithmetic on too few codes to rank against the others.

| Fee schedule | Plans | Cov. | % UCR | |
|---|---:|---:|---:|---|
| Delta Dental Smiles Adult (`61`) | 1 | 11/22 | 45.4% |  |
| Anthem BCBS 10/2023 (`84`) | 0 | 0/22 | — | hidden, no basket fees at all |
| APL (`57`) | 0 | 0/22 | — | hidden, no basket fees at all |
| UHC Medicaid AR/OK 10/2023 (`86`) | 0 | 0/22 | — | hidden, no basket fees at all |
| DELETE (`88`) | 0 | 0/22 | — | hidden, no basket fees at all |

## The carrier list

In the order given. "Plans" counts non-hidden insurance plans across every carrier record matching the listed name — **normalised** (both sides reduced to letters and digits) plus any alias. "Strict" is what the literal case-insensitive substring rule alone would have found; where the two differ, the strict rule was undercounting. "Effective %" is the matched plans' plan-count-weighted average of the schedules they actually sit on.

| Carrier | Recs | Plans | Strict | Effective % UCR | Schedules actually used |
|---|---:|---:|---:|---:|---|
| **United Healthcare** | 2 | 97 | 97 | 86.2% | Connection Dental 2024 — 92 (86.1%)<br>Careington CP50 — 3 (79.8%)<br>Standard 04/2025 — 2 (100.0%) |
| **Blue Cross Blue Shield** | 17 | 250 | 250 | 74.7% | Arkansas BCBS Blue/Grid + 10/2023 — 173 (65.0%)<br>Standard 04/2025 — 72 (100.0%)<br>DNOA BCBS TX/ OK/ IL/ MI/ NM/ KS 2023 — 5 (45.3%) |
| **Health Choice** | 1 | 9 | **0** | 55.1% | Healthchoice — 9 (55.1%) |
| **Choice Benefits** | 0 | 0 | 0 | — | — |
| **Cigna** | 1 | 86 | 86 | 86.2% | Connection Dental 2024 — 84 (86.1%)<br>Careington CP50 — 1 (79.8%)<br>(no schedule — pays off UCR) — 1 (100.0%) |
| **Aetna** | 3 | 75 | 75 | 86.6% | Connection Dental 2024 — 71 (86.1%)<br>Standard 04/2025 — 3 (100.0%)<br>Careington CP50 — 1 (79.8%) |
| **GEHA** | 2 | 4 | 4 | 93.1% | Standard 04/2025 — 2 (100.0%)<br>Connection Dental 2024 — 2 (86.1%) |
| **Ameritas** | 1 | 27 | 27 | 86.1% | Connection Dental 2024 — 27 (86.1%) |
| **Delta Dental** | 41 | 439 | 439 | 79.9% | Standard 04/2025 — 252 (100.0%)<br>Delta Arkansas Premier 09/2023 — 145 (52.9%)<br>Delta Dental Arkansas PPO 2023 — 36 (49.3%)<br>Fee Standard 62023 — 2 (90.0%)<br>_+4 more_ |
| **Anthem Blue Cross and Blue Shield** | 0 | 0 | 0 | — | — |
| **Anthem** | 1 | 15 | 15 | 100.0% | Standard 04/2025 — 15 (100.0%) |
| **Guardian** | 2 | 56 | 56 | 86.4% | Connection Dental 2024 — 55 (86.1%)<br>Standard 04/2025 — 1 (100.0%) |
| **Principal Life Insurance Company** | 1 | 22 | 22 | 86.1% | Connection Dental 2024 — 22 (86.1%) |
| **Humana** | 2 | 64 | 64 | 86.6% | Connection Dental 2024 — 62 (86.1%)<br>Standard 04/2025 — 2 (100.0%) |
| **United Concordia TDP & Active Duty** | 3 | 38 | **0** | 42.3% | United Concordia/TDP/Tricare ONLY '23 — 36 (41.0%)<br>Arkansas BCBS Blue/Grid + 10/2023 — 2 (65.0%) |
| **Lincoln Financial Group** | 1 | 3 | 3 | 86.1% | Connection Dental 2024 — 3 (86.1%) |
| **MetLife** | 1 | 111 | 111 | 85.8% | Connection Dental 2024 — 103 (86.1%)<br>Careington CP50 — 7 (79.8%)<br>(no schedule — pays off UCR) — 1 (100.0%) |

> 2 carrier(s) above would have been undercounted by the strict substring rule, by 47 plans in total: **Health Choice** (0→9), **United Concordia TDP & Active Duty** (0→38).

## Plans on empty fee schedules

None. Every non-hidden schedule carrying a live plan prices at least one basket code.

## Flags

### Carriers

- **United Healthcare** — plans split across 3 different fee schedules
- **Blue Cross Blue Shield** — plans split across 3 different fee schedules
- **Health Choice** — **1 carrier record(s) and 9 plan(s) that the strict substring rule missed** — recovered by normalisation/alias
- **Choice Benefits** — no carrier record matches, even normalised and with aliases — the table does have: `90 DEGREE BENEFITS OKLAHOMA`, `BRIGHT BENEFITS`, `CAREINGTON BENEFIT SOLUTIONS`, `EMPLOYEE BENEFIT SERVICES INC aka EBSI`, `GBS GROUP BENEFIT SERVICES`, `HEALTHCHOICE`. If one of those is the payer, it needs an alias in `CARRIER_ALIASES`.
- **Cigna** — 1 plan(s) have no fee schedule attached — adjudicated off UCR; plans split across 3 different fee schedules
- **Aetna** — plans split across 3 different fee schedules
- **GEHA** — plans split across 2 different fee schedules
- **Delta Dental** — 1 plan(s) have no fee schedule attached — adjudicated off UCR; plans split across 8 different fee schedules
- **Anthem Blue Cross and Blue Shield** — no carrier record matches, even normalised and with aliases — the table does have: `ANTHEM BLUE CROSS`, `BLUE CROSS BLUE SHIELD FEP DENTAL`, `BLUE CROSS BLUE SHIELD FEP MEDICAL ARKANSAS`, `BLUE CROSS BLUE SHIELD OF ALABAMA`, `BLUE CROSS BLUE SHIELD OF ARKANSAS`, `BLUE CROSS BLUE SHIELD OF FLORIDA`. If one of those is the payer, it needs an alias in `CARRIER_ALIASES`.
- **Guardian** — plans split across 2 different fee schedules
- **Humana** — plans split across 2 different fee schedules
- **United Concordia TDP & Active Duty** — **3 carrier record(s) and 38 plan(s) that the strict substring rule missed** — recovered by normalisation/alias; plans split across 2 different fee schedules
- **MetLife** — 1 plan(s) have no fee schedule attached — adjudicated off UCR; plans split across 3 different fee schedules

### Data

- **The providers do not agree on a fee schedule**: `89` ×9 — the UCR schedule; `53` ×2 — 90.0% of UCR. Open Dental prices a procedure from the fee schedule of whichever provider is credited with it, so the same procedure bills differently depending on who did it. 2 provider(s) are not on `89`.
- **11 fee row(s) across all schedules carry an Amount of 0.00** on a basket code. Open Dental stores an unset fee as 0.00, so these are read as "not priced" rather than "free" and are excluded from coverage.
- **The most-used schedule across _all_ non-hidden plans is `87`, not the UCR schedule `89`.** That is normal at a practice whose book is mostly PPO, but worth noticing: it means most plans are written against a discounted schedule rather than the office's own fee.

## Assumptions and method

1. **UCR is READ from `provider.FeeSched`, and cross-checked.** In Open Dental UCR is a **provider** attribute — there is no practice-level default, which was established by sweeping all ~1,250 `/preferences`: the fee-schedule-shaped ones are behavioural switches (`InsPpoAlwaysUseUcrFee`, `InsBlueBookUcrFeePercent`, `CoPay_FeeSchedule_BlankLikeZero`) and none names a schedule. modal FeeSched among non-hidden plans with blank PlanType (72 of 86 such plans) — chosen over the providers' schedule by `--ucr-source inference` (they agree, so it makes no difference). Hidden and non-person providers (labs, equipment) are excluded so a retired dentist's stale schedule cannot outvote the people producing.
   The previous insurance-plan inference is kept as an **independent cross-check**: modal FeeSched among non-hidden plans with blank PlanType (72 of 86 such plans) → `89`. It agrees with the providers.

   Blank-PlanType plans point at: `89` ×72, `53` ×10, `87` ×1.

   `/providers` is read for `ProvNum`, `FeeSched`, `IsHidden` and `IsNotPerson` only. The response also carries staff names and SSN; none is read, retained, logged or reported, and `Abbr` is excluded too because at a small practice an abbreviation is a person's name.

2. **A fee of 0.00 is "not priced", not "free".** Open Dental cannot distinguish the two; scoring 0.00 as a real fee would drag a schedule's percentage toward zero for codes it simply never filled in.
3. **Only practice-wide fee rows are scored** — ClinicNum 0 and ProvNum 0. Clinic- and provider-specific overrides are counted and flagged, never averaged in.
4. **The basket is fixed, not derived.** Deriving weights from this practice's procedurelog would require patient-scoped reads this analysis does not make, and would make the two offices incomparable.
5. **`AllowedFeeSched` does not exist** on the cloud API's `/insplans` response. The live shape carries `FeeSched`, `CopayFeeSched` and `ManualFeeSchedNum`; the last was read in its place. Plan counts above key on `FeeSched`.
6. **`/fees` was fetched per basket code**, not swept whole — ~22 filtered requests instead of ~360 pages for the same answer. Every filter is re-applied locally, because Open Dental list filters are sometimes silently ignored.
7. **Carrier matching is NORMALISED substring on `CarrierName`** — both sides reduced to letters and digits before comparison — plus an explicit alias table. The original literal substring rule undercounted: the table spells it `HEALTHCHOICE`, so "Health Choice" matched nothing at all. The strict count is reported beside the real one in every row and in `carriers.csv` so the difference is visible. Aliases in effect: "Health Choice" → `HEALTHCHOICE`; "Principal Life Insurance Company" → `PRINCIPAL`; "United Concordia TDP & Active Duty" → `UNITED CONCORDIA`.
   Overlap is preserved, not deduplicated: "Anthem" matches the same `ANTHEM BLUE CROSS BLUE SHIELD` record that "Blue Cross Blue Shield" does, and both rows count it. "Anthem Blue Cross and Blue Shield" is deliberately **not** aliased — the table has no "and", and aliasing it would double-count that record under two listed names with no way to see it had happened.

## Scope of this run

- Office: `valley` (Valley Fort Smith) — its own Open Dental database, asserted via `assertOfficeMatch`. Roland and Riley are never merged.
- 37 fee schedules (15 hidden), 1487 insurance plans (1443 non-hidden), 142 carrier records, 11 non-hidden providers.
- Read-only: every call is `apiGetRaw`. No POST, PUT or DELETE exists in this script.
- Resources read: `/feescheds`, `/fees`, `/procedurecodes`, `/carriers`, `/insplans`, `/providers` — all practice configuration.
- No patient-scoped endpoint was called and no patient data appears in any output.

