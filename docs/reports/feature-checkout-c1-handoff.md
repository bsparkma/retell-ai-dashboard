# Report: queue item 49, Checkout C1 (`feature/checkout-c1-handoff`)

**LANE: RED. NEEDS REVIEW. Beau merges.** The slice adds two tenant migrations and a new value in a shared vocabulary (intake kind `checkout`), plus a new platform-settings key (`tc_checkout_enabled`). The queue file also marks it RED.

**Migration timestamps:** `1791300000000_tc_checkout_handoff.js` and `1791400000000_hyg_checkout_send.js`.
- origin/develop's newest at push was `1791100000000_tc_nurture.js`.
- `1791200000000` is left free on purpose. Open PR #238 carries `1791000000000`, which is below nurture, so it has to renumber above nurture before it can merge. The gap is there so it does not collide with these.
- Re-check before merge. If anything lands at or above `1791300000000`, renumber these two.

**Ships dark.** Nothing changes for any office until `platform_setting['tc_checkout_enabled']` names it `true`.

## What shipped

### TC side
**`POST /api/tc/hygiene-intakes` now takes a `kind`** (`hygiene | ortho | checkout`, from `shared/tc/checkout.ts`).
- `hygiene` and `ortho` create a case exactly as before.
- `checkout` stores a row in a **new table, `tc_checkout_handoffs`**, and opens **no case**. Item 50's "Nothing needed" outcome depends on that.

**Every intake kind may carry a `sourceKey`.** This closes the gap item 33 recorded ("TC has no idempotency key"):
- A repeat key returns the case or handoff it already made.
- `UNIQUE (office_id, source_key)` is the arbiter. On the case path, the key is written inside the case transaction, so a 23505 rolls the whole loser back and the winner is replayed.
- With no key, behavior is unchanged. TC's own intake form now sends one key per submission.

**Checkout handoff rules:**
- A repeat key updates the snapshot (`revision`+1).
- A **final** snapshot is never replaced by a non-final one. A late early-alert cannot roll back the hygienist's last word.
- A key that comes back with a different PatNum → 409 `SOURCE_KEY_CONFLICT`.
- Office off → 403 `CHECKOUT_DISABLED`, and nothing is stored.
- Audit: CREATE on insert, UPDATE on each applied revision. A replay writes no row.

### Hygiene side
- **"Alert checkout"** button on the visit (above the Note & treatment | Ortho screening tabs). It is drawn only when the office's switch is on.
  - It POSTs the stored staged-treatment snapshot now: procedures, highest priority, next-visit needs (slip `nextVisit` + RTC line), and `notesPending` (true until the note staged write is `Written`). The front-desk and financial notes ride along.
  - The idempotency is the ortho send's exact mechanic:
    - conditional claim (`claimCheckoutSend`)
    - `alreadySent` short-circuit
    - two-minute stale-claim takeover
    - a TC refusal releases the claim and answers 502
  - Nothing in the request body is read. Office/PatNum come from the stored visit; name, chair and provider from the appointment snapshot.
- **The visit Send fires the handoff** after all chart writes, with `final: true`.
  - It creates the handoff if absent, or updates the same one by source key.
  - It **cannot fail the Send.** It reports `checkout: { state: 'delivered' | 'not_delivered', … }` beside the outcomes, and `null` when the office is off.
  - `POST …/checkout/finalize` retries only the handoff, touching no chart. The UI shows an amber "The front desk did not get your final notes" banner with a retry.
- **Source keys** `hyg-visit:<visitId>:handoff|ortho|checkout` now ride the existing treatment handoff and the ortho send too. They name a CareIN row, never a patient.

### Switch (`config/tcOfficeSwitch.js` + `config/tcCheckout.js`)
Per-office version of `tcEmail.js`'s precedence:

| Order | Source | Effect |
| --- | --- | --- |
| 1 | `TC_CHECKOUT_ENABLED_<OFFICE>=false` | Break-glass: always OFF |
| 2 | `platform_setting['tc_checkout_enabled'][office]` | The stored choice |
| 3 | `TC_CHECKOUT_ENABLED_<OFFICE>=true` | Fallback, only if the row does not name the office |
| 4 | — | OFF (the floor) |

- Read at runtime. The cache refreshes lazily (5 min, `TC_SWITCH_REFRESH_MINUTES`), so there is no `server.js` hook.
- A failed read keeps the previous cache. Never read means OFF.
- Both env vars are added to `docs/SECRETS.md`. R1 reuses the factory for `tc_referrals_enabled`.
- **There is no console toggle yet.** Item 50 adds one. Until then, enabling staging is one row: `INSERT INTO platform_setting (key, value) VALUES ('tc_checkout_enabled', '{"roland": true}')`. That is Beau's call, and this report does not run it.

## Files

| File | Change |
| --- | --- |
| `backend/migrations-tenant/1791300000000_tc_checkout_handoff.js` | **new**: `tc_checkout_handoffs` (office CHECK inline, key shape CHECK, UNIQUE (office_id, source_key), carein_app grant block); `tc_hygiene_intakes.source_key` nullable + partial unique index |
| `backend/migrations-tenant/1791400000000_hyg_checkout_send.js` | **new**: five nullable `checkout_*` columns on `hyg_visit` + all-or-nothing CHECKs (ride hyg_visit's existing grant) |
| `backend/config/tcOfficeSwitch.js`, `backend/config/tcCheckout.js` | **new**: the switch |
| `backend/routes/tc/checkoutStore.js` | **new**: explicit-column reads/writes, office in every WHERE |
| `backend/routes/tc/hygiene.js` | kind dispatch, source-key replay + 23505 arbitration, checkout submit |
| `backend/services/hyg/tcHandoffClient.js` | `sourceKeyFor`, `buildCheckoutIntake`, `submitCheckoutHandoff`; shared `postIntake` transport; kind + sourceKey on the two existing bodies |
| `backend/services/hyg/visitStore.js` | checkout columns, `checkoutSend` on the read model, claim/mark/release |
| `backend/routes/hyg/visit.js` | `checkoutEnabled` on GET; `deliverCheckout`; `POST …/checkout/alert`, `…/checkout/finalize`; the Send's final update |
| `new-dashboard/shared/tc/checkout.ts` | **new**: `TcIntakeKind`, `TcIntakeSourceKey`, snapshot/submit/handoff schemas |
| `new-dashboard/shared/hyg/contract.ts` | `CheckoutSendSchema`, `checkoutSend` on the visit, `CheckoutDeliverySchema` on the Send response, alert request/response, 3 error codes |
| `backend/tc/contract.entry.ts`, `backend/{tc,hyg}/contract.gen.cjs` | export + regenerated with the pinned esbuild and `--alias:zod` |
| `new-dashboard/client/src/features/hyg/visit/CheckoutAlert.tsx` | **new**: the button and its states |
| `new-dashboard/client/src/pages/hyg/HygVisit.tsx`, `features/hyg/api.ts` | wiring; `alertCheckout`, `finalizeCheckout`; `checkoutEnabled` (defaults false) |
| `new-dashboard/client/src/features/tc/api.ts`, `features/tc/hygiene/IntakeForm.tsx` | `kind`/`sourceKey`; one key per submission |
| `backend/routes/hyg/hygTestUtils.js`, `backend/routes/tc/tcTestUtils.js` | harness only: `checkoutSubmit` seam; the fake learns the three checkout statements + CHECKs; `payload` is a jsonb column. **No existing test assertion edited.** |
| tests | `routes/hyg/hygCheckoutAlert.test.js` (12), `routes/tc/tcCheckoutIntake.test.js` (13), `test/checkoutHandoffMigration.test.js` (7), `tests/hyg-checkout-alert.test.tsx` (7), `tests/hyg-checkout-shots.test.tsx` (3 dumps, `HYG_SHOTS=1`) |
| `docs/screenshots/hyg/hyg-checkout-0{1,2,3}-*-{light,dark}.png` | 6 shots, iPad 1180 width |
| `docs/SECRETS.md` | the two env vars |

## Acceptance

| # | Row | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Double-click = one handoff | **PASS** | `hygCheckoutAlert.test.js` "a double-click is ONE handoff": two racing POSTs → `[200, 409 CHECKOUT_SEND_IN_PROGRESS]`, TC asked **once**; a third press → `alreadySent: true`, still one call |
| 2 | Early alert then visit Send = one handoff, payload updated | **PASS** | "early alert then the visit Send": same `sourceKey` on both bodies, second `final: true` carrying the post-alert front-desk note and `notesPending: false`. "the captured bodies, replayed into the REAL TC intake": one `tc_checkout_handoffs` row, `revision 2`, `is_final true`, **0 `tc_cases`**; a late replay of the early body → `replayed: true`, revision still 2 |
| 3 | Lost response + resend → no duplicate case, all kinds | **PASS** | `tcCheckoutIntake.test.js`: treatment kind and ortho kind each → second POST 200 `replayed`, same caseId, 1 case, 1 CREATE audit; the 23505 race → winner replayed; same key in another office → separate; no key → unchanged behavior |
| 4 | 502 releases the claim; nothing claimed early; retry works; stale claim taken over | **PASS** | "TC down → 502…", "a stale claim…" |
| 5 | Client body carries no office/PatNum/name/provider | **PASS** | double-click test posts a forged `{office:'valley', patNum:7115, patientName, provider}`; TC received `roland`, 12827, the snapshot's name, `DOC1`. UI test: `alertCheckout` called with exactly `["roland", 900001]` |
| 6 | Zero OD calls in the checkout path | **PASS** | double-click test: `client.calls.slice(before)` and `client.writes` both `[]` across the alert path. The visit Send's own OD reads are unchanged; its handoff step reads only the stored visit + snapshot |
| 7 | Ortho send unchanged, its tests green unedited | **PASS** | `hygOrthoSend.test.js` unmodified and green in the full run (below), including the test that posts its captured body to the real TC route |
| 8 | Migrations additive, above develop's newest; visitSchema v3 green | **PASS** | `checkoutHandoffMigration.test.js` (7); `visitSchema.test.js` + `orthoScreeningMigration.test.js` green unedited |
| — | Dark by default; break-glass only disables | **PASS** | four "OFF…" / floor / env tests, hyg and TC side |
| — | Send never fails because of the handoff | **PASS** | "TC down → Written + not_delivered; /finalize retries" |

## Vocabulary sweep (whole repo, `git grep`)

| Value | Readers | Updated? |
| --- | --- | --- |
| intake kind `hygiene/ortho/checkout` (`TcIntakeKind`) | `routes/tc/hygiene.js` (route), `features/tc/api.ts` `TcIntakeSubmit.kind`, `IntakeForm.tsx`, `tcHandoffClient.js` builders | yes, all. No CHECK stores kind (it is a request discriminator; `checkout` lands in its own table) |
| `sourceKey` / `source_key` | migration CHECK + index, `TcIntakeSourceKey` (the same `^[A-Za-z0-9:_-]{8,200}$`, pinned both ends by the migration test), route, builders, form | yes |
| `tc_checkout_enabled` / `TC_CHECKOUT_ENABLED_*` | `config/tcCheckout.js`; `docs/SECRETS.md` | yes. No other module enumerates platform-setting keys (grep for `tc_nurture_enabled` / `tc_email_enabled` readers: only their own config, routes and docs) |
| hyg error codes `CHECKOUT_DISABLED`, `CHECKOUT_SEND_IN_PROGRESS`, `SOURCE_KEY_CONFLICT` | `HYG_VISIT_ERROR_CODES` | added. No client switch keys on these (grep for `ORTHO_SEND_IN_PROGRESS` in client/tests: none). The UI renders `err.message` |
| `CheckoutDelivery.state` `delivered/not_delivered` | `CheckoutAlert.tsx` only | yes |
| audit `resource_type` `hyg_checkout_alert`, `tc_checkout_handoff` | free text (no CHECK on `audit_log.resource_type`; `action` uses the existing CREATE/UPDATE) | n/a |
| `tc_hygiene_intakes` new column | `caseStore.INTAKE_COLS` names columns explicitly and does not select it; `rows.ts`, `legacy.ts`, `server/tc-import/pgTarget.ts` insert without it (nullable) | none needed |

**normalizeCall / call store:** not touched. This slice adds no call-store field.

## Gates (merge tree: `origin/develop` @ 1c0163f merged, "Already up to date")

```
backend $ npm ci                      -> exit 0
backend $ node --check server.js      -> OK
backend $ node --test                 -> exit 1
  # tests 3551  # pass 3547  # fail 1  # cancelled 0  # skipped 3
  not ok 53 - routes\platform.test.js
    failureType: 'uncaughtException'
    error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
  -> KNOWN Node 22 runner flake (file-level, no assertion; CLAUDE.md / queue README).
     Re-run in isolation: node --test routes/platform.test.js -> # pass 20  # fail 0
     platform.test.js is not touched by this slice. Not "fixed" by editing anything.

new-dashboard $ pnpm install --frozen-lockfile  -> exit 0
new-dashboard $ pnpm run check (tsc --noEmit)   -> exit 0, no errors
new-dashboard $ pnpm run test (vitest run)      -> exit 0
  Test Files 150 passed | 32 skipped (182)
  Tests 2510 passed | 188 skipped (2698)
  (incl. tc-contract-bundle and hyg-contract-bundle: both regenerated bundles byte-match)
```

New tests alone: `hygCheckoutAlert.test.js` 12/12, `tcCheckoutIntake.test.js` 13/13,
`checkoutHandoffMigration.test.js` 7/7, `hyg-checkout-alert.test.tsx` 7/7.
Screenshots: `pnpm exec vite build` → `HYG_SHOTS=1 pnpm exec vitest run tests/hyg-checkout-shots.test.tsx`
→ `node scripts/shoot-hyg.mjs` (only the six new PNGs written).

## Lane

LANE_PLACEHOLDER

## Staging test steps (after Beau merges and staging deploys)

1. Turn it on for roland only:
   `INSERT INTO platform_setting (key, value, updated_by) VALUES ('tc_checkout_enabled', '{"roland": true}', '<you>') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`
   Wait up to 5 min for the cache, or restart.
2. Hygiene → Day → roland → a **test patient** visit (12827 or 12828). "Alert checkout" appears above the tabs. Valley does not show it.
3. Add a treatment item, then press **Alert checkout** twice quickly. You see "Checkout alerted at h:mm · your final notes go with Send".
   In `tc_checkout_handoffs` there is exactly one row for that office: `revision 1`, `is_final false`, `payload.notesPending true`. There are no new `tc_cases`.
4. Stage the note, then **Send**. The tray shows the note Written. The checkout line now reads "final notes sent at h:mm".
   The same row is now `revision 2`, `is_final true`, `notesPending false`.
5. Optional: with TC unreachable, Send shows the amber "did not get your final notes" banner, and the note is still Written. "Send to the front desk again" fixes it.
6. Ortho screening "Send to TC" on another test visit still makes exactly one `hygiene_review` case. Its `tc_hygiene_intakes.source_key` is `hyg-visit:<id>:ortho`.

## Not in this slice / follow-ups

- Checkout page, sidebar, outcomes and the console toggle → item 50 (C2).
- The checkout table has no status/outcome columns yet. C2 adds them, deliberately: that vocabulary belongs to the slice that uses it.
- `idempotency` on the voice handoff is untouched (it already has `source_call_id`).
