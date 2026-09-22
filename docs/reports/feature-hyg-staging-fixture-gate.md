# Item 20: staging refuses hygiene Open Dental writes for anyone but the test patients

Branch `feature/hyg-staging-fixture-gate`, off `origin/develop` at 9bf52f5 (#184, #185 and #187 merged).
PR #189 to `develop`, not merged.

## 1. What changed, in one paragraph

Once this deploys, staging refuses every hygiene Open Dental write for anyone who is not a designated test patient. It needs no setting from you. It knows it is staging from its Key Vault name. Each refusal is a 422 whose sentence names the rule, the whole request stops before anything is written, and it is logged in the audit trail as a denial. The refusal appears beside Send on the visit page and on the perio chart page. Prod is unchanged. The test-patient list now exists in one file, and the probe scripts and the gate both read it.

## 2. How the running app knows it is staging (acceptance 7)

`NODE_ENV` is no help, because staging runs `NODE_ENV=production` too; that setting is what turns on Key Vault loading. The marker the platform already carries is the Key Vault each app loads its secrets from. I read these off the container apps on 2026-09-21 (plain env values, no secrets):

| Container app | `NODE_ENV` | `AZURE_KEY_VAULT_NAME` | `HYG_OD_WRITES_FIXTURES_ONLY` |
|---|---|---|---|
| `ca-carein-backend` (rg-carein-staging) | production | **kv-carein-staging** | not set |
| `ca-carein-prod-backend` (rg-carein-prod) | production | **kv-carein-prod** | not set |

`services/rcm/postingDrain.js` (`isNonProdEnvironment`) already relies on this marker to keep its kill-test delay off prod. The gate uses it more narrowly: when the switch is unset, the gate is on only when the vault name contains `staging`. It has to be that narrow because the RCM helper also treats every non-production `NODE_ENV` as not-prod. That would switch this gate on for every dev box and every test run.

## 3. The switch

`backend/config/hygFixtureGate.js` reads the switch on every call and never caches it at boot:

| `HYG_OD_WRITES_FIXTURES_ONLY` | Staging (vault says `staging`) | Anywhere else (prod, dev, tests) |
|---|---|---|
| `on` (any case, spaces ignored) | ON | ON |
| `off` (any case, spaces ignored) | OFF | OFF |
| anything else: `true`, `false`, `1`, `0`, `yes`, empty, a typo | **ON**, logged once per distinct value | **ON**, logged once |
| unset | **ON** | OFF |

An unrecognized value means ON. That deliberately reverses the `MANGO_INGEST_MODE` trap, where every typo silently resolves to off. Someone who sets this variable wants the rail, and a typo must not remove it. `false` and `0` count as unrecognized, so they switch the gate **on**. Only the literal `off` turns it off.

### What you need to set, and where

- **Staging: nothing.** With the variable unset, the gate is on from the first request after this merges and deploys.
- **Optional, as a second guarantee:** set `HYG_OD_WRITES_FIXTURES_ONLY=on` as a plain env var (not a secret) on `ca-carein-backend` in `rg-carein-staging`. The gate then stays on even if the vault is ever renamed. I did not change any Azure config.
- **Prod: nothing.** Do not set it there. Setting `on` on `ca-carein-prod-backend` would refuse every real patient's visit send.
- **To turn it off on staging deliberately:** set `off` on `ca-carein-backend`. That rolls a new revision.

## 4. Where it applies (acceptance 1–3)

Every hygiene entry point that can lead to an Open Dental write. The gate sits at the **service** layer, so a future route that calls these services cannot skip it:

| Entry point | Route | Gate |
|---|---|---|
| Visit send: note, routing slip, TC handoff, and the perio chart that rides along | `POST /:aptNum/send` | `sendVisit()`, first line |
| Perio send from the chart page | `POST /:aptNum/perio/send` | `startPerioSend()` |
| Every later step | `POST /:aptNum/perio/send/step` | `stepPerioSend()` |
| Undo: delete the exam this send created | `POST /:aptNum/perio/send/delete-exam` | `deletePerioExamForSend()` |
| Open a sent chart for correction | `POST /:aptNum/perio/amend` | `beginAmendment()` |
| Retry the swap's delete | `POST /:aptNum/perio/send/remove-replaced` | `removeReplacedExam()` |
| Retry a failed write | `POST /:aptNum/staged-writes/:kind/retry` | the route, after `loadForMutation` |

Retry writes nothing to Open Dental itself, but it re-queues a write that would. Gating it means a non-test patient's failed write can't be retried into a live send. `amend/cancel` is **not** gated: it touches only our database and puts the chart back, and gating it could leave a chart stuck mid-correction when someone turns the gate on.

The gate keys on **(office, PatNum)**. The office is `req.hygOffice`, which the server derives. The PatNum comes from the stored visit, which every write route has already checked against Open Dental's own appointment (`PATIENT_CHANGED`). Roland 7115 is refused even though valley 7115 is a test patient. That case has its own test.

The refusal:

```
422 { success: false, code: "HYG_TEST_PATIENTS_ONLY",
      error: "This environment only writes to the designated test patients (roland 12827, 12828; valley 7115),
              and this patient is not one of them. Nothing was sent to Open Dental." }
```

It never repeats back the PatNum it refused. On the visit send, **every unit stays `Staged`, not `Failed`**. Nothing was attempted, and a Failed row would claim otherwise. No perio send is recorded. Nothing reaches TC. An `UNAUTHORIZED` row goes to the audit trail, the same as the other denials.

**On screen:** neither page needed a code change. The visit page already treats a 422 on Send as a refusal of the whole send and prints the server's sentence in `hyg-send-refused`, beside Send. The chart page prints it in `hyg-perio-send-error` beside its Send, or inside the send panel when a send is already showing. Two new page tests pin both.

## 5. One list, shared (acceptance 6)

`backend/config/testPatients.js` is now the only declaration:

```js
DESIGNATED_TEST_PATIENTS = { roland: [12827, 12828], valley: [7115] }   // frozen
isDesignatedTestPatient(office, patNum)
```

It requires nothing, so the probe scripts can load it before they decide whether to load secrets. Readers:

| File | Before | Now |
|---|---|---|
| `config/hygFixtureGate.js` | — | `require('./testPatients')` |
| `scripts/diag-hyg-groupnotes.js` | its own copy of the list | the shared list |
| `scripts/probe-hyg-groupnote.js` | its own copy | the shared list |
| `scripts/probe-hyg-perio-arch.js` | its own copy (frozen) | the shared list |
| `scripts/probe-hyg-perio-v2.js` | `{ roland: [12828] }` | the shared list, **narrowed** to roland 12828; can never widen it. Loaded through `HYG_PROBE_APP_ROOT`, so a copy in `/tmp` still resolves it |

**Proof:** `backend/test/testPatients.test.js` walks every backend `.js` file, excluding tests and `node_modules`, for a literal pairing an office key with a fixture PatNum array. It finds exactly one: `config/testPatients.js`. It also checks that the four hyg probes read `config/testPatients`. 11373 does not appear in the list file's code.

Not changed: the RCM scripts (`rcm-s10-*`) name 12827 as a single target rather than as a list, and they belong to another module.

## 6. Tests

`backend/routes/hyg/hygFixtureGate.test.js` has 12 tests, all through the real `/api/hyg` stack. Each continuation test builds real state with the gate **off**, turns it **on** and is refused with zero new writes, then turns it **off** again and succeeds with the same call. So each refusal is shown to come from the gate, not from some other precondition.

| # | Test |
|---|---|
| 1 | Visit send (perio + note + slip + TC handoff) for a non-test patient: 422, `od.client.writes` empty, TC not called, all four units `Staged`, no perio send row, one denial audit row. Gate off: the same confirmation sends |
| 2 | TC handoff alone: refused, nothing reaches TC |
| 2 | Perio start: refused; gate off then sends to Written |
| 2 | Perio step on a send paused mid-flight: refused, no writes, send left in `posting`; gate off then finishes it |
| 2 | Delete-exam on an incomplete send: refused, no DELETE, exam still there; gate off then deletes it |
| 2 | Amend (chart stays Written) and remove-replaced (both exams untouched): each refused, then each goes through with the gate off |
| 2 | Retry of a Failed perio write: refused, stays Failed, denial audited; gate off puts it back on the list |
| 3 | Test patient 12827 with the gate ON: note, TC case and chart all Written |
| 3 | Roland 7115 with the gate ON: refused (the office is part of the key) |
| 4 | Unset with a prod vault: a non-test patient sends exactly as today |
| 5 | `yes`, `true`, `false`, `0`, empty, `of`, `disabled`: each refuses |
| — | Unset with `kv-carein-staging`: refused by default |

**Proving the tests can fail:** I temporarily made the gate always return `null` and ran the suite: **10 failed, 2 passed**. The 2 were the test-patient case and the gate-off case, which should pass either way. Then I restored the gate.

`backend/test/testPatients.test.js` has 10 tests: the list's shape and freezing, (office, PatNum) membership, the one-place scan, the v2 probe's narrowing, every row of the switch table, the once-per-value warning, and that the gate re-reads the switch on every call.

Dashboard: one test in `tests/hyg-send.test.tsx` (visit page) and one in `tests/hyg-perio-page.test.tsx` (chart page). Each checks that the 422 sentence shows beside Send and that no row is marked failed.

### Gates

| Gate | Result |
|---|---|
| `node --check server.js` | clean |
| `node scripts/shard-runner.mjs` | 4/4 green: 2548 tests, 2545 pass, 0 fail, 3 skipped |
| `pnpm run check` | clean |
| `pnpm run test` | 1805 passed, 124 skipped |

No `any`. No `.env` read. No Azure change. The only Azure contact was the two read-only `az containerapp show` queries in §2, filtered to three variable names.

## 7. For Beau: the same rail elsewhere is a platform decision

This slice covers the **hygiene module only**, as the brief asked. Two other modules write to the same live Open Dental databases from staging with no rail like this:

- **Voice commlogs.** `POST /api/unified-calls/:id/resolve-patient` and the worklist send write a commlog to whichever patient the call was matched to. `COMMLOG_AUTO_WRITE` is off, so a human has to press Send, but nothing stops that human from sending to a real patient on staging.
- **RCM posting.** The drain posts payments and adjustments. Staging walks have used 12827, but only by discipline.

`config/testPatients.js` and `refuseUnlessTestPatient` are written so either module could adopt them with one call per entry point. I built nothing there. Whether staging should refuse non-test patients across the whole platform is your call.

## 8. Not done / follow-ups

- The gate refuses rather than hides. A non-test patient's visit on staging still opens, composes and stages; only the send is refused. That seemed the honest split: staging stays useful for looking at real schedules, and nothing can be written.
- The incident's patient is not named, numbered or described anywhere in this work.
