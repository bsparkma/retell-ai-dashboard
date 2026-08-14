# RCM Module — Schema (Slice 1)

The `rcm_*` per-tenant tables, ported from the standalone **rcm-posting** app.

**Source of truth for the port:** `rcm-posting @ fix/prod-acr-registry-identity` (9bf5ac8),
`drizzle/schema.ts` — 23 tables. **Companion:** [`RCM_OD_WRITES.md`](RCM_OD_WRITES.md), the
Open Dental write-coverage canon (Spikes 0a + 0b). Where this document makes a design claim
about what Open Dental can or cannot do, that document is the evidence.

**Slice 1 is schema only.** No data (Slice 2), no routes or `requireModule` (Slice 3), no OD
client code, no UI. Migration: `backend/migrations-tenant/1786622400000_rcm_schema.js`.
Tests: `backend/test/rcmSchemaMigration.test.js`.

---

## Design decisions (PM review targets)

### 1. office_id on every table — the source has no office dimension at all

The source app's own `officeSettings` comment concedes it: *"office identity is not yet
persisted on transactional rows, so today everything resolves to the `'__default__'` row."*
That is the single largest gap between the source and this platform, where office is a
correctness boundary (PatNum 7115 is a **different person** in each database) rather than a
reporting nicety.

Every `rcm_*` table therefore carries `office_id TEXT NOT NULL` with
`CHECK (office_id IN ('roland','valley'))`, identical to `tc_schema`. The `'__default__'`
sentinel does not survive the port.

**Two documented exceptions, both tenant-global:**

- **`rcm_user_map`** — billing staff work across both offices. The same exception
  `tc_legacy_user_map` takes, for the same reason.
- **`rcm_stedi_poll_state`** — one Stedi **account** covers both offices, so the poll cursor
  belongs to the account, not to a practice. Two per-office rows would each walk the same
  feed and double-poll it. Office attribution is not lost, it happens one layer down: an
  inbound 835 is attributed by payee onto `rcm_stedi_events` / `rcm_stedi_transactions`, both
  of which keep their `office_id`. The cursor records *how far we have read*; those rows
  record *whose money arrived*. The table is a singleton by construction — its primary key is
  a constant (`poll_state_id = 'stedi'`), so a second cursor row is a constraint violation
  rather than a silent second reader.

### 2. The remittance key is the dedupe primitive — and it is now office-scoped

`UNIQUE (office_id, remittance_key)`, **not** the source's bare global
`UNIQUE(remittanceKey)`.

The key is computed from `(traceNumber, payerId, paymentDate, paymentAmountCents)`. In a
two-office tenant those components can legitimately collide across offices — two practices
receiving distinct checks from the same payer on the same day. A global unique would let one
office's remittance **silently block the other's**, and the failure would look like
successful dedupe rather than a lost check. Proven both ways in the rehearsal: a duplicate
under `roland` is rejected `23505`; the same key under `valley` is accepted.

`rcm_posting_queue` enqueues on the same `(office_id, remittance_key)` primitive, so a
remittance cannot be queued for posting twice either.

### 3. varchar dates become real dates

The source stores 10 date fields as `varchar(20)`/`varchar(32)`, and every timestamp without
a zone. All become `date` / `timestamptz`. Full list in the table below.

One consequence is worth stating rather than burying: `claims.patientDOB` was `varchar NOT
NULL`, which admits the **empty string**. A real `date` cannot. `rcm_claims.patient_dob` is
therefore **nullable** — the alternative is an importer that drops rows whose DOB was blank,
which is worse than a null.

### 4. Full referential integrity, with ON DELETE chosen per relationship

The source declares **5** foreign keys across 23 tables (migration `0011`). This port
declares **41**. The default for anything carrying money is `RESTRICT`.

Two relationships the source expressed as untyped strings become real FKs. `depositId` and
`matchId` both turned out to be `bankTransactions.id` — `routers.ts:2540` sets
`matchId: input.depositId`, and `:2573` comments *"matchId = bankTransactionId from the
deposit matching flow"*. Both now reference `rcm_bank_transactions`; collapsing them into one
column is a Slice 3 decision, not a Slice 1 one.

**A contradiction in the source, resolved.** `postingAudits.batchId` is declared `NOT NULL`
while its FK is `ON DELETE SET NULL`. Those cannot both hold: deleting a batch would raise a
not-null violation rather than preserving the audit, which was the stated intent. Resolved as
`NOT NULL` + `RESTRICT` — a batch with a posting audit is not deletable at all.

**The one deliberate CASCADE on a money path** is `rcm_posting_queue_line → rcm_posting_queue`.
The plan and its lines are a single record of intent; a line without its queue row records
nothing.

### 5. Actors are crosswalk-typed

Every `createdBy` / `postedBy` / `approvedBy` / `assigneeUserId` / `leadUserId` `varchar(64)`
becomes a FK to `rcm_user_map`, `ON DELETE RESTRICT` so attribution cannot be erased by
deleting a user.

`NULL` means **system / automated**. The source encoded that as the magic string `'system'`
in `postingAudits.postedBy`, which a typed column cannot carry without seeding a fake user
row.

This matters more here than anywhere else in the platform: Open Dental's own audit trail
**cannot** distinguish which operator posted a payment. Every API write logs `UserNum: 0` and
`"Created by … through API."` (RCM_OD_WRITES §9). `rcm_posting_audits.posted_by` and the
platform `audit_log` are the only attribution that exists.

### 6. CARC/RARC live here because Open Dental will not take them

`ClaimAdjReasonCodes` is returned on GET and **absent from PUT** — denial reason codes are
read-only over the API (G3), and 0 of 100 sampled Received claimprocs on Roland carry one.
Structured denial and adjustment reasons therefore exist **only** in our schema.

`rcm_procedure_adjustments` carries them as typed columns — `group_code` (CARC group,
CHECKed to `CO/PR/OA/PI/CR`), `reason_code` (CARC), `remark_code` (RARC), `amount_cents` —
never free text. It is a table, not columns on the line, because the industry standard allows
3+ adjustments per procedure. `rcm_procedure_lines.adjustment_reason` survives as the
free-text field it always was, alongside rather than instead of the codes.

### 7. The posting queue exists because Open Dental has no transactions

`rcm_posting_queue` + `rcm_posting_queue_line` are **platform-native** — not in the source.
RCM_OD_WRITES §8 is the argument, and it holds under Branch A (drain target = the OD Cloud
API) exactly as it would have under Branch B.

The posting sequence is forced and non-atomic:

```
for each line:  PUT /claimprocs/{n}   Status=Received, InsPayAmt, WriteOff, DedApplied
                PUT /claims/{n}       ClaimStatus=R, DateReceived
                POST /claimpayments   claimNum + CheckAmt (must equal the sum above)
   (optional)   POST /documents/Upload  EOB PDF
```

The worst failure window is between the claim PUT and the check POST: *"the claim reads
Received with money on the lines and no check exists … recovery works, but only if the poster
knows exactly which claimprocs it had touched."*

That sentence is the whole specification for `rcm_posting_queue_line`. It records the
**intended** `InsPayAmt` / `WriteOff` / `DedApplied` per `ClaimProcNum`, in cents, **written
before the first OD call** — and as queryable columns rather than a jsonb blob, because
"which lines did I already write, and what did I intend for the rest" has to be answerable in
SQL while a run is stuck.

Two more things the schema pins down from day one:

- **`is_recoupment BOOLEAN NOT NULL`.** A negative supplemental is the **single irreversible**
  Open Dental operation (G10): it cannot be reverted (`400 "Cannot change Status from
  Supplemental…"`) and cannot be deleted (`DELETE /claimprocs` does not exist), and it then
  pins its claim and that claim's procedure permanently. Slice 6 gates on this column rather
  than inferring intent from the sign of an amount.
- **`carrier_eob_date DATE`.** OD's `DateCP` is **not writable and lies about it** — a write
  attempt returns `200 OK` and changes nothing (G2). The carrier's adjudication date is
  first-class data here, and posting must never claim it lives in Open Dental.

**Worker-split safe.** The queue references only `rcm_*` tables — nothing request-scoped — so
the future `ca-carein-rcm` worker can drain it with a database connection and nothing else.

### 8. Honest states

The queue status enum is `approved → posting → posted / failed / partially_posted`. Every
value is a fact:

| Status | Means |
| --- | --- |
| `approved` | A human approved it. **Nothing has been sent to Open Dental.** |
| `posting` | A drain holds it. |
| `posted` | The check exists in OD; `od_claim_payment_num` proves it. |
| `failed` | Nothing landed, or the failure is understood and nothing is half-written. |
| `partially_posted` | The sequence broke mid-flight. **The line rows say exactly where.** |

There is deliberately no value meaning "probably fine". Line statuses
(`pending → claimproc_written → claim_received → paid`, plus `failed`/`skipped`) are likewise
each a record of an OD call that **returned**, never an assumption.

`approved_by` is `NOT NULL` — a queue row exists only because a person approved it — and
`approved_at` is kept separate from `started_at`/`finished_at` so approval time is never
inferred from execution time.

### 9. Enums became text + CHECK

The source declares 15 `pgEnum`s. This repo's convention (`tc_schema`) is `text` with a CHECK
constraint: the same guarantee, no shared types for a later migration to trip over, and
`down()` has nothing but tables to drop. The `procedure_flag` enum survives as an array
CHECK: `flags <@ ARRAY[...]::text[]`.

### 10. uuid PKs + `legacy_id`

Every ported table gets a `uuid` primary key and, where the source had a business id, a
`legacy_id TEXT UNIQUE`. Same as `tc_schema`, and for the same reason: it is what makes Slice
2's importer re-runnable.

### 11. Money is bigint cents

The source is already integer cents — the port keeps that and **widens `integer` to `bigint`**
to match the platform convention and put the ceiling out of reach (int4 cents overflows at
$21.4M). No `numeric`, `float` or `money` column exists anywhere in this schema, and a test
enforces it.

---

## Table inventory

24 tables: **21 ported**, **3 platform-native**. Creation order is the order below; `down()`
drops the exact reverse.

| # | `rcm_*` table | Source table | Notes |
| --- | --- | --- | --- |
| 1 | `rcm_user_map` | *(replaces `users`)* | **Tenant-global** — staff work across both offices |
| 2 | `rcm_payer_rules` | `payerRules` | `UNIQUE(payerName)` → `UNIQUE(office_id, payer_name)` |
| 3 | `rcm_office_settings` | `officeSettings` | `office_id` is now the PK; `'__default__'` is gone |
| 4 | `rcm_vcc_processor_patterns` | `vccProcessorPatterns` | Unique now `(office_id, pattern_type, pattern)` |
| 5 | `rcm_stedi_poll_state` | `stediPollState` | **Tenant-global** singleton — the cursor belongs to the Stedi account |
| 6 | `rcm_stedi_events` | `stediEvents` | `event_id` unique (vendor-global id) |
| 7 | `rcm_stedi_transactions` | `stediTransactions` | `batch_id` FK added after `rcm_payment_batches` (mutual reference) |
| 8 | `rcm_bank_transactions` | `bankTransactions` | **"The deposit."** `matchedClaimIds` dropped — see below |
| 9 | `rcm_claims` | `claims` | PHI. Gains `od_patient_id` / `od_claim_num` |
| 10 | `rcm_procedure_lines` | `procedureLines` | Gains `od_claim_proc_num`; `serial id` → `position` |
| 11 | `rcm_procedure_adjustments` | `procedureAdjustments` | **CARC/RARC — the only structured home** |
| 12 | `rcm_activity_events` | `activityEvents` | Module feed; **not** the platform `audit_log` |
| 13 | `rcm_payment_batches` | `paymentBatches` | One carrier check spanning many claims |
| 14 | `rcm_batch_claim_payments` | `batchClaimPayments` | PHI |
| 15 | `rcm_claim_payment_history` | `claimPaymentHistory` | `RESTRICT` on both parents |
| 16 | `rcm_eob_uploads` | `eobUploads` | PHI (filenames carry patient names) |
| 17 | `rcm_posting_audits` | `postingAudits` | Source `NOT NULL`/`SET NULL` contradiction resolved |
| 18 | `rcm_remittance_keys` | `remittanceKeys` | `UNIQUE(office_id, remittance_key)` |
| 19 | `rcm_handoff_tasks` | `handoffTasks` | Partial unique: one OPEN task per `(deposit, type)` |
| 20 | `rcm_deposit_audit_events` | `depositAuditEvents` | Domain trail, distinct from `audit_log` |
| 21 | `rcm_approval_requests` | `approvalRequests` | `deposit_id` and `match_id` both → bank transactions |
| 22 | `rcm_recon_runs` | `reconRuns` | `rows`→`row_details`, `trigger`→`trigger_source` |
| 23 | `rcm_posting_queue` | **— platform-native —** | RCM_OD_WRITES §8 |
| 24 | `rcm_posting_queue_line` | **— platform-native —** | The pre-flight record |

### Not ported

| Source table | Why not |
| --- | --- |
| `users` | Standalone-app auth: `openId`, bcrypt `passwordHash`, its own role enum. Slice 3 mounts RCM behind the platform's Entra SSO + roles spine; a second identity store is exactly the drift that spine exists to prevent. Its one durable job — resolving actor strings on historical rows — is taken over by `rcm_user_map`. |
| `plaidItems` | Exists only to hold a live Plaid `accessToken` in a plaintext column, plus a sync cursor. On this platform credentials live in Key Vault, never a tenant table ([`SECRETS.md`](SECRETS.md)). Bank-feed ingestion is not in Slice 1 or 2; when it is ported the item/cursor row can return **without** the token. **Flagged for a PM decision rather than ported as-is.** |

### Columns dropped

| Column | Why |
| --- | --- |
| `bankTransactions.matchedClaimIds` (jsonb) | A relationship expressed as an integrity-free id array. Derivable: `rcm_payment_batches.bank_transaction_id → rcm_batch_claim_payments.claim_id`. Carrying both lets them disagree. |

---

## varchar → real date conversions

Every one of these was `varchar` in the source:

| Table | Column | Was | Now |
| --- | --- | --- | --- |
| `rcm_claims` | `patient_dob` | `varchar(20)` NOT NULL | `date` **nullable** (see §3) |
| `rcm_claims` | `service_date` | `varchar(20)` NOT NULL | `date` |
| `rcm_claims` | `received_date` | `varchar(20)` NOT NULL | `date` |
| `rcm_bank_transactions` | `posted_date` (was `date`) | `varchar(20)` NOT NULL | `date` NOT NULL |
| `rcm_bank_transactions` | `follow_up_at` | `varchar(32)` | `timestamptz` |
| `rcm_payment_batches` | `deposit_date` | `varchar(20)` | `date` |
| `rcm_batch_claim_payments` | `service_date` | `varchar(20)` | `date` |
| `rcm_claim_payment_history` | `payment_date` | `varchar(20)` | `date` |
| `rcm_remittance_keys` | `payment_date` | `varchar(20)` NOT NULL | `date` NOT NULL |
| `rcm_posting_audits` | `bank_deposit_date` | `varchar(20)` | `date` |

**Plus a class conversion:** every source `timestamp` (without time zone) is `timestamptz`
here — `createdAt`, `updatedAt`, `postedAt`, `approvedAt`, `reservedAt`, `completedAt`,
`uploadedAt`, `processedAt`, `receivedAt`, `lastPollAt`, `runAt`, `windowStart`, `windowEnd`,
`archivedAt`, `lastSignedIn`. A test enforces that no bare `timestamp` column exists.

---

## PHI handling notes

| Table | PHI columns |
| --- | --- |
| `rcm_claims` | `patient_name`, `patient_dob`, `subscriber_id`, `group_number`, `raw_extracted_json`, `eob_file_key`/`eob_file_url` |
| `rcm_batch_claim_payments` | `patient_name`, `subscriber_id` |
| `rcm_eob_uploads` | `filename` (routinely carries a patient name), `file_key`, `file_url` |
| `rcm_posting_audits` | `claim_details` jsonb (per-claim outcome including patient name) |
| `rcm_activity_events` | `message`, `detail` (free text written by the module) |

Same handling as the `tc_*` tables. Document bytes are not stored in Postgres — these tables
carry blob keys and metadata only. **No real patient data appears anywhere in this repo**; the
rehearsal fixtures use `Fixture, Synthetic`.

---

## Grants

Every `rcm_*` table is granted `SELECT, INSERT, UPDATE, DELETE` to the least-privilege app
role (`AUDIT_APP_ROLE`, default `carein_app`) **in the same migration that creates it** — the
repo's only per-table grant path, and the reason the `call_record` grant gap was a near-miss.
`REVOKE ALL … FROM PUBLIC` precedes it. If the role is absent (a superuser dev box) the grant
is skipped with a `NOTICE`.

`audit_log` is not mentioned by this migration and stays append-only. A test asserts both:
that every table in the create list is in the grant list, and that the string `audit_log`
never appears in the emitted SQL.

---

## Open questions for Slice 2 / 3

1. ~~**`rcm_stedi_poll_state` shape.**~~ **Settled in PM review of PR #81:** one Stedi account
   covers both offices, so the cursor is tenant-global and singleton. See §1.
2. **`deposit_id` vs `match_id`** on `rcm_approval_requests` resolve to the same bank
   transaction. Both are typed; collapsing them is a Slice 3 call.
3. **`rcm_claims.stedi_transaction_id` / `stedi_event_id`** are now real FKs to the vendor
   ids. If the legacy data carries ids whose transaction/event rows were never stored, Slice
   2's importer must either create the parent or leave the column null — the FK will not let
   a dangling id through.
4. **`plaidItems`** — see "Not ported".
5. **Composite office-consistency FKs** (`FOREIGN KEY (office_id, parent_id)`) were considered
   and not taken, because `tc_schema` sets the single-column convention and both parent and
   child already carry a CHECKed `office_id`. It would make a cross-office parent/child link
   structurally impossible rather than merely wrong. Worth revisiting if Slice 3 finds a code
   path that could produce one.
