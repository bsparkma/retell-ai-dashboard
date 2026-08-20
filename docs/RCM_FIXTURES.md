# RCM fixtures — Slice 2

**Decision D-2 is locked: the RCM module starts EMPTY in prod.** No historical data migrates
from the standalone `rcm-posting` app, and that app's database is never read — not by this
seeder, not by anything else in this repo.

What Slice 2 ships instead is the fixture layer that lets Slices 4–7 be built and
staging-tested against realistic data. Two independent pieces:

| Piece | Path | What it is |
| --- | --- | --- |
| Row seeder | [`backend/scripts/rcm-seed-fixtures.cjs`](../backend/scripts/rcm-seed-fixtures.cjs) | An authored, idempotent graph of 65 synthetic rows across both offices |
| ERA corpus | [`backend/test/fixtures/rcm/`](../backend/test/fixtures/rcm/) | 13 synthetic 835 files for Slice 5's `eraParser` tests |

They are deliberately independent: the seeder does not parse the `.edi` files, so a parser
change cannot alter what the seeder writes. See the corpus's own
[README](../backend/test/fixtures/rcm/README.md) for its provenance.

---

## The prod guard

The seeder is structurally incapable of running against prod, and it **fails closed** —
every one of these must pass before a single row is written:

| # | Check | Refusal code |
| --- | --- | --- |
| 1 | `RCM_SEED_ALLOW` is exactly `dev` or `staging`. **Unset is a refusal**, so the script never runs by accident, and no value targets prod | `GUARD_NO_OPT_IN` |
| 2 | `NODE_ENV` is not `production` | `GUARD_NODE_ENV_PRODUCTION` |
| 3 | `RCM_SEED_DB_URL` is set and parseable | `GUARD_NO_DB_URL` / `GUARD_UNPARSEABLE_DB_URL` |
| 4 | No prod marker (`-prod`/`_prod`/`.prod`) in the host **or** the database name — unconditional, under either opt-in | `GUARD_PROD_DATABASE_URL` |
| 5 | `RCM_SEED_ALLOW=dev` reaches only `localhost` / `127.0.0.1` / `::1` / `host.docker.internal` — a dev opt-in cannot reach a cloud database at all | `GUARD_DEV_REQUIRES_LOCAL` |
| 6 | `RCM_SEED_ALLOW=staging` requires `staging` in the host (`psql-carein-staging`, never `psql-carein-prod`) | `GUARD_STAGING_URL_MISMATCH` |
| 7 | **The target database holds no RCM rows this seeder did not write** | `GUARD_NON_FIXTURE_DATA` |

Check 7 is the one that does not depend on anyone setting an env var correctly. Prod starts
empty and then accumulates real work, so the first real claim, batch, deposit or queue row in
any database makes that database permanently un-seedable. It is checked inside the
transaction, before any insert.

`--dry-run` is the default and needs none of this: it touches no database, reads no
environment, and prints the plan it *would* apply.

---

## Running it

```bash
cd backend

# Dry-run — the default. Prints the full plan; writes nothing, anywhere.
node scripts/rcm-seed-fixtures.cjs

# Local throwaway Postgres (what the Slice 2 rehearsal used)
RCM_SEED_ALLOW=dev \
RCM_SEED_DB_URL="postgresql://postgres:postgres@localhost:55432/rcm_rehearsal" \
  node scripts/rcm-seed-fixtures.cjs --execute

# Staging. Fetch the tenant connection string from Key Vault into the session —
# never into a file, never into a commit.
RCM_SEED_ALLOW=staging \
RCM_SEED_DB_URL=$(az keyvault secret show --vault-name kv-carein-staging \
  --name tenant-carein-db-url --query value -o tsv) \
  node scripts/rcm-seed-fixtures.cjs --execute
```

Options: `--dry-run` (default), `--execute`, `--user-map <path>`.

The whole graph is one transaction. Any failure rolls every row back, so the database is
never left holding half a fixture.

### What a re-run does

Nothing. Every primary key is a uuid v5 derived from a stable fixture key, so a second
`--execute` collides with its own previous row and skips it:

```
  TOTAL                         0 created     65 already present
  (idempotent re-run — nothing to do)
```

---

## What gets seeded

65 rows across 15 tables. `rcm_user_map` is tenant-global (billing staff work across both
offices); every other table carries `office_id` and is present for **both** offices, so
office isolation is exercisable from day one.

| Table | roland | valley | global | What it is |
| --- | ---: | ---: | ---: | --- |
| `rcm_user_map` | — | — | 3 | Fixture actor identities |
| `rcm_office_settings` | 1 | 1 | — | Merchant discount rate |
| `rcm_payer_rules` | 1 | 1 | — | One carrier, two practices |
| `rcm_bank_transactions` | 1 | 1 | — | The deposit — roland `eft`, valley `check` |
| `rcm_claims` | 3 | 2 | — | |
| `rcm_procedure_lines` | 5 | 3 | — | Includes a denied line and a downcoded line |
| `rcm_procedure_adjustments` | 10 | 4 | — | CARC groups + two RARC remarks |
| `rcm_payment_batches` | 1 | 1 | — | Status `ready`, never `posted` |
| `rcm_batch_claim_payments` | 3 | 2 | — | |
| `rcm_eob_uploads` | 1 | 1 | — | Status `extracted`, opaque blob key |
| `rcm_remittance_keys` | 1 | 1 | — | Status `pending` (reserved, not posted) |
| `rcm_handoff_tasks` | 1 | 1 | — | `DENIAL` / `RECOUPMENT`, both `OPEN` |
| `rcm_activity_events` | 3 | 3 | — | received → extracted → matched |
| `rcm_posting_queue` | 1 | 1 | — | Status `approved`, **never** `posted` |
| `rcm_posting_queue_line` | 5 | 3 | — | Includes the negative supplemental |

### The money balances, and the seeder proves it

For each office, `batch total = Σ claim payments = Σ intended line amounts`. No cent total is
typed twice anywhere in the fixture — the batch and queue totals are derived from the line
adjudications, and `buildFixturePlan()` **throws** rather than emit an unbalanced graph. Every
procedure line also satisfies `billed = paid + write_off + patient_resp`.

> **Slice 6b changed this to TWO equations.** With an approval gate, the fixture can — and
> must — contain a claim nobody approved, so "the check" and "the plan" are different totals:
>
> - the **CHECK** still accounts for every cent the carrier moved, withheld claims included;
> - the **PLAN** equals what was APPROVED, and no more.
>
> Which is the same distinction the gate itself draws between "this remittance balances" and
> "this claim is postable". `buildFixturePlan()` throws on either equation failing.

```
roland  batch_total=79200   claim_payments=79200   intended_lines=19200   (2 of 3 claims approved)
valley  batch_total=6500    claim_payments=6500    intended_lines=10500   (the takeback is withheld)
```

Roland's plan is SMALLER than its check (a postable claim nobody has approved yet); valley's is
LARGER (the check is netted down by a takeback the plan refuses to carry). The two directions
are deliberate — a fixture where they always pointed the same way would let a sign error hide.

### Three cases worth knowing about

**The recoupment (valley) — now WITHHELD, not queued.** Slice 2 seeded it as a queued negative
supplemental so later slices had a one-way-door case to render. Slice 6b's approval gate refuses
a recoupment outright (`NOT_RECOUPMENT`), so a queue row containing one is a state the system
can no longer produce — and a fixture holding an unreachable state is a fixture that lies.

The takeback therefore stays exactly where it operationally belongs: on the batch claim payment,
as a `-4000` movement a biller can see and cannot post. `is_recoupment` is `false` on **both**
offices' queue rows, because 6b never sets it true; it is the column Slice 6d will gate on when
the typed-confirmation path arrives. The claim's own line still shows the corrected end state
(paid 18000).

**Every claim is confirmed AND reviewed.** `od_match_status = 'confirmed'` with an attributed
`od_match_confirmed_at` / `od_matched_by`, a version-2 `od_match_snapshot`, and a review stamp.
This is not decoration: Slice 6a added a CHECK in both directions (a claim carrying
`od_claim_num` MUST be confirmed), and the Slice 2 seeder set the ClaimNum while leaving the
status at its `not_run` default — so every `--execute` against a migrated database would have
failed on that constraint. The gate also refuses an unreviewed claim, so a fixture without the
review stamp could never demonstrate an approval at all.

**The colliding remittance key.** Both offices carry the **same** `remittance_key`:

```
fixture:remit:FIXTRACE-0001:FIXPAYER-01:2026-08-10
```

That is the exact collision that motivated `UNIQUE (office_id, remittance_key)` instead of the
source app's bare global unique: one carrier sends both practices a remittance under the same
trace number on the same day. Under a global unique, roland's row would have silently blocked
valley's. `rcm_posting_queue` carries the same office-scoped unique and is exercised by the
same pair. The same trick applies to `rcm_payer_rules`: one payer name, two offices, which is
`UNIQUE (office_id, payer_name)` doing its job.

The fixture's key formula covers *(trace, payer, payment date)* and deliberately omits the
amount, because the two practices' amounts legitimately differ and it is the component
collision that is under test. Deriving the **production** remittance key is Slice 5's job, not
this script's.

**Nothing looks posted.** No row in the fixture may read as having reached Open Dental. Claim
and batch statuses are never `posted`, `posted_amount_cents` and `posted_total_cents` are 0,
remittance keys sit at `pending`, queue rows sit at `approved`, queue lines at `pending`, and
`od_claim_payment_num` is null everywhere. A test enforces all of it.

---

## Test patients

Every `od_patient_id` in the fixture comes from this set, and `buildFixturePlan()` throws on
anything else:

| Office | PatNum | Name | Note |
| --- | --- | --- | --- |
| roland | `12827` | `Stedi Test 2` | |
| roland | `12828` | `Test, MangoTest` | |
| valley | `7115` | `Stedi TestValley` | **`7115` in roland is a different, real person** — which is why every row carries `office_id` |
| — | `11373` | — | **INVALID as a fixture.** Shared family phone → ambiguous by construction. Appears nowhere. |

Open Dental identifiers that are *not* patients — `od_claim_num`, `od_claim_proc_num` — are
deliberately in a 9.8–9.9 billion range that exists in neither practice's database, so a
mis-wired Slice 6 call would 404 rather than touch a real chart. **Nothing in this script ever
calls Open Dental.**

Everything else is invented: payer `Fixture Dental Plan of Testland`, claim numbers
`FIXCLM-*`, subscriber ids `FIXSUB-*`, trace `FIXTRACE-0001`, check `FIXCHK-0001`. The patient
*names* are the OD test records those PatNums actually point at — themselves synthetic, and
already documented in `CLAUDE.md` — because a claim row whose name disagreed with its
`od_patient_id` would be worse than one that matches.

---

## The user map — a known gap

`rcm_user_map` is the crosswalk every actor column (`created_by`, `approved_by`,
`assignee_user_key`, …) references. The platform's own user table (`app_user`, roles spine)
lives in the **control** database, and the seeder holds a **tenant** connection, so the real
staff set is not derivable in-script.

It therefore seeds three documented fixture identities on the reserved `.invalid` TLD
(RFC 2606 — guaranteed non-deliverable):

| `user_key` | `platform_email` | `legacy_role` |
| --- | --- | --- |
| `fixture-poster` | `rcm-fixture-poster@example.invalid` | `poster` |
| `fixture-lead` | `rcm-fixture-lead@example.invalid` | `lead` |
| `fixture-admin` | `rcm-fixture-admin@example.invalid` | `admin` |

`--user-map <path>` takes a `{ userKey: platformEmail }` JSON file and overrides the emails —
the same shape TC's importer took, and TC left the same question open. The three fixture
identities always survive an override, because every fixture row attributes to
`fixture-poster` or `fixture-lead` and removing them would leave those rows unattributable.

**Open for Slice 6** (PM ruling, 2026-08-14): mapping fixture rows onto real platform
identities. Slice 3 mounts RCM behind Entra SSO and the roles spine, but the crosswalk is not
needed until posting attributes a real actor — so it waits for the slice that posts. Nothing
should be decided about it here.

---

## Verification

`backend/test/rcmSeedFixtures.test.js` (34 tests, no database required) covers: every guard
branch including the default refusal; dry-run determinism; idempotency; transaction rollback;
referential completeness with same-office parents; both-office presence; the test-patient
allowlist; the nothing-looks-posted rule; and a drift guard asserting every column the seeder
writes exists in the Slice 1 migration.

The Slice 2 PR records a rehearsal against a throwaway PG16 with the real migration applied:
two byte-identical dry-runs, `--execute` → 65 created, re-run → 0 created, and the
`GUARD_NON_FIXTURE_DATA` refusal proven by inserting one foreign row.

---

## Related

| Topic | Doc |
| --- | --- |
| The `rcm_*` schema these rows land in | [RCM_SCHEMA.md](RCM_SCHEMA.md) |
| Why the posting queue and the recoupment flag exist | [RCM_OD_WRITES.md](RCM_OD_WRITES.md) |
| The ERA corpus | [backend/test/fixtures/rcm/README.md](../backend/test/fixtures/rcm/README.md) |
| The data-migration playbook this follows | [TC_IMPORT.md](TC_IMPORT.md) |
