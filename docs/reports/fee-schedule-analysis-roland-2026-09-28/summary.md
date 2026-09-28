# Fee schedule analysis — Roland (`roland`)

Generated 2026-09-28 · read-only · 55 Open Dental GET requests · 65.3s

**UCR schedule: `78` — Standard 6-2023**  
Read from `provider.FeeSched`. provider.FeeSched — all 9 non-hidden providers carry one, and they DISAGREE; the modal value is set on 8 of them.

⚠️ **The two routes DISAGREE.** The providers carry `78`, but the insurance-plan inference points at `92` (modal FeeSched among non-hidden plans with blank PlanType (60 of 70 such plans)). The providers win — that is what Open Dental actually prices new procedures from — but the gap means either the providers are on a stale schedule or the plan population has moved onto a newer one. **Confirm by hand before acting on the ranking.**

Providers (9 non-hidden, excluding non-person entries) carry: `78` ×8, `98` ×1 — **they do not all agree**; the modal value is used.

Every percentage below is **weighted % of that UCR schedule**, over a fixed 22-code general-practice basket, computed only across codes priced in _both_ schedules. Higher is better: 100% means the schedule pays the office's own full fee.

## Schedules ranked, high → low

Schedules pricing at least 12 of the 22 basket codes. 40 of 52 qualify.

| # | Fee schedule | Plans | Cov. | **% UCR** | Hygiene | Restorative | |
|---:|---|---:|---:|---:|---:|---:|---|
| 1 | Standard Fees 04/2025 (`92`) | 380 | 22/22 | **111.8%** | 111.0% | 112.0% |  |
| 2 | Standard 6-2023 (`78`) | 3 | 22/22 | **100.0%** | 100.0% | 100.0% | **UCR** |
| 3 | Valley family Dental ( Smile Savers) (`77`) | 0 | 22/22 | **99.4%** | 97.4% | 100.0% |  |
| 4 | Test Connection Dental 2025 (`99`) | 0 | 22/22 | **98.2%** | 94.6% | 99.2% | hidden |
| 5 | Connection Dental 2025 new Fee Schedule (Plan #14600) (`98`) | 0 | 22/22 | **98.2%** | 94.6% | 99.2% |  |
| 6 | Standard 2/2021 (`53`) | 1 | 22/22 | **95.8%** | 93.0% | 96.6% |  |
| 7 | United Healthcare 2023 (`81`) | 0 | 22/22 | **94.5%** | 88.4% | 96.1% |  |
| 8 | Careington CP50 (`74`) | 312 | 20/22 | **90.9%** | 86.5% | 92.2% |  |
| 9 | Mutual of Omaha 10/2023 (`88`) | 0 | 20/22 | **90.9%** | 86.5% | 92.2% |  |
| 10 | Test Good-Luck-Dental-Ins (`100`) | 0 | 21/22 | **82.0%** | 73.6% | 84.7% | hidden |
| 11 | Zelis 07/2024 (`73`) | 47 | 22/22 | **76.1%** | 67.6% | 78.5% |  |
| 12 | Aetna 2024 (`79`) | 68 | 22/22 | **73.0%** | 61.7% | 76.2% |  |
| 13 | Healthchoice (`56`) | 25 | 22/22 | **72.9%** | 72.0% | 73.1% |  |
| 14 | Arkansas BCBS Blue/Grid + 10/2023 (`86`) | 158 | 22/22 | **72.7%** | 56.6% | 77.2% |  |
| 15 | Cigna PPO 2023 (`55`) | 0 | 22/22 | **70.9%** | 64.6% | 72.7% |  |
| 16 | DNOA-UC-BCBS '20 (`57`) | 0 | 22/22 | **69.0%** | 55.7% | 72.7% |  |
| 17 | Test Payless Dental Fee Schedule (Plan #14590) (`96`) | 0 | 22/22 | **66.9%** | 59.2% | 69.0% | hidden |
| 18 | Test Fee Schedule (`93`) | 0 | 22/22 | **66.9%** | 59.2% | 69.0% | hidden |
| 19 | Municipal Health 10/2023 (`89`) | 3 | 22/22 | **60.7%** | 53.3% | 62.7% |  |
| 20 | Arkansas BCBS PPP General 10/2023 (`85`) | 0 | 22/22 | **60.5%** | 52.9% | 62.5% |  |
| 21 | Delta Arkansas/PREMIER 09/2023 (`71`) | 193 | 22/22 | **60.4%** | 53.3% | 62.3% |  |
| 22 | Delta Arkansas /PPO '20 (`54`) | 25 | 22/22 | **59.9%** | 54.8% | 61.3% |  |
| 23 | Delta Oklahoma '23 (`72`) | 113 | 22/22 | **59.7%** | 54.4% | 61.2% |  |
| 24 | Test-PaylessDental (`103`) | 0 | 13/22 | **57.3%** | 48.9% | 59.6% |  |
| 25 | Connection Dental 2024 (`68`) | 269 | 22/22 | **56.2%** | 53.9% | 56.9% |  |
| 26 | Arkansas BCBS Medicare Advantage 10/2023 (`87`) | 0 | 22/22 | **56.0%** | 49.1% | 57.9% | hidden |
| 27 | Test-PaylesDental (`101`) | 0 | 21/22 | **55.7%** | 50.1% | 57.5% | hidden |
| 28 | Test_PaylessDental_v3 (`104`) | 0 | 21/22 | **55.7%** | 50.1% | 57.5% |  |
| 29 | Test-PaylessDental-v4 (`105`) | 0 | 21/22 | **55.7%** | 50.1% | 57.5% |  |
| 30 | Arkansas BCBS PPO General 10/2023 (`83`) | 2 | 22/22 | **54.2%** | 47.8% | 55.9% |  |
| 31 | MetLife 2023 (`80`) | 0 | 22/22 | **54.0%** | 48.5% | 55.6% |  |
| 32 | DNOA BCBS OK/TX/IL/MI/NM/KS (`82`) | 8 | 22/22 | **50.7%** | 46.3% | 51.9% |  |
| 33 | Dentemax (`60`) | 3 | 19/22 | **46.5%** | 43.8% | 47.6% |  |
| 34 | United Concordia/TDP/Tricare ONLY (`64`) | 11 | 22/22 | **45.6%** | 40.5% | 47.0% |  |
| 35 | Soonercare CHILD 1/23 (`58`) | 4 | 20/22 | **45.2%** | 41.0% | 46.3% |  |
| 36 | MCNA Ark Medicaid 09-2023 (`67`) | 2 | 20/22 | **44.2%** | 43.6% | 44.5% |  |
| 37 | Soonercare ADULT 1/23 (`76`) | 4 | 18/22 | **43.1%** | 44.6% | 42.1% |  |
| 38 | Delta Dental SMILES Child 21- (`70`) | 1 | 17/22 | **41.8%** | 44.5% | 39.5% |  |
| 39 | Delta Dental SMILES ADULT 21+ (`66`) | 1 | 14/22 | **40.2%** | 45.8% | 35.1% |  |
| 40 | Delta Dental of OK Copay (`63`) | 0 | 22/22 | **16.8%** | 8.1% | 19.2% |  |

## Low coverage — not ranked

Fewer than 12 basket codes priced against UCR. The percentage, where one exists, is arithmetic on too few codes to rank against the others.

| Fee schedule | Plans | Cov. | % UCR | |
|---|---:|---:|---:|---|
| Assruant supplemental (`61`) | 0 | 4/22 | 28.2% | hidden |
| APL (`65`) | 0 | 1/22 | 25.4% | hidden |
| Rural Carrier Benefit (`69`) | 0 | 1/22 | 21.2% | hidden |
| Dental Dental choice out of network (`62`) | 0 | 6/22 | 8.2% |  |
| TEST TEST Fee Schedule (Plan #14586) (`94`) | 0 | 0/22 | — | hidden, no basket fees at all |
| Arkansas BCBS PPO Specialist 10/2023  (`84`) | 0 | 0/22 | — | hidden, no basket fees at all |
| aetna (`59`) | 0 | 0/22 | — | hidden, no basket fees at all |
| Connection Dental 2025 (`97`) | 20 | 0/22 | — | no basket fees at all |
| Smile Savers  (`75`) | 0 | 0/22 | — | hidden, no basket fees at all |
| UHC Medicaid AR/OK 10/2023 (`90`) | 0 | 0/22 | — | hidden, no basket fees at all |
| Employee Dental  (`91`) | 0 | 0/22 | — | no basket fees at all |
| API_TEST_1763583744397_SAFE_TO_DELETE (`102`) | 0 | 0/22 | — | hidden, no basket fees at all |

## The carrier list

In the order given. "Plans" counts non-hidden insurance plans across every carrier record matching the listed name — **normalised** (both sides reduced to letters and digits) plus any alias. "Strict" is what the literal case-insensitive substring rule alone would have found; where the two differ, the strict rule was undercounting. "Effective %" is the matched plans' plan-count-weighted average of the schedules they actually sit on.

| Carrier | Recs | Plans | Strict | Effective % UCR | Schedules actually used |
|---|---:|---:|---:|---:|---|
| **United Healthcare** | 2 | 90 | 90 | 91.2% | Careington CP50 — 78 (90.9%)<br>Connection Dental 2025 — 7 (—)<br>Standard Fees 04/2025 — 2 (111.8%)<br>Standard 6-2023 — 1 (100.0%)<br>_+2 more_ |
| **Blue Cross Blue Shield** | 21 | 308 | 308 | 71.1% | Arkansas BCBS Blue/Grid + 10/2023 — 158 (72.7%)<br>Connection Dental 2024 — 102 (56.2%)<br>Standard Fees 04/2025 — 35 (111.8%)<br>DNOA BCBS OK/TX/IL/MI/NM/KS — 8 (50.7%)<br>_+3 more_ |
| **Health Choice** | 1 | 26 | **0** | 73.8% | Healthchoice — 25 (72.9%)<br>Standard 2/2021 — 1 (95.8%) |
| **Choice Benefits** | 0 | 0 | 0 | — | — |
| **Cigna** | 1 | 63 | 63 | 90.6% | Careington CP50 — 57 (90.9%)<br>Connection Dental 2025 — 4 (—)<br>Standard Fees 04/2025 — 1 (111.8%)<br>Connection Dental 2024 — 1 (56.2%) |
| **Aetna** | 4 | 81 | 81 | 58.3% | Connection Dental 2024 — 76 (56.2%)<br>Standard Fees 04/2025 — 3 (111.8%)<br>Connection Dental 2025 — 2 (—) |
| **GEHA** | 2 | 4 | 4 | 84.0% | Connection Dental 2024 — 2 (56.2%)<br>Standard Fees 04/2025 — 2 (111.8%) |
| **Ameritas** | 1 | 38 | 38 | 79.9% | Zelis 07/2024 — 34 (76.1%)<br>Standard Fees 04/2025 — 4 (111.8%) |
| **Delta Dental** | 38 | 511 | 511 | 78.0% | Delta Arkansas/PREMIER 09/2023 — 193 (60.4%)<br>Standard Fees 04/2025 — 176 (111.8%)<br>Delta Oklahoma '23 — 113 (59.7%)<br>Delta Arkansas /PPO '20 — 25 (59.9%)<br>_+4 more_ |
| **Anthem Blue Cross and Blue Shield** | 0 | 0 | 0 | — | — |
| **Anthem** | 1 | 16 | 16 | 72.7% | Arkansas BCBS Blue/Grid + 10/2023 — 16 (72.7%) |
| **Guardian** | 1 | 70 | 70 | 74.4% | Aetna 2024 — 67 (73.0%)<br>Standard Fees 04/2025 — 2 (111.8%)<br>Careington CP50 — 1 (90.9%) |
| **Principal Life Insurance Company** | 1 | 25 | **0** | 56.2% | Connection Dental 2024 — 25 (56.2%) |
| **Humana** | 3 | 65 | 65 | 62.8% | Connection Dental 2024 — 53 (56.2%)<br>Standard Fees 04/2025 — 6 (111.8%)<br>Connection Dental 2025 — 4 (—)<br>Careington CP50 — 2 (90.9%) |
| **United Concordia TDP & Active Duty** | 4 | 20 | **0** | 68.8% | Zelis 07/2024 — 13 (76.1%)<br>United Concordia/TDP/Tricare ONLY — 6 (45.6%)<br>Standard Fees 04/2025 — 1 (111.8%) |
| **Lincoln Financial Group** | 1 | 5 | 5 | 95.0% | Careington CP50 — 4 (90.9%)<br>Standard Fees 04/2025 — 1 (111.8%) |
| **MetLife** | 1 | 131 | 131 | 90.3% | Careington CP50 — 127 (90.9%)<br>Connection Dental 2024 — 2 (56.2%)<br>Connection Dental 2025 — 2 (—) |

> 3 carrier(s) above would have been undercounted by the strict substring rule, by 71 plans in total: **Health Choice** (0→26), **Principal Life Insurance Company** (0→25), **United Concordia TDP & Active Duty** (0→20).

## Plans on empty fee schedules

**1 non-hidden schedule(s) carry live plans but price none of the 22 basket codes.** A plan pointed at an empty schedule has nothing to adjudicate against, so what it actually pays is not what the setup intends. Worth checking in Open Dental before anything else here.

| Fee schedule | Live plans | Carriers on it |
|---|---:|---|
| Connection Dental 2025 (`97`) | 20 | AETNA MEDICARE; BLUE CROSS BLUE SHIELD OF ARKANSAS; CIGNA; HUMANA DENTAL; METLIFE DENTAL; UNITED HEALTHCARE DENTAL COMMERCIAL & HMO; UNITED HEALTHCARE DUAL COMPLETE PLANS |

## Flags

### Carriers

- **United Healthcare** — 1 plan(s) have no fee schedule attached — adjudicated off UCR; plans split across 6 different fee schedules; effective % covers only 83 of 90 plans (the rest sit on schedules too thin to score)
- **Blue Cross Blue Shield** — plans split across 7 different fee schedules; effective % covers only 307 of 308 plans (the rest sit on schedules too thin to score)
- **Health Choice** — **1 carrier record(s) and 26 plan(s) that the strict substring rule missed** — recovered by normalisation/alias; plans split across 2 different fee schedules
- **Choice Benefits** — no carrier record matches, even normalised and with aliases — the table does have: `AMALGAMATED EMPLOYEE BENEFITS`, `CAREINGTON BENEFIT SOLUTIONS`, `CONSOLIDATED BENEFITS RESOURCES`, `CS BENEFITS`, `GBS GROUP BENEFITS SERVICES`, `HEALTHCHOICE`. If one of those is the payer, it needs an alias in `CARRIER_ALIASES`.
- **Cigna** — plans split across 4 different fee schedules; effective % covers only 59 of 63 plans (the rest sit on schedules too thin to score)
- **Aetna** — plans split across 3 different fee schedules; effective % covers only 79 of 81 plans (the rest sit on schedules too thin to score)
- **GEHA** — plans split across 2 different fee schedules
- **Ameritas** — plans split across 2 different fee schedules
- **Delta Dental** — 1 plan(s) have no fee schedule attached — adjudicated off UCR; plans split across 8 different fee schedules; effective % covers only 510 of 511 plans (the rest sit on schedules too thin to score)
- **Anthem Blue Cross and Blue Shield** — no carrier record matches, even normalised and with aliases — the table does have: `ANTHEM BLUE CROSS BLUE SHIELD`, `BLUE CROSS BLUE SHIELD FEP DENTAL`, `BLUE CROSS BLUE SHIELD FEP MEDICAL ARKANSAS`, `BLUE CROSS BLUE SHIELD FEP MEDICAL OKLAHOMA`, `BLUE CROSS BLUE SHIELD OF ALABAMA`, `BLUE CROSS BLUE SHIELD OF ARKANSAS`. If one of those is the payer, it needs an alias in `CARRIER_ALIASES`.
- **Guardian** — plans split across 3 different fee schedules
- **Principal Life Insurance Company** — **1 carrier record(s) and 25 plan(s) that the strict substring rule missed** — recovered by normalisation/alias
- **Humana** — plans split across 4 different fee schedules; effective % covers only 61 of 65 plans (the rest sit on schedules too thin to score)
- **United Concordia TDP & Active Duty** — **4 carrier record(s) and 20 plan(s) that the strict substring rule missed** — recovered by normalisation/alias; plans split across 3 different fee schedules
- **Lincoln Financial Group** — plans split across 2 different fee schedules
- **MetLife** — plans split across 3 different fee schedules; effective % covers only 129 of 131 plans (the rest sit on schedules too thin to score)

### Data

- **The providers do not agree on a fee schedule**: `78` ×8, `98` ×1. The modal value is used as UCR. A hygienist or associate on a different schedule than the owner prices the same procedure differently depending on who is credited with it.
- **UCR routes disagree**: providers say `78`, the insurance-plan inference says `92`. See the header — every percentage in this report is relative to the providers' schedule.
- **1 schedule(s) score ABOVE 100% of the schedule named as UCR** — highest is `92` Standard Fees 04/2025 at 111.8% on 380 live plans. A payer does not allow more than the practice charges, so this is the signature of a **stale UCR**: the schedule named as UCR is almost certainly an older fee schedule the providers were never moved off, and the practice's real current fee is the higher one. Open Dental prices new procedures from `provider.FeeSched`, so if that is what happened the practice is charging the older fees. **Re-run with `--ucr 92` to see the ranking against that schedule instead.**
- **3 fee row(s) across all schedules carry an Amount of 0.00** on a basket code. Open Dental stores an unset fee as 0.00, so these are read as "not priced" rather than "free" and are excluded from coverage.
- **The most-used schedule across _all_ non-hidden plans is `92`, not the UCR schedule `78`.** That is normal at a practice whose book is mostly PPO, but worth noticing: it means most plans are written against a discounted schedule rather than the office's own fee.

## Assumptions and method

1. **UCR is READ from `provider.FeeSched`, and cross-checked.** In Open Dental UCR is a **provider** attribute — there is no practice-level default, which was established by sweeping all ~1,250 `/preferences`: the fee-schedule-shaped ones are behavioural switches (`InsPpoAlwaysUseUcrFee`, `InsBlueBookUcrFeePercent`, `CoPay_FeeSchedule_BlankLikeZero`) and none names a schedule. provider.FeeSched — all 9 non-hidden providers carry one, and they DISAGREE; the modal value is set on 8 of them. Hidden and non-person providers (labs, equipment) are excluded so a retired dentist's stale schedule cannot outvote the people producing.
   The previous insurance-plan inference is kept as an **independent cross-check**: modal FeeSched among non-hidden plans with blank PlanType (60 of 70 such plans) → `92`. **It disagrees** — see the header and Flags.

   Blank-PlanType plans point at: `92` ×60, `78` ×3, `53` ×1, `64` ×1.

   `/providers` is read for `ProvNum`, `FeeSched`, `IsHidden` and `IsNotPerson` only. The response also carries staff names and SSN; none is read, retained, logged or reported, and `Abbr` is excluded too because at a small practice an abbreviation is a person's name.

2. **A fee of 0.00 is "not priced", not "free".** Open Dental cannot distinguish the two; scoring 0.00 as a real fee would drag a schedule's percentage toward zero for codes it simply never filled in.
3. **Only practice-wide fee rows are scored** — ClinicNum 0 and ProvNum 0. Clinic- and provider-specific overrides are counted and flagged, never averaged in.
4. **The basket is fixed, not derived.** Deriving weights from this practice's procedurelog would require patient-scoped reads this analysis does not make, and would make the two offices incomparable.
5. **`AllowedFeeSched` does not exist** on the cloud API's `/insplans` response. The live shape carries `FeeSched`, `CopayFeeSched` and `ManualFeeSchedNum`; the last was read in its place. Plan counts above key on `FeeSched`.
6. **`/fees` was fetched per basket code**, not swept whole — ~22 filtered requests instead of ~360 pages for the same answer. Every filter is re-applied locally, because Open Dental list filters are sometimes silently ignored.
7. **Carrier matching is NORMALISED substring on `CarrierName`** — both sides reduced to letters and digits before comparison — plus an explicit alias table. The original literal substring rule undercounted: the table spells it `HEALTHCHOICE`, so "Health Choice" matched nothing at all. The strict count is reported beside the real one in every row and in `carriers.csv` so the difference is visible. Aliases in effect: "Health Choice" → `HEALTHCHOICE`; "Principal Life Insurance Company" → `PRINCIPAL`; "United Concordia TDP & Active Duty" → `UNITED CONCORDIA`.
   Overlap is preserved, not deduplicated: "Anthem" matches the same `ANTHEM BLUE CROSS BLUE SHIELD` record that "Blue Cross Blue Shield" does, and both rows count it. "Anthem Blue Cross and Blue Shield" is deliberately **not** aliased — the table has no "and", and aliasing it would double-count that record under two listed names with no way to see it had happened.

## Scope of this run

- Office: `roland` (Roland) — its own Open Dental database, asserted via `assertOfficeMatch`. Roland and Riley are never merged.
- 52 fee schedules (15 hidden), 1790 insurance plans (1667 non-hidden), 176 carrier records, 9 non-hidden providers.
- Read-only: every call is `apiGetRaw`. No POST, PUT or DELETE exists in this script.
- Resources read: `/feescheds`, `/fees`, `/procedurecodes`, `/carriers`, `/insplans`, `/providers` — all practice configuration.
- No patient-scoped endpoint was called and no patient data appears in any output.

