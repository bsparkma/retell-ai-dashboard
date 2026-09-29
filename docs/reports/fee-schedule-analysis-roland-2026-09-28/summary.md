# Fee schedule analysis — Roland (`roland`)

Generated 2026-09-28 · read-only · 55 Open Dental GET requests · 78.2s

**UCR schedule: `92` — Standard Fees 04/2025**  
How it was chosen: explicit --ucr 92.

✅ **The two independent routes agree.** The providers' schedule and the insurance-plan inference (modal FeeSched among non-hidden plans with blank PlanType (60 of 70 such plans)) both land on `92`.

Providers (9 non-hidden, excluding non-person entries) carry: `92` ×7, `78` ×2 — **they do not all agree**; the modal value is used.

Every percentage below is **weighted % of that UCR schedule**, over a fixed 22-code general-practice basket, computed only across codes priced in _both_ schedules. Higher is better: 100% means the schedule pays the office's own full fee.

## Schedules ranked, high → low

Schedules pricing at least 12 of the 22 basket codes. 40 of 52 qualify.

| # | Fee schedule | Plans | Cov. | **% UCR** | Hygiene | Restorative | |
|---:|---|---:|---:|---:|---:|---:|---|
| 1 | Standard Fees 04/2025 (`92`) | 380 | 22/22 | **100.0%** | 100.0% | 100.0% | **UCR** |
| 2 | Standard 6-2023 (`78`) | 3 | 22/22 | **89.4%** | 90.1% | 89.3% |  |
| 3 | Valley family Dental ( Smile Savers) (`77`) | 0 | 22/22 | **88.9%** | 87.7% | 89.3% |  |
| 4 | Test Connection Dental 2025 (`99`) | 0 | 22/22 | **87.9%** | 85.2% | 88.6% | hidden |
| 5 | Connection Dental 2025 new Fee Schedule (Plan #14600) (`98`) | 0 | 22/22 | **87.9%** | 85.2% | 88.6% |  |
| 6 | Standard 2/2021 (`53`) | 1 | 22/22 | **85.7%** | 83.7% | 86.2% |  |
| 7 | United Healthcare 2023 (`81`) | 0 | 22/22 | **84.5%** | 79.6% | 85.8% |  |
| 8 | Careington CP50 (`74`) | 312 | 20/22 | **80.9%** | 77.9% | 81.8% |  |
| 9 | Mutual of Omaha 10/2023 (`88`) | 0 | 20/22 | **80.9%** | 77.9% | 81.8% |  |
| 10 | Test Good-Luck-Dental-Ins (`100`) | 0 | 21/22 | **73.1%** | 66.3% | 75.2% | hidden |
| 11 | Zelis 07/2024 (`73`) | 47 | 22/22 | **68.1%** | 60.9% | 70.1% |  |
| 12 | Aetna 2024 (`79`) | 68 | 22/22 | **65.3%** | 55.6% | 68.0% |  |
| 13 | Healthchoice (`56`) | 25 | 22/22 | **65.2%** | 64.9% | 65.3% |  |
| 14 | Arkansas BCBS Blue/Grid + 10/2023 (`86`) | 158 | 22/22 | **65.0%** | 51.0% | 68.9% |  |
| 15 | Cigna PPO 2023 (`55`) | 0 | 22/22 | **63.5%** | 58.2% | 64.9% |  |
| 16 | DNOA-UC-BCBS '20 (`57`) | 0 | 22/22 | **61.7%** | 50.1% | 64.9% |  |
| 17 | Test Payless Dental Fee Schedule (Plan #14590) (`96`) | 0 | 22/22 | **59.8%** | 53.3% | 61.6% | hidden |
| 18 | Test Fee Schedule (`93`) | 0 | 22/22 | **59.8%** | 53.3% | 61.6% | hidden |
| 19 | Municipal Health 10/2023 (`89`) | 3 | 22/22 | **54.3%** | 48.0% | 56.0% |  |
| 20 | Arkansas BCBS PPP General 10/2023 (`85`) | 0 | 22/22 | **54.1%** | 47.7% | 55.8% |  |
| 21 | Delta Arkansas/PREMIER 09/2023 (`71`) | 193 | 22/22 | **54.0%** | 48.0% | 55.6% |  |
| 22 | Delta Arkansas /PPO '20 (`54`) | 25 | 22/22 | **53.5%** | 49.3% | 54.7% |  |
| 23 | Delta Oklahoma '23 (`72`) | 113 | 22/22 | **53.4%** | 49.0% | 54.6% |  |
| 24 | Connection Dental 2024 (`68`) | 269 | 22/22 | **50.3%** | 48.6% | 50.7% |  |
| 25 | Arkansas BCBS Medicare Advantage 10/2023 (`87`) | 0 | 22/22 | **50.1%** | 44.3% | 51.6% | hidden |
| 26 | Test-PaylesDental (`101`) | 0 | 21/22 | **49.7%** | 45.2% | 51.1% | hidden |
| 27 | Test-PaylessDental (`103`) | 0 | 21/22 | **49.7%** | 45.2% | 51.1% |  |
| 28 | Test_PaylessDental_v3 (`104`) | 0 | 21/22 | **49.7%** | 45.2% | 51.1% |  |
| 29 | Test-PaylessDental-v4 (`105`) | 0 | 21/22 | **49.7%** | 45.2% | 51.1% |  |
| 30 | Arkansas BCBS PPO General 10/2023 (`83`) | 2 | 22/22 | **48.4%** | 43.1% | 49.9% |  |
| 31 | MetLife 2023 (`80`) | 0 | 22/22 | **48.3%** | 43.7% | 49.6% |  |
| 32 | DNOA BCBS OK/TX/IL/MI/NM/KS (`82`) | 8 | 22/22 | **45.3%** | 41.7% | 46.3% |  |
| 33 | Dentemax (`60`) | 3 | 19/22 | **41.6%** | 39.4% | 42.4% |  |
| 34 | United Concordia/TDP/Tricare ONLY (`64`) | 11 | 22/22 | **40.8%** | 36.5% | 42.0% |  |
| 35 | Soonercare CHILD 1/23 (`58`) | 4 | 20/22 | **40.2%** | 37.0% | 41.1% |  |
| 36 | MCNA Ark Medicaid 09-2023 (`67`) | 2 | 20/22 | **39.5%** | 39.3% | 39.6% |  |
| 37 | Soonercare ADULT 1/23 (`76`) | 4 | 18/22 | **38.3%** | 40.2% | 37.0% |  |
| 38 | Delta Dental SMILES Child 21- (`70`) | 1 | 17/22 | **37.2%** | 40.2% | 34.7% |  |
| 39 | Delta Dental SMILES ADULT 21+ (`66`) | 1 | 14/22 | **35.6%** | 41.0% | 30.8% |  |
| 40 | Delta Dental of OK Copay (`63`) | 0 | 22/22 | **15.0%** | 7.3% | 17.2% |  |

## Low coverage — not ranked

Fewer than 12 basket codes priced against UCR. The percentage, where one exists, is arithmetic on too few codes to rank against the others.

| Fee schedule | Plans | Cov. | % UCR | |
|---|---:|---:|---:|---|
| Assruant supplemental (`61`) | 0 | 4/22 | 24.8% | hidden |
| APL (`65`) | 0 | 1/22 | 22.1% | hidden |
| Rural Carrier Benefit (`69`) | 0 | 1/22 | 18.4% | hidden |
| Dental Dental choice out of network (`62`) | 0 | 6/22 | 7.2% |  |
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
| **United Healthcare** | 2 | 90 | 90 | 81.4% | Careington CP50 — 78 (80.9%)<br>Connection Dental 2025 — 7 (—)<br>Standard Fees 04/2025 — 2 (100.0%)<br>Standard 6-2023 — 1 (89.4%)<br>_+2 more_ |
| **Blue Cross Blue Shield** | 21 | 308 | 308 | 63.6% | Arkansas BCBS Blue/Grid + 10/2023 — 158 (65.0%)<br>Connection Dental 2024 — 102 (50.3%)<br>Standard Fees 04/2025 — 35 (100.0%)<br>DNOA BCBS OK/TX/IL/MI/NM/KS — 8 (45.3%)<br>_+3 more_ |
| **Health Choice** | 1 | 26 | **0** | 66.0% | Healthchoice — 25 (65.2%)<br>Standard 2/2021 — 1 (85.7%) |
| **Choice Benefits** | 0 | 0 | 0 | — | — |
| **Cigna** | 1 | 63 | 63 | 80.7% | Careington CP50 — 57 (80.9%)<br>Connection Dental 2025 — 4 (—)<br>Standard Fees 04/2025 — 1 (100.0%)<br>Connection Dental 2024 — 1 (50.3%) |
| **Aetna** | 4 | 81 | 81 | 52.2% | Connection Dental 2024 — 76 (50.3%)<br>Standard Fees 04/2025 — 3 (100.0%)<br>Connection Dental 2025 — 2 (—) |
| **GEHA** | 2 | 4 | 4 | 75.1% | Connection Dental 2024 — 2 (50.3%)<br>Standard Fees 04/2025 — 2 (100.0%) |
| **Ameritas** | 1 | 38 | 38 | 71.4% | Zelis 07/2024 — 34 (68.1%)<br>Standard Fees 04/2025 — 4 (100.0%) |
| **Delta Dental** | 38 | 511 | 511 | 69.7% | Delta Arkansas/PREMIER 09/2023 — 193 (54.0%)<br>Standard Fees 04/2025 — 176 (100.0%)<br>Delta Oklahoma '23 — 113 (53.4%)<br>Delta Arkansas /PPO '20 — 25 (53.5%)<br>_+4 more_ |
| **Anthem Blue Cross and Blue Shield** | 0 | 0 | 0 | — | — |
| **Anthem** | 1 | 16 | 16 | 65.0% | Arkansas BCBS Blue/Grid + 10/2023 — 16 (65.0%) |
| **Guardian** | 1 | 70 | 70 | 66.5% | Aetna 2024 — 67 (65.3%)<br>Standard Fees 04/2025 — 2 (100.0%)<br>Careington CP50 — 1 (80.9%) |
| **Principal Life Insurance Company** | 1 | 25 | **0** | 50.3% | Connection Dental 2024 — 25 (50.3%) |
| **Humana** | 3 | 65 | 65 | 56.2% | Connection Dental 2024 — 53 (50.3%)<br>Standard Fees 04/2025 — 6 (100.0%)<br>Connection Dental 2025 — 4 (—)<br>Careington CP50 — 2 (80.9%) |
| **United Concordia TDP & Active Duty** | 4 | 20 | **0** | 61.5% | Zelis 07/2024 — 13 (68.1%)<br>United Concordia/TDP/Tricare ONLY — 6 (40.8%)<br>Standard Fees 04/2025 — 1 (100.0%) |
| **Lincoln Financial Group** | 1 | 5 | 5 | 84.8% | Careington CP50 — 4 (80.9%)<br>Standard Fees 04/2025 — 1 (100.0%) |
| **MetLife** | 1 | 131 | 131 | 80.5% | Careington CP50 — 127 (80.9%)<br>Connection Dental 2024 — 2 (50.3%)<br>Connection Dental 2025 — 2 (—) |

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

- **The providers do not agree on a fee schedule**: `92` ×7 — the UCR schedule; `78` ×2 — 89.4% of UCR. Open Dental prices a procedure from the fee schedule of whichever provider is credited with it, so the same procedure bills differently depending on who did it. 2 provider(s) are not on `92`.
- **3 fee row(s) across all schedules carry an Amount of 0.00** on a basket code. Open Dental stores an unset fee as 0.00, so these are read as "not priced" rather than "free" and are excluded from coverage.

## Assumptions and method

1. **UCR is READ from `provider.FeeSched`, and cross-checked.** In Open Dental UCR is a **provider** attribute — there is no practice-level default, which was established by sweeping all ~1,250 `/preferences`: the fee-schedule-shaped ones are behavioural switches (`InsPpoAlwaysUseUcrFee`, `InsBlueBookUcrFeePercent`, `CoPay_FeeSchedule_BlankLikeZero`) and none names a schedule. explicit --ucr 92. Hidden and non-person providers (labs, equipment) are excluded so a retired dentist's stale schedule cannot outvote the people producing.
   The previous insurance-plan inference is kept as an **independent cross-check**: modal FeeSched among non-hidden plans with blank PlanType (60 of 70 such plans) → `92`. It agrees with the providers.

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

