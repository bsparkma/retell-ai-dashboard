# feature/hyg-staff-on-users — signatures move onto the Users page

**Branch:** `feature/hyg-staff-on-users`, cut from `origin/develop` @ `f9d792e`. Opened as a PR to `develop`; **not merged**.

## What changed, in one line

You now enter a person's "Signature on notes" (the name and licence a hygiene note prints) on **their row of the Users page**. The note matches on their own sign-in email, which the server reads from their user record. Nobody types it, so a licence can no longer fail to print because of a typo. `/admin/staff` is gone.

## How it works

- **Where:** every row on `/admin/users` (practice admin) and on the Developer Console's *Practices → People* tab (super_admin). Both pages use the same shared editor, `TenantUserEditor`. The panel is collapsed by default, shows for every role, and loads only when opened.
- **Fields:** *Full name, as it prints* and *Licence # (optional)*. If the licence is blank, the name prints alone, never with a placeholder. A licence with no name is refused.
- **What it writes:** it upserts the person's `hyg_staff` row through the existing `staffStore`.
  - `sign_in_ids` is set to exactly `[their app_user email]`, taken from the app_user row on the server.
  - The office is their home office, or the first office if they have none.
  - The request body is `{ fullName, license }` and nothing else. The schema is strict, so a body that names a sign-in or an office is rejected with a 400.
- **Removing or disabling:**
  - Clearing both fields deactivates the row. There is no delete.
  - Deactivating the *user* deactivates their signature row in every office.
  - Re-enabling the user does **not** bring the signature back.
  - A disabled user's signature can be cleared but not set (`409 USER_DISABLED`).
- **Rules carried over:** a practice admin cannot change a platform administrator's signature, the same rule the Users page already has. Editing your own signature is allowed.
- **Audit:** one row per `hyg_staff` write, in the practice's own log, using the vocabulary `/api/platform/hyg-staff` already uses (`CREATE` → NULL, `edited:<fields>`, `active`, `inactive`). It never records the name or licence itself.
- **Honest states:**
  - A write that can't be read back answers `SAVE_NOT_CONFIRMED`.
  - A write that landed but whose audit row failed answers `SAVED_AUDIT_FAILED`, with "was saved — reload".
  - A user deactivation whose signature cleanup fails answers `SIGNATURE_RETIRE_FAILED`, with "the user was deactivated — disable again to finish". The cleanup is safe to repeat.

New endpoints (same gates as the doors they sit in):

| Door | Endpoints |
| --- | --- |
| `/api/users` (`admin.all`) | `GET` / `PUT /:email/signature` |
| `/api/platform` (super_admin) | `GET` / `PUT /practices/:tenantId/users/:email/signature`. The tenant comes from the registry; an unknown practice gets a 404 before any database is opened. |

## What was retired, and what was kept

- **Removed:**
  - the `/admin/staff` route
  - its sidebar entry and the Admin hub's "Practice staff" card
  - `AdminStaff.tsx`
  - `admin-staff.test.tsx` and `admin-staff-shots.test.tsx`
  - the four client calls only that page used
- **Kept:**
  - `/api/platform/hyg-staff` and `staffStore` (gained one office-scoped lookup, `findBySignIn`)
  - the `config/hygStaff.js` fallback
  - every existing `hyg_staff` row, which still matches exactly as before
- **Untouched:** `signatureBlock`, `signatureFor`, `odWriter`.
- **No migration.** The table already had every column needed.
- **No Open Dental call anywhere in this slice.**

## ⚠ Decision for Beau: the built-in list switch

This behaviour is unchanged, but this page makes it easier to trigger, so it needs your call.

- An office with **no** `hyg_staff` rows prints licences from the built-in list in `config/hygStaff.js`.
- Once an office has **any** row, the table is the whole answer.
- So the **first** signature saved for Roland (or Valley) switches that office off the built-in list. From then on, anyone who hasn't been entered on the Users page prints their name **without a licence**. That is true even if the built-in list had their licence.

`/admin/staff` behaved the same way. The spec said not to change the match logic, so this PR makes the switch visible instead:

- Every signature answer carries `usingBuiltInList`.
- The panel shows an amber warning before that first save: *"…anyone not entered here will then print their name without a licence. Enter everyone who writes notes."*

Options if you want more than a warning:

- **(a)** Merge the table over the built-in list in `signatureRoster`. This changes the match logic, so it would be a separate slice.
- **(b)** Enter everyone for an office in one sitting before the first note is written.

Worth checking: does prod already have `hyg_staff` rows for either office?

## Smaller notes (deliberate, flagged for visibility)

- **Saving replaces the row's sign-ins with `[email]`.** That is what the spec asked for. A row created on the old page with an extra alias (a username, or a second email) loses that alias on its first save here.
- **Changing someone's home office leaves the old office's row active.** It still prints on that office's notes, which is right for staff who float. Deactivating the user retires the row in every office.
- **Re-saving a cleared signature takes two writes**, an edit and then a reactivation, not one atomic statement. A failure between the two answers `SAVE_NOT_CONFIRMED`, and retrying is safe.

## Tests

**Backend** (`node --test`):

| File | What it covers |
| --- | --- |
| `routes/users.test.js` (41, 12 new) | upsert writes the app_user email as the **only** sign-in; mixed-case path; home office and first-office fallback; blank licence → null; strict body (no `signInIds` / `email` / `office`); upsert-not-insert and alias reset; **clear deactivates**, re-save revives; platform-admin protection; own-row allowed; gate; user deactivation retires; `USER_DISABLED`; `SAVED_AUDIT_FAILED`, including the reactivation case; `usingBuiltInList` per office |
| `routes/userSignatureNote.test.js` (3, new) | **route level: a licence entered through the Users door prints on a staged note** (`Avery Example RDH #7777`; 7777 is not in the config fixture, so it can only come from this door); blank licence → name alone; cleared → licence no longer prints |
| `routes/platform.test.js` (31, 4 new) | console door writes into *that* practice's database only and audits in its log; unknown practice → 404 before any pool; strict body; deactivation retires; `USER_DISABLED`; `SAVED_AUDIT_FAILED` |
| `services/tenantUsers.test.js` (21, 3 new) | retirement in every office, only the user's own rows, audited; a role change doesn't retire; a failed retirement reports that the user was deactivated, and a retry finishes it |

**Dashboard** (vitest):

| File | What it covers |
| --- | --- |
| `admin-users.test.tsx` (+9) | collapsed by default on every role, loads only when opened; sends only `{ fullName, license }`; blank licence → null with "prints alone"; licence-without-name blocked; Remove; own row editable and shows the server's refusal verbatim; disabled row read-only; built-in-list warning shown before the first save and gone after |
| `platform-console.test.tsx` (+1) | the same panel writes through the practice's own door |
| `admin-hub-links.test.tsx` | updated: Users card only; no link to `/admin/staff` |

All synthetic: Avery, Jamie and Morgan Example.

## Gates

| Gate | Result |
| --- | --- |
| `pnpm run check` (tsc --noEmit) | clean |
| `pnpm run test` | 203 files / 3094 tests passed (first full run); signature files re-run green after each review round |
| `node --check server.js` | ok |
| `node --test` (full) | 4548 pass / 1 fail. The failure was `routes/sendToTc.test.js`, which this branch doesn't touch; it passes 18/18 run alone, twice. That is the known Node 22 test-runner decode flake. |
| `hyg-contract-bundle` byte check | green. `contract.gen.cjs` was regenerated with the pinned esbuild and `--alias:zod`. |
| No `any`; no real staff names | yes |

## Review (fresh-context subagent, 2 rounds)

- **Round 1:**
  - **Fixed:**
    - the built-in-list switch was invisible → `usingBuiltInList` and a warning
    - a disabled user could be given a signature through a direct PUT → `USER_DISABLED`
    - an audit failure after a committed write read as plain failure → `SAVED_AUDIT_FAILED` through both doors
  - **Noted above, not changed:** alias overwrite (it's the spec), the old-office row after a home-office change, and the two-step reactivation.
- **Round 2:**
  - **Fixed:** an audit failure on the edit returned before the reactivation, so the row stayed off behind a "was saved" message. The reactivation now always runs.
  - **Added:** console-door tests for both new codes.

## CI

Tracked on the PR (merge ref). See the PR's checks.
