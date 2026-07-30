# TC Module — Schema & Contract (Slice 1)

The `tc_*` tenant-database schema and the strict shared contract for the
Treatment Coordinator module (port of the standalone TC-app / DentaFlow).
Migration: `backend/migrations-tenant/1785373200000_tc_schema.js`.
Contract: `new-dashboard/shared/tc/{contract,emailBlocks,legacy,rows}.ts`.

This slice is SCHEMA + CONTRACT ONLY. No routes (Slice 3), no importer
(Slice 2), no Blob storage (later slice).

## Design decisions (PM review targets)

### 1. Money = integer cents, everywhere
Every money column is `*_cents bigint`; every contract field is `*Cents`
(non-negative integer). The legacy app mixed float dollars. Conversion rule at
import: `Math.round(dollars * 100)`; non-finite and negative inputs clamp to 0
(legacy patient portions already clamp at 0 — a negative is corrupt data).
These are dollars read aloud to patients: no float money anywhere, ever.

### 2. Follow-up unification — three legacy lists → ONE queue
The legacy PatientCase carried **two parallel follow-up systems** plus a
third campaign list:

| Legacy list | What it was | Shape |
|---|---|---|
| `followUps[]` (system 1, oldest) | Free-form reminders | no ids, `completed` boolean, free-text note |
| `followUpSteps[]` (system 2, current) | Cadence-engine steps | ids, pending/completed/skipped, outcome note, auto/manual source, patientResponded |
| `nurtureTouchpoints[]` (system 3) | Long-tail nurture campaign | ids, campaign type, channel (`call`/text/email), scriptTemplate, completedBy |

**Unified model: `tc_followups`** — one outreach work-queue row type,
discriminated by `kind ('followup'|'nurture')`. One table = one "what's due"
query for the TC (index `(office_id, status, due_date)`), one completion
model, one place the future scheduler reads.

Mapping (implemented in `shared/tc/legacy.ts` → `unifyFollowups()`):
- **System 2** maps 1:1 (`kind='followup'`, source preserved, ids kept in `legacy_id`).
- **System 1** maps with `source='legacy'`: `note`→`talking_point`,
  `completed:true`→`status='completed'` with `completed_at=NULL`
  (completion time was never recorded — null is the honest value), no legacy id.
- **System 3** maps to `kind='nurture'`: `scriptTemplate`→`talking_point`,
  `note`→`outcome_note`, channel `call`→`phone_call`, `completed_by` kept,
  `source='auto'` (touchpoints were always cadence-generated), campaign type
  in `nurture_type`.
- Items with an unparseable due date are dropped (a queue item without a due
  date is unactionable); the Slice 2 importer must count and report drops.
- `contactAttempts[]` are NOT follow-ups — they are timeline facts → 
  `tc_case_events` with `type='contact_attempt'` and a typed
  `{channel, outcome}` payload in `detail`.

### 3. office_id on every table
`office_id text NOT NULL CHECK IN ('roland','valley')` — **frozen internal
keys**; display labels are config. The legacy app's location key **`riley`
means the Fort Smith office and maps to `valley`** at the legacy boundary
(`legacyLocationToOffice`). Sole exception: `tc_legacy_user_map` is
tenant-global (staff work across both offices).

### 4. Derived legacy state is not stored
- `financingOptions[]` (per-case payment snapshots) — **dropped**. They were
  stale-by-design (the legacy DOM-04 bug: quoted monthlies that no longer
  matched the edited patient portion). Financing options are recomputed from
  `tc_library_config` (`financing_providers` + `financing_config` +
  `financing_settings`) × the case's patient portion at render time.
- `nextFollowUpDate` — **dropped** (deprecated in legacy; derived from the
  followup queue).
- Safety net: `tc_cases.legacy_snapshot jsonb` archives the FULL original
  legacy JSON per case at import, so even dropped fields remain recoverable.

### 5. jsonb where the structure is author-owned and deep
`tc_email_templates.blocks` (closed 8-type block union) and
`tc_library_config.value` (11 config sections) are jsonb validated by the
shared contract at every edge. Normalizing them into tables buys nothing and
would freeze editor iteration into migrations.

### 6. tc_library_config absorbs the localStorage settings
One row per `(office_id, section)`. Sections: `stages, objections, motivators,
lost_reasons, referral_sources, treatment_categories, financing_providers,
crown_pricing, financing_config, cadence_config, financing_settings`.
`financing_settings` is the legacy **per-browser localStorage**
FinancingSettings promoted to server truth (fixes two TCs seeing different
financing math depending on the laptop). Crown pricing and financing provider
minimums are converted to cents (`*Cents` fields) in the contract section
schemas.

## Table inventory

| Table | Purpose | PHI | Notes |
|---|---|---|---|
| `tc_cases` | Case master (patient, classification, value, nurture scalars) | **HIGH** — name, age, phone, email, notes, decision context, `legacy_snapshot` | `legacy_id` unique = import idempotency key; `od_patient_id` = OD PatNum |
| `tc_case_phases` | Treatment plan phases (ordered) | low (names/descriptions) | unique `(case_id, position)` |
| `tc_case_items` | Procedures within a phase | med — clinical procedures + fees | `od_proc_num` parsed from legacy `od_<n>` ids; money in cents |
| `tc_case_objections` | Logged patient objections | **HIGH** — `patient_words` is verbatim patient speech | |
| `tc_followups` | THE unified outreach queue (followups + nurture) | med — talking points/outcomes reference patient context | queue index `(office_id, status, due_date)` |
| `tc_case_events` | Case timeline (status changes, notes, contact attempts) | med | `detail` jsonb typed per event type |
| `tc_hygiene_intakes` | Hygienist chairside handoff (1:0..1 per case) | **HIGH** — clinical findings | accommodates the in-flight hygiene-intake workstream |
| `tc_preauth_cases` | Insurance pre-authorization tracker | **HIGH** — patient identity + carrier | optional `case_id` link (legacy had none) |
| `tc_communications` | Outbound patient email log | **HIGH** — `to_email`, `subject` | `template_name` denormalized so template deletion keeps history |
| `tc_email_templates` | Block-based email templates | low (template content) | `blocks` jsonb = closed 8-type union |
| `tc_gallery_cases` | Before/after gallery metadata | **HIGH** — titles embed patient names; photos by reference | `*_blob_key` → Azure Blob (later slice); bytes never in Postgres |
| `tc_smile_simulations` | AI smile-sim runs | **HIGH** — face photos by reference | `treatment_type` open vocabulary (no CHECK) |
| `tc_library_config` | Server-owned per-office config | none | PK `(office_id, section)`; section CHECK |
| `tc_legacy_user_map` | Legacy user slug → platform email | none (staff only) | tenant-global (documented office_id exception) |

## Legacy-field mapping (complete)

Case-level (`LegacyPatientCase` → `TcCase` / rows):

| Legacy field | Destination | Notes |
|---|---|---|
| `id` | `tc_cases.legacy_id` | unique; import idempotency |
| `patientName, age, phone, email, odPatientId` | identity columns | `''` → NULL; age outside 1–130 → NULL |
| `caseType, category, status, urgency` | same-name columns | vocab CHECKs incl. new `hygiene_review`/`pending_pt`/`partially_accepted` |
| `doctor` | `doctor_name` | free text |
| `tc` | `assigned_tc` | legacy slug/name; platform identity resolves via `tc_legacy_user_map` |
| `location` | `office_id` | **`riley` → `valley`** |
| `caseValue` | `case_value_cents` | ×100 rounded |
| `readinessScore` | `readiness_score` | clamped 0–100 |
| `financingStatus, preferredFinancingProvider` | same-name | |
| `decisionMakers, financialSituation, keyMotivators, contactPreference, bestTimeToReach, notes, referralSource, lostReason` | same-name | arrays as `text[]` |
| `diagnosedDate, statusChangedAt` | `diagnosed_date`, `status_changed_at` | normalized date / timestamptz |
| `nurtureCadence, inLongTailMode, nurtureEnrolledAt, nurturePhaseChangedAt, nurtureUnsubscribed` | same-name | |
| `nurtureCadenceOverride.{phase1Days,phase2Days}` | `nurture_phase1_days_override`, `…phase2…` | flattened |
| `phases[].{id,name,description}` | `tc_case_phases` | legacy numeric id → `position` |
| `phases[].items[]` | `tc_case_items` | money → cents; `od_<n>` id → `od_proc_num` + `legacy_item_id` |
| `objections[]` | `tc_case_objections` | `loggedAt` normalized to timestamptz |
| `followUps[], followUpSteps[], nurtureTouchpoints[]` | `tc_followups` | see decision 2 |
| `contactAttempts[]` | `tc_case_events` (`contact_attempt`) | typed `detail` |
| `caseEvents[]` | `tc_case_events` | |
| `hygieneIntake` | `tc_hygiene_intakes` | 1:0..1 |
| `financingOptions[]` | **DROPPED** (archived in `legacy_snapshot`) | stale derived data — recomputed at render (decision 4) |
| `nextFollowUpDate` | **DROPPED** (archived in `legacy_snapshot`) | deprecated + derived |

Other entities: `PreAuthCase` → `tc_preauth_cases` (all fields 1:1; missing
`location` defaults `roland`); `CommunicationLogEntry` → `tc_communications`
(`practiceId` dropped — tenant DB + `office_id` supersede it; `messageId` →
`provider_message_id`; `createdAt` → `sent_at`); `EmailTemplate` →
`tc_email_templates` (`practiceId` dropped, same reason); gallery entries →
`tc_gallery_cases` (`beforeImage`/`afterImage` file paths → `*_blob_key` at
import); `SmileSimulation` → `tc_smile_simulations` (same);
`library.json` sections + localStorage `FinancingSettings` →
`tc_library_config`; legacy users (`beau`,`holly`,`aarionna`,…) →
`tc_legacy_user_map`.

Deliberately NOT given tables: the COB calculator (pure functions over live OD
data — persists nothing) and the legacy `handoffs.json` (never implemented in
TC-app; the CareIN-handoff integration is its own future decision).

## PHI handling notes
- Blob-backed media (gallery, smile sims) stores **keys only**; bytes go to
  Azure Blob behind an entitlement-checked proxy in a later slice.
- `tc_cases.legacy_snapshot` is full-fidelity legacy JSON = PHI; it exists for
  auditability of the import. **Retention (PM decision, PR #23 review): KEEP
  through the port; purged as part of the Slice 7 decommission checklist,
  after the team signs off on the migrated data post-cutover.** Not forever,
  not now.
- Audit trail: PHI-touching TC routes will write `audit_log` rows (existing
  per-tenant table) when Slice 3 lands — no new audit machinery needed here.

## Review resolutions (PM, PR #23)
1. **App-role grants — RESOLVED IN THIS PR.** Investigation: the repo's only
   per-table grant mechanism is the explicit role-guarded GRANT inside a
   migration (audit_log pattern); there is no ALTER DEFAULT PRIVILEGES
   anywhere, and provisioning/CI grants schema USAGE only. The tc_schema
   migration now grants `carein_app` SELECT/INSERT/UPDATE/DELETE on all 14
   tc_* tables (REVOKE PUBLIC first; skip-with-NOTICE if the role is absent,
   same as audit_log). Note for the voice workstream: `call_record` itself
   has NO grants — `carein_app` cannot access it today; that will surface at
   the Slice 3b unified-calls cutover.
2. **`legacy_snapshot` retention: KEEP** — purge is a Slice 7 decommission
   checklist item after post-cutover data sign-off (see PHI notes above).
3. **Follow-up/nurture unification: APPROVED.** Visual separation later is a
   UI filter on `kind`, not a schema change.
4. **`patient_age` as stale age-at-entry: APPROVED.** Birthdate arrives with
   OD linking in Slice 5.
5. **Office keys `roland`/`valley`: CONFIRMED frozen**; `riley` → `valley` is
   the correct mapping.
