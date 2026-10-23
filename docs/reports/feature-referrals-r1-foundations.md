# Report: queue item 52, Referrals R1 (`feature/referrals-r1-foundations`)

**LANE: RED. NEEDS REVIEW. Beau merges.**
- A tenant migration.
- New shared vocabulary: 9 statuses, 3 urgencies, attachment types, the settings key
  `tc_referrals_enabled`, the policy env vars, and the settings section key `referrals`.
- A new UNIQUE constraint on the existing `tc_cases` table.

**Migration timestamp:** `1791800000000_tc_referrals.js`. origin/develop's newest at push is
`1791700000000_tc_checkout_attestation.js`; open PR #238 still carries `1791000000000`.

**Queue file:** `C:\Users\beau\carein cursor dashboard-dev\pm-prompts\queue\52-referrals-r1-foundations.md`
in the DEV clone, untracked. The PM's restatement and the OdPullDialog rider are folded into it.

## What shipped

**NOTHING SENDS.** There is no email, no fax, and no Open Dental read or write anywhere in this
slice. Everything is dark behind the per-office `tc_referrals_enabled` switch.

### Tables (`1791800000000_tc_referrals.js`)
| Table | What |
|---|---|
| `tc_referral_directory` | The office's specialists: practice name (required), specialist, specialty, contact person, email (CHECKed: blank or `x@y.z`), phone, fax, notes, preferred-format notes, active flag |
| `tc_referrals` | One referral:<br>• the patient (`office_id` + `od_patient_id`, server-derived, with a name snapshot)<br>• an optional `tc_case_id`<br>• referring provider, directory entry, specialty, reason, teeth (an array, or `"mouth"`), urgency (`routine`/`soon`/`urgent`), narrative<br>• status, with `status_changed_at` / `_by` |
| `tc_referral_events` | The transition log: from, to, actor, when, note. R2 writes it, with one audit row per transition. |
| `tc_referral_attachments` | Metadata only, for R4: name, type (png/jpeg/webp/gif/pdf), size (1 B–10 MB), blob key, uploader |
| `tc_referral_settings` | One row per office: `signoff_required` (default ON) and `autosend_on_approval` (default OFF) |

- **Status CHECK**, inline and exactly the nine: `draft, pending_signoff, approved, sent,
  acknowledged, patient_seen, closed, declined, cancelled`. A test pins it equal to the
  contract.
- **Every child references its parent through a composite (office_id, id) FK**, so no row can
  point at another office's row.
  - Referral → case and referral → directory are `RESTRICT`.
  - Events and attachments `CASCADE` with their referral.
  - `tc_cases` gains `UNIQUE (office_id, case_id)` so the FK can name the pair. Its PK is
    `case_id`, so the pair is already unique.
- carein_app grants live in the same migration.

### The switch: `tc_referrals_enabled` (`config/tcReferrals.js`)
- It is the same `createOfficeSwitch` as checkout:
  1. `TC_REFERRALS_ENABLED_<OFFICE>=false` always forces OFF;
  2. otherwise the stored `platform_setting` row decides;
  3. otherwise `=true` acts as a fallback;
  4. otherwise it is OFF.
- It is read at runtime and is stuck-off safe.
- It is flipped from the **platform console**: a new "TC referrals" tab, plus
  `GET/PUT /api/platform/tc-referrals-offices`, super_admin only and audited. It works like
  the checkout tab.

### `/api/tc/referrals` (mounted with `tcFull`)
| Route | |
|---|---|
| `GET /status` | `{enabled}` for the office. Never refused, so the Settings page can hide the section. |
| `GET /directory` | Ordered A→Z. Inactive entries only with `?includeInactive=true`. |
| `POST /directory` | Add an entry. The strict schema means a body cannot name an office or an owner. |
| `PUT /directory/:id` | Full edit, including active/inactive. |
| `DELETE /directory/:id` | Remove an entry. **409 `DIRECTORY_ENTRY_IN_USE`** if a referral names it; deactivate it instead. |
| `GET /settings` | The two policies, each with its `source` (`env` / `office` / `default`), plus `canEdit`. |
| `PUT /settings` | **Practice admin only** (`admin.all`). Either policy, or both. |

- Everything except `/status` returns **403 `REFERRALS_DISABLED`** while the office is off.
- Every change writes one audit row after it persisted:
  - directory changes record `active` / `inactive` as the prior state;
  - settings changes record the prior state as `signoff_on:autosend_off`.
- Every answer is the row the database read back.

### Settings → Referrals (front-desk friendly)
- A **Referral settings** card holds the two switches. They are editable by an admin only; for
  everyone else the card reads "Only a practice admin can change these". An env-pinned policy
  shows as locked.
- A **Specialist directory** card holds:
  - a table showing practice, specialist, specialty, contact and Active/Inactive;
  - **Add specialist** / **Edit**, which open a simple form. Only the practice name is
    required, and the email is checked on the form with the server's same rule;
  - an active toggle, Delete (with a confirmation), and **Show inactive**.
- The section is in the nav **only while referrals is on for the office**. A failed status
  check reads as off, and a `#referrals` deep link while off lands on Practice.

### Rider (Beau's staging walk): Pull from Open Dental, empty result
- When Open Dental returns no procedures, the button reads **"Nothing to import"** and is
  disabled.
- The "replaces every existing phase" warning and the named **'Hygiene visit <date>'** warning
  now show in the empty state too. Before, they lived inside the table branch and vanished.

## Judgment calls for Beau
1. **The two policies live in a tenant table, not `platform_setting`.** A practice admin
   changing a referral policy should not write the control plane. They keep the switch
   pattern's safety:
   - `REFERRAL_SIGNOFF_REQUIRED_<OFFICE>=true` pins sign-off ON;
   - `REFERRAL_AUTOSEND_ON_APPROVAL_<OFFICE>=false` pins auto-send OFF;
   - the unsafe direction is never taken from the environment.

   The on/off switch `tc_referrals_enabled` IS a `platform_setting`, as the spec says.
2. **The policies are admin-only** (`admin.all`), per the PM, for now.
3. **Deleting a specialist that a referral names is refused**; mark it inactive instead.
   Referral history keeps pointing at a real entry.
4. **Carried into R2's queue item** (from the reviewer):
   - **Sign-off OFF + auto-send ON is currently allowed.** R2 should decide whether to refuse
     that pair.
   - **Deleting a case that a referral names** will hit the RESTRICT FK. R2 must map that to
     a clear 409, not a 500.
   - **Directory PUT is a full replace**, so callers must send the whole entry. The UI does.

## Files
| File | Change |
|---|---|
| `backend/migrations-tenant/1791800000000_tc_referrals.js` | **new** |
| `backend/config/tcReferrals.js` | **new**: the switch |
| `backend/routes/tc/referrals.js`, `referralStore.js` | **new** |
| `backend/routes/tc/index.js` | the `/referrals` mount (bare `tcFull`) and its header line |
| `backend/routes/platform.js` | `/tc-referrals-offices` GET/PUT |
| `new-dashboard/shared/tc/referrals.ts` | **new** contract |
| `backend/tc/contract.entry.ts`, `contract.gen.cjs` | export + regenerate (pinned esbuild, `--alias:zod`) |
| `client/src/features/tc/referrals/referralsApi.ts` | **new** |
| `client/src/features/tc/settings/ReferralsSection.tsx` | **new** |
| `client/src/features/tc/settings/sections.ts`, `pages/tc/TcSettings.tsx` | the gated section |
| `client/src/pages/platform/TcReferralsPanel.tsx`, `pages/Platform.tsx`, `lib/api.ts` | the console tab |
| `client/src/features/tc/od/OdPullDialog.tsx` | the rider |
| `docs/SECRETS.md` | the three new env-var families |
| tests (all **new**) | backend: `routes/tc/tcReferrals.test.js` (16), `routes/tcReferralsSwitch.test.js` (4), `test/referralsMigration.test.js` (9)<br>dashboard: `tc-referrals-settings.test.tsx` (14 + shot), `platform-tc-referrals.test.tsx` (4), `tc-od-pull-empty.test.tsx` (3) |
| `docs/screenshots/tc/tccheckout-08-referrals-settings-1280x900-{light,dark}.png` | shots |

## Acceptance
| # | Row | Status | Evidence |
|---|---|---|---|
| 1 | Directory CRUD, office-scoped, from the UI | PASS | `tcReferrals.test.js` "1:" tests; UI tests "1:"; reviewer's real-PG drive (valley gets 404 and an empty list for roland's entries) |
| 2 | Settings persist and round-trip; admin-only | PASS | "2:" route tests (defaults, round-trip, per office, tc/office 403, env pins); UI tests "2:" |
| 3 | OFF → section and routes invisible/refused | PASS | "3:" route tests; `tcReferralsSwitch.test.js` (console ON then OFF, obeyed on the very next request); UI "3:" (hidden; failed check reads as off; deep link falls back) |
| 4 | Migrations additive with GRANTs; exactly 9 statuses | PASS | `referralsMigration.test.js`; reviewer on real postgres:17: up/down/up over existing `tc_cases` rows, a 10th status refused, cross-office FKs refused, RESTRICT and CASCADE behave, grants on all 5 tables |
| 5 | Rider: empty OD result | PASS | `tc-od-pull-empty.test.tsx` |

## Vocabulary sweep (reviewer, whole repo)
- **Statuses and urgency:** only in the migration, the contract (enum + a compiler-checked
  `Record` label map) and the pinning test. No other reader yet; R2 adds them.
- **`tc_referrals_enabled` / env vars:** the config, `platform.js`, tests and SECRETS.md. No
  allowlist or CHECK exists, the same as `tc_checkout_enabled`.
- **Section key `referrals`:** the `TcSettingsSectionKey` union, the registry and
  `renderStaticSection`. `tc-settings.test.tsx` still asserts its 9 labels unedited, because
  the section is hidden when the status call fails in that harness.
- **The mount** uses bare `tcFull`; `roleGateWiring.test.js` is green.
- **The platform tab:** the existing platform tests are green and unedited.

## Gates (commit 2ed2cb9 + docs)
```
backend $ node --check server.js  -> OK
backend $ node --test             -> # tests 3667  # pass 3664  # fail 0  # skipped 3
new-dashboard $ pnpm run check    -> exit 0
new-dashboard $ pnpm run test     -> Test Files 161 passed | 34 skipped; Tests 2583 passed | 196 skipped
```
The reviewer's run had one failure, `routes/platform.test.js` "Unable to deserialize cloned
data". That is the known Node 22 flake, and the file passed 20/20 in isolation.

## Lane
**RED. Both verdicts agree.** `classify-lane.mjs` says RED: the migration, the new
vocabulary, the `tc_cases` constraint, and the queue file marking itself RED. Its "removed text
asserted by an existing test" hits are false positives: every test file in the diff is new, and
the existing suites pass unchanged.

The reviewer (a fresh agent following `.claude/agents/reviewer.md`) returned round 1: **PASS,
LANE RED, no defects**. It ran the migration on real postgres:17 and drove the routes against
it as `carein_app`. One non-blocking documentation note (SECRETS.md) was taken.

## Staging test steps (after Beau merges)
1. Open **Platform → TC referrals** and turn on roland.
2. Open TC → **Settings**. **Referrals** is now the last section. Valley, which is still off,
   does not show it.
3. Add two specialists. Try a bad email: the form refuses it. Edit one, mark it inactive, then
   use **Show inactive** to see it again.
4. As an admin, flip **Doctor signs off** off and back on. As a TC user, the switches are
   read-only.
5. On any case, use **Pull from Open Dental** for a patient with no treatment plan. The button
   says "Nothing to import", and a checkout case shows the hygiene-section warning.
