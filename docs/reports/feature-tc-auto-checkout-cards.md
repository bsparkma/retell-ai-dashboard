# CO-5b — Checkout cards from today's schedule

Branch `feature/tc-auto-checkout-cards` → `develop`. Not merged.

## What it does

When an office's new switch `tc_auto_checkout_enabled` is on, every completed visit that is not a hygiene visit gets a Waiting card on the Checkout page by itself. Beau's rulings (2026-10-30) were: non-hygiene appointments only, cards start in Waiting, and the switch defaults OFF with Roland piloting.

An appointment in the office's Open Dental today gets a card when **all** of these hold:

| | Rule | Source |
| --- | --- | --- |
| a | `AptStatus` is `Complete` | — |
| b | The **appointment's own** `IsHygiene` is `false`. `true`, null, missing or unparseable counts as hygiene and is **skipped**: the hygiene app owns that lane. The chair's flag is never consulted. | hyg's rule, `odDay.odBool(r.IsHygiene) !== false` |
| c | A real patient: `PatNum > 0`. Blockouts and unattached rows carry none. | hyg's `PatNum > 0` rule |
| d | No card was ever made from this AptNum, in **any** status: a dismissed card is not re-made. The patient also holds no card today (any source, any status except dismissed or expired), which is CO-5a's rule. | `findOriginAptNums`, `findHoldingForPatientDay` |

**The card:**
- source `schedule`, status `open` (Waiting)
- `submitted_by` is `system:auto_checkout`
- the patient name is re-read from that office's Open Dental through the shared patient cache
- the empty snapshot, so the workup says "No hygiene visit data: this card was made from today's schedule…"; referrals and the outcome buttons work as on a manual card
- the appointment is kept in `origin_apt_num` and `origin_appt` (AptNum, time, visit type, provider, operatory — labels only, never the note)
- the card shows "From today's schedule · Crown Prep · seen by DOC1"

**Audit:** one CREATE audit row per card, as the system, with `source_ref` `apt_num:<AptNum>`. It is written before COMMIT, so a failed audit write rolls the card back and stops the sweep.

**Merge:** a later hygiene handoff for the same patient and day **merges onto** the schedule card by the existing CO-5a rule. `MERGEABLE_SOURCES` is now `manual` + `schedule`. The card keeps its id, its source and its AptNum.

### When it runs (no nightly)

- The Checkout page asks `GET /api/tc/checkout/schedule-check` on mount, on focus, on becoming visible, and every 60 s while visible. This is the day-progress pattern; a hidden page asks nothing.
- The server sweeps only when the office's last sweep is older than **60 s**, and never runs two at once per office. However many pages are open, that is **one `/appointments` read per office per window** (pinned by test).
- After an answer saying a read is running, the page asks again in 5 s, so new cards appear without waiting a minute.
- The Pipeline's **Sync now** (CO-4b) also forces a schedule read for its office when that switch is on (`scheduleCheck: 'started'`). Sync now stays gated on the CO-4b switch: when OD sync is off, Sync now answers 409 and no schedule read happens.

**Bounded cost:**
- one paged `/appointments` read
- at most `TC_AUTO_CHECKOUT_MAX_PER_SWEEP` (default **100**) cards, and so patient reads, per sweep
- type, provider and operatory labels come from the existing hour-long config cache
- every request is paced at ≥ 1200 ms with a 15 s timeout

**Rotation:**
- Appointments beyond the cap come on the next sweep, since carded ones drop out first.
- An appointment whose patient could not be named goes to the back and gets **no** card, never an "Unknown" card.
- One appointment that cannot be carded for any other reason also goes to the back, and the read is marked partial.

### Honest state

- **Failed read:** the page shows an amber line, "Couldn't check today's schedule. Last successful check: 10:02 AM. Patients finished in Open Dental since then may be missing — add them by hand if they are at the desk." The same line appears when the ask itself fails. It is never a quiet, stale list.
- **No read finished since the server started:** "Checking today's schedule…", not "checked".
- **Partial read:** "Only part of the schedule could be read."
- **Switch off:** nothing is shown, nothing is read, nothing is written. The engine re-checks both switches before naming patients and before every card, so the env break-glass stops a sweep that is already running.

The state lives in the server process: last attempt, last **success**, counts, and a monotonic `createdTotal`. A restart starts at "pending" (prod and staging run `maxReplicas=1`).

## Switch

`config/tcAutoCheckout.js` uses the established `createOfficeSwitch`:
- `TC_AUTO_CHECKOUT_ENABLED_<OFFICE>=false` overrides everything
- then the `platform_setting` row
- then `=true` as a fallback
- otherwise OFF

Checkout itself (`tc_checkout_enabled`) must also be on. **No platform_setting row is seeded**, so every office is OFF until someone switches it on. To pilot Roland, a super_admin turns it on in **Platform → TC Checkout → "TC checkout cards from today's schedule" → Roland**. That writes and audits the `tc_auto_checkout_enabled` row with the prior state. The API is `GET/PUT /api/platform/tc-auto-checkout-offices`.

## Storage

Tenant migration **`1794000000000_tc_auto_checkout_cards`**. It sits above develop's newest (CO-4b's `1793900000000`), re-checked at push. It is additive:
- the source CHECK is widened to `hygiene | manual | schedule`
- `origin_apt_num bigint` and `origin_appt jsonb` are added, both nullable
- an origin CHECK: a schedule card carries its appointment, and nothing else carries one
- `UNIQUE (office_id, origin_apt_num) WHERE origin_apt_num IS NOT NULL`, over every status

`down` drops all of it and restores the narrow source CHECK as `NOT VALID`, so rows survive. Down and re-up were run against Postgres 16.

## CI

Added the one pre-approved step to `.github/workflows/build-test.yml`: `node scripts/od-sync-verify-queries.js` (CO-4b), with the same shape as the checkout-anchor step. Nothing else in `.github` changed.

The new **`scripts/auto-checkout-verify-queries.js`** is **not** in CI, because adding it would have been a second `.github` change. It runs the real sweep and the real merge against a migrated schema, and proves the CHECKs and the unique index refuse what they must. It passes **9/9** locally on Postgres 16, alongside od-sync 9/9 and checkout-anchor 10/10. The step to add is the same shape:

```yaml
      - name: auto checkout verification (real statements, real rows, real schema)
        working-directory: backend
        env:
          MIGRATE_TENANT_DB_URL: postgres://carein_owner:carein_owner_devpw@localhost:5432/carein_t_carein
        run: node scripts/auto-checkout-verify-queries.js
```

## Tests

| File | Count | Covers |
| --- | --- | --- |
| `backend/routes/tc/tcAutoCheckout.test.js` | 31 | hygiene and unknown skipped (true, null, missing, `'true'`, junk); only Complete, today, PatNum > 0; dedupe against hygiene, manual, an earlier schedule card, a **dismissed** schedule card, and two appointments for one patient; two racing sweeps (unique index emulated); both in-transaction re-checks (race tests); **merge** of a later hygiene handoff; switch off = zero reads, rows and audits with completed appointments present; env `=false` over a stored true; checkout off; the 60 s window pins the `/appointments` call count; concurrent asks share one read; pacing and timeouts; Sync now forces a read, or none when off; cap and rotation; unnamed patient; failed read keeps the last success; unconnected office fails closed; audit before COMMIT; **office isolation** (same AptNum in both offices, valley off while roland runs); mid-sweep switch-off; one bad card doesn't hold the queue; a database refusing every card reads as failed; `createdTotal` counts a card the moment it commits |
| `backend/routes/tcAutoCheckoutSwitch.test.js` | 3 | console ON/OFF obeyed on the next request, audited with prior state; break-glass; super_admin only, bad input refused |
| `backend/test/autoCheckoutMigration.test.js` | 7 | additive and nullable; CHECKs; the any-status unique index; down; numbering; schema replay |
| `new-dashboard/tests/tc-auto-checkout.test.tsx` | 15 + 3 shots | the line (ok / failed with last success / never succeeded / ask failed / off / pending / partial); polling (mount, 60 s, hidden asks nothing, visibility, focus, 5 s follow-up, reload on `createdTotal`, no dropped ask); card badge and visit type; origin text; workup wording |

- **No existing test was edited.**
- **Mutation checks:** 23 deliberate code breakages each turn a test red. The first pass found the two in-transaction re-checks unpinned; race tests were added for them.
- **Full suites on the final code (a36c440):**
  - backend: 4,549 passed, 0 failed, 3 skipped
  - dashboard: 3,092 passed and 1 failed, and the failure is the known `rcm-ui-s3` "k goes the other way" flake. That test file is untouched by this branch and passes 51/51 when run alone.
  - Typecheck is clean, and an unrelated `voicelab-page` timeout on an earlier run also passed alone.

## Review

A fresh-context reviewer ran two rounds. Round 1 found no blocker; its should-fix items were all fixed with tests:
1. The switch was checked only at sweep start, so the break-glass did not stop a running sweep.
2. One appointment that could not be carded failed the whole sweep, every time.
3. A reload could be missed when two reads finished between asks, and the 5 s follow-up could be dropped.

It also flagged a misleading comment and the route's `enabled` flag. The "flake" it reported came from my mutation script rewriting the source files while it ran tests; serial reruns are stable (5 runs, 39/39).

Round 2 confirmed those fixes and raised one honest-state issue, now fixed with tests: the per-card catch was too broad, so a database refusing **every** card would have shown a green "checked". Now only a per-row refusal (pg class 23) defers a single card; anything else fails the read. Two nits were also fixed:
- `createdTotal` is counted as each card commits.
- The page reloads on any change of `createdTotal`, so a server restart resets it cleanly.

Left as is, with the reviewer agreeing:
- The status is kept per office, not per tenant: one tenant owns each frozen office key.
- A partial Open Dental read still advances the last-success time, and says "partial" on the page.
- The "partial" wording also covers a card that couldn't be made.

## Interpretations to confirm

- **A dismissed schedule card is never re-made** from the same AptNum. The spec's dedupe says "non-dismissed card", but re-making a card the desk just dismissed 60 s later would undo their decision. A dismissed card of another source (hygiene or manual) does **not** block a schedule card, per the spec's wording.
- **Sync now** piggybacks only when it is accepted. With the CO-4b switch off it answers 409 as before, and the Checkout page's own polling still keeps the schedule fresh.
- **The card's time** is when the card was made, not the appointment time. The visit type is shown beside it.

## Screenshots (synthetic data)

`docs/screenshots/tc/co5b/`, 1280×900, light and dark:
- `tccheckout-co5b-01-list` — schedule cards beside a hygiene card, with "Today's schedule checked at …"
- `tccheckout-co5b-02-read-failed` — "Couldn't check today's schedule" with the last success
- `tccheckout-co5b-03-workup` — a schedule card's workup: badge, origin line, honest empty hygiene section
