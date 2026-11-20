# EL-1 — TC patient email library: frozen source, composer, per-office wording profile, preview

Branch `feature/tc-email-library-el1` off `origin/develop` (2686557). **DARK. Held: do not merge until the PM says the 11/19 train closed.** Not merged, no auto-merge.

## What shipped

The library (36 procedure blocks × 57 stage frames) is available in the app as wording config plus preview only. Nothing in this slice creates a `tc_messages` row, a draft or a send. There are no Open Dental calls and no AI calls.

## Files changed

**Backend**

| File | What |
| --- | --- |
| `backend/services/tcEmailLibrary/source.json` | The handoff file, byte-identical (sha256 pinned) |
| `backend/services/tcEmailLibrary/compose.js` | CommonJS port of the handoff `compose.js`. Function bodies are verbatim; only the UMD wrapper became `module.exports` |
| `backend/services/tcEmailLibrary/__fixtures__/golden.json` | The handoff golden file, committed as the fixture |
| `backend/services/tcEmailLibrary/index.js` | `LIBRARY_CLINICALLY_APPROVED = false`, catalog, missing settings, `composeOne` (preview), `resolveMergeFields` |
| `backend/services/tcEmailLibrary/profileStore.js` | Read / upsert SQL for the profile table (named columns, office-keyed) |
| `backend/migrations-tenant/1795400000000_tc_email_library_profile.js` | The new table, CHECKs and grants |
| `backend/routes/tc/emailLibrary.js` | `GET /catalog`, `GET /profile`, `PUT /profile`, `POST /preview` |
| `backend/routes/tc/index.js` | Mounts `/email-library` with `tcFull` |
| `backend/scripts/tc-email-library-verify-queries.js` | Real-Postgres verifier for the migration and store |
| `backend/tc/contract.entry.ts`, `backend/tc/contract.gen.cjs` | Export the new shared module; bundle regenerated with the repo's pinned esbuild command |
| `.github/workflows/build-test.yml` | One new CI step that runs the verifier after migrate |
| Tests | `services/tcEmailLibrary/tcEmailLibrary.test.js`, `routes/tc/tcEmailLibrary.route.test.js`, `test/tcEmailLibraryMigration.test.js` |

**Shared contract and dashboard**

| File | What |
| --- | --- |
| `new-dashboard/shared/tc/emailLibrary.ts` | Strict zod answers schema, the coded validator, and the catalog / profile / preview shapes |
| `client/src/pages/AdminPatientEmails.tsx` | The page |
| `client/src/features/tc/emailLibrary/emailLibraryApi.ts` | API client; every response is parsed through the contract |
| `client/src/App.tsx` | Route `/admin/patient-emails` |
| `client/src/lib/permissions.ts` | `"/admin/patient-emails": "tc.full"` |
| `client/src/pages/admin/settingsHub.ts`, `client/src/pages/Admin.tsx` | Hub card plus its own "Patient emails" block |
| Tests | `tests/admin-patient-emails.test.tsx`, `tests/tc-email-library-shots.test.tsx` (skipped unless `TC_SHOTS=1`) |
| Screenshot tooling | `scripts/shoot-tc-email-library.mjs` |
| Screenshots | `docs/screenshots/tc/tcemlib-01-admin-preview-1280x1400-{light,dark}.png`, `tcemlib-02-read-only-1280x1400-{light,dark}.png` |

Zero changes under `backend/services/messaging/` and `backend/services/tcNurture/`. None to `normalizeCall`, the call store, replicas or infra. No existing test was edited; every test file in the diff is new.

## Migration

- **Number: `1795400000000`.**
- **Re-check at push:** I re-fetched before pushing. The newest tenant migration on `origin/develop` is still `1795200000000_hyg_visit_addendum.js`, so nothing is at or above 1795400000000 and no renumber was needed.
- **Open PR scan:** the only open PR is #1 (against main, March), and it touches no tenant migration or contract bundle.

Table `tc_email_library_profile`:

- Columns: `office_id text PRIMARY KEY`, `answers jsonb NOT NULL`, `library_version text NOT NULL`, `updated_by text NOT NULL`, `updated_at timestamptz`.
- Office CHECK: the MT-2b2 format pattern, inline at `addConstraint`: `office_id ~ '^[a-z][a-z0-9_-]{1,31}$'`. No office key appears anywhere in the migration.
- Grants: `carein_app` gets SELECT, INSERT, UPDATE (no DELETE), REVOKE ALL FROM PUBLIC, inside the same `pg_roles` guard as `1791100000000_tc_nurture.js`.

## Permission guards (exact)

| Route | Guards, in order |
| --- | --- |
| Every route | Mount `router.use('/email-library', tcFull, ...)` (`tcFull = requirePermission('tc.full')`), behind `requireModule('tc')` on `/api/tc`. Inside the router, `requireOffice` (`makeRequireOffice`), so the office comes from `?office=`, one of the session tenant's offices, never from the body |
| `PUT /profile` | Also `requirePermission('admin.all')`, attached to the route itself |

The `admin.all` gate on PUT is the same middleware and action MT-2c uses at `server.js` for `/api/admin/office-settings`. MT-2c puts it at the mount. I attached it to the route here so the reads stay at `tc.full`, which is what makes the page read-only for non-admins.

`GET /profile` returns `canEdit: holdsPermission(req, 'admin.all')`. This is a UX hint only; the server enforces the gate.

## Answer validation

One refusal code per failure. The validator lives in the shared contract, so the server and the page run the same function.

| Code | When |
| --- | --- |
| `EMAIL_LIBRARY_ANSWERS_NOT_OBJECT` | Answers are not an object |
| `EMAIL_LIBRARY_OFFICE_FIELD_REFUSED` | `office_name` or `office_phone` is present (refused, never silently dropped) |
| `EMAIL_LIBRARY_UNKNOWN_KEY` | A key that is not a stored question |
| `EMAIL_LIBRARY_NOT_BOOLEAN` | A yes/no answer that is not a boolean |
| `EMAIL_LIBRARY_BAD_OPTION` | A select or multi value that is not a declared option |
| `EMAIL_LIBRARY_BAD_PROCEDURE` | A `services_off` entry that is not a real procedure id |
| `EMAIL_LIBRARY_TEXT_NOT_STRING` | A text answer that is not a string |
| `EMAIL_LIBRARY_TEXT_TOO_LONG` | Over 120 characters after trimming (200 for amenities) |
| `EMAIL_LIBRARY_TEXT_FORBIDDEN_CHARACTER` | Contains `{ } [ ] < >`, a control character, a newline, or U+2028/2029 |
| `EMAIL_LIBRARY_CANCEL_HOURS_INVALID` | `cancel_hours` is not an integer string from 1 to 168 |
| `EMAIL_LIBRARY_LINK_INVALID` | A link that is not https, not parseable, contains whitespace, or is over 300 characters |

The contract's key and option lists are pinned to `source.json` by a test, so a wording PR that adds a question or option fails until the contract follows.

## Results

| Check | Result |
| --- | --- |
| Backend suite (`node scripts/shard-runner.mjs`, CI's runner) | **5158 tests: 5155 pass, 0 fail, 3 skipped** (4 shards, all green). The 3 skips are pre-existing |
| Backend syntax gate (`node --check server.js`) | OK |
| Dashboard suite (`pnpm run test`) | **3392 passed, 254 skipped, 0 failed** (235 files passed, 40 skipped). `tc-contract-bundle.test.ts` passes on the regenerated bundle |
| Dashboard typecheck (`pnpm run check`, i.e. `tsc --noEmit`) | **Clean, 0 errors** |
| Real Postgres (16, ephemeral, CI's exact prep and migrate) | `tc-email-library-verify-queries.js` passed: 5 part-A checks, and the real down() → up() verified with grants exactly INSERT, SELECT, UPDATE. Also re-ran `office-format-checks` and `hyg-visit-addendum` verifiers (pass) and `smoke-spine` (16/16) |
| Node-22 "Unable to deserialize cloned data" flake | Did not occur |

The real-SQL requirement is met two ways. The route tests drive the actual route SQL through the TC harness. The verifier runs the same `profileStore` statements against the migrated schema: upsert, read-back with jsonb key reordering, whole-object replace, CHECK refusals, and the app role's missing DELETE.

## Golden hashes reproduced

Each hash is sha256 of `JSON.stringify(compose(source, answers))`. All three were reproduced by the port, and also by the module's frozen in-memory copy of the source.

| Case | Emails | `output_sha256` |
| --- | --- | --- |
| blank | 1980 | `2429f63d0b7c6a4ee63a1bedbf6b04dec8b516ed8d234c266a12b7979addc48b` |
| same_day_buffered | 1980 | `488c2bf3fe78bfb0046eda0450f5ab78f1a8c49fbad5cb2d8bbd08636e9a74b5` |
| everything | 1737 | `74553b489b32b7de4e1da12ab085658ca74caafba4f9d65c331f7cf42340f5e2` |

Source pin: `8dd80e2e89b966b4b54a67a1a69c42bf8dc72b51e13d104265cbd504231ce5aa`.

The test also checks procedure and stage counts, first and last id, and that 0 emails contain an unfilled `[[TOKEN]]`.

## Staging test plan (6 steps)

1. **Migration.** After deploy to staging, confirm the migrate job applied `1795400000000_tc_email_library_profile`, and that `\dp tc_email_library_profile` shows `carein_app` with SELECT, INSERT, UPDATE only.
2. **Read-only view.** Sign in as a `tc` or `office` user and open `/admin/patient-emails` directly. TC has no tenant entitled yet, so on a tenant without TC this is a 403 by design; use the entitled staging tenant. Expect:
   - the draft banner;
   - the read-only note and no Save button;
   - a preview that shows `{{schedule_link}}` highlighted and listed.
3. **Save as admin.** As an admin, fill Doctor name, a `https://` scheduling link, same-day crowns on, and Braces under "does NOT provide". Save. Expect:
   - "Saved" appears only after the response;
   - a reload shows the same answers;
   - Braces is gone from the Procedure picker;
   - one `audit_log` row with `resource_type = tc_email_library_profile`, `resource_id = roland`, `prior_state = unset`.
4. **Refusals.** As admin, enter `Dr. {x}` or a line break in a text field, and `http://...` in a link. Expect each to be named on its field and Save to be off. A direct `PUT` with `office_phone` should return 400 `EMAIL_LIBRARY_OFFICE_FIELD_REFUSED`, and nothing changes.
5. **Live preview.** Switch procedure, stage and tone. Edit an answer without saving. Expect:
   - the preview updates with an "Unsaved answers" badge;
   - the office name and phone in the signature come from Practice info;
   - with no phone set there, `{{office_phone}}` stays highlighted rather than turning into "the office";
   - the sender line is your display name.
6. **Nothing sent.** Confirm no new `tc_messages` or `tc_communications` rows were created during steps 3–5. `PUT /api/tc/library/tc_email_library_profile?office=roland` should return 400 `UNKNOWN_SECTION`.

## Deviations, and why

- **Hub card placement.** `tests/sc1-settings-hub.test.tsx` pins the exact card list of the practice group and of the TC module block. Adding the card to either would have meant editing an existing test, which the brief forbids without arguing it first. Instead the card sits in its own "Patient emails" block under Module settings (`data-testid="admin-module-tc-email-library"`, about 8 lines in `Admin.tsx`). That also marks it as a draft.
  - **My argument for later:** once the library is approved, move the card into the Treatment Coordinator block and update that test's `admin-module-tc` expectation in the same PR.
- **The page is `tc.full`, not `admin.all`.** It has its own `ROUTE_PERMISSIONS` entry (`/admin/tc/settings` does the same), because the brief requires non-admins to see it read-only. The hub card still only reaches admins, because `/admin` itself is `admin.all`, so other users reach the page by URL.
- **Validation is slightly tighter than the brief in four places:**
  - Links also refuse `{ } [ ] < >` and control characters. They are printed inside emails like the free text.
  - U+2028 and U+2029 count as line breaks.
  - `cancel_hours` refuses leading zeros (for example `048`).
  - Blank, null and empty-list answers are normalized to "not set" and dropped. Lists are stored in the source's option order with duplicates removed.
- **Extra database CHECKs beyond the brief:**
  - `updated_at` is `NOT NULL DEFAULT now()`.
  - `answers` must be a JSON object and may not hold `office_name` or `office_phone`, so the database refuses them even if the server is bypassed.
  - `library_version` and `updated_by` cannot be blank.
- **Office phone in the preview.** `officeMergeValues` returns the send-time filler "the office" when no phone is configured. The preview treats that as unresolved, per the honest-state rule. Office name `Unmapped` is treated the same way.
- **Sender name.** If the signed-in user has no display name, `sender_name` is left unresolved rather than falling back to their email address.
- **Preview error codes.** The preview refuses by name:
  - an unknown procedure, stage or tone is a 400;
  - a procedure in `services_off` is 409 `EMAIL_LIBRARY_SERVICE_OFF`;
  - a stage with no frame for the office (for example `benefits_deadline` under `no_insurance`) is 409 `EMAIL_LIBRARY_STAGE_NOT_USED`.
- **Preview composes a narrowed source.** It composes only the one block and the one frame. A test asserts this equals the full compose's email for every email in two answer sets.
- **Stale saved answers.** If saved answers stop validating (possible only after a future source change drops a question), catalog, profile and preview return 409 `EMAIL_LIBRARY_SAVED_ANSWERS_STALE`.
- **Contract bundle.** No other open PR regenerates `contract.gen.cjs`. If one appears before merge, the second to merge rebases and regenerates.
- **Repo housekeeping, not touched.** A stale 0-byte `.git/packed-refs.lock` (dated 12:57 today, no git process running) sits in the PROD folder's shared `.git`. Git prints a warning on every ref write, but commits and pushes work. I left it alone because it is in the PROD folder. Deleting it by hand is safe whenever convenient.
