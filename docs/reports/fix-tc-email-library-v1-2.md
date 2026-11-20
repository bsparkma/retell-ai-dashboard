# EL-1b: TC patient email library v1.2.0

Branch `fix/tc-email-library-v1-2` off `origin/develop` @ `205c105` (merge of PR #356). RED lane: it edits tests that PR #356 added. **No migration. Not merged.**

## What changed

- **Library v1.2.0.** `source.json` and `__fixtures__/golden.json` are byte-identical to the PM handoff files (checked with `cmp`). It now has 18 stages, 54 frames and 21 questions. `schedule_link` and `doctor_name` are no longer `{{tokens}}`: the composer writes them into the text through the globals `BOOK_ONLINE`, `BOOK_BULLET`, `REACH_ONLINE` and `DOCTOR`. The `review_referral` stage and the `review_link` question are gone.
- **Contract** (`new-dashboard/shared/tc/emailLibrary.ts`):
  - `review_link` is removed from `EMAIL_LIBRARY_LINK_KEYS`, `EMAIL_LIBRARY_MERGE_SETTINGS` and the `EmailLibraryAnswers` schema, so it is no longer in `EMAIL_LIBRARY_ANSWER_KEYS`.
  - The new constant `EMAIL_LIBRARY_RETIRED_SAVED_KEYS = ["review_link"]` names the retired key.
  - `EmailLibraryProfileResponse` gains `blankOptional`.
  - The bundle was regenerated with the pinned esbuild using `--alias:zod`.
- **Service** (`services/tcEmailLibrary/index.js`):
  - `missingSettings` now lists a setting only when it is blank **and** at least one composed email still prints its token. With v1.2.0 that list is normally empty.
  - New `blankOptionalSettings(answers)`.
- **Route** (`routes/tc/emailLibrary.js`):
  - Every read (GET /profile, GET /catalog, POST /preview with saved answers) runs `withoutRetiredKeys`, which strips only the keys in `EMAIL_LIBRARY_RETIRED_SAVED_KEYS`, before validating. The route never writes the row on a read; the key disappears at the office's next save.
  - `profileBody` now returns the validated answers rather than the raw row. Without this, the retired key would leak into a strict response.
  - The response adds `blankOptional`.
  - `review_link` is removed from the preview merge values.
- **Page** (`/admin/patient-emails`):
  - The amber "Not set yet" box still renders only when `missing` is non-empty.
  - For each entry in `blankOptional` the page shows one neutral muted line (not amber):
    - "No online scheduling link: emails ask patients to reply or call."
    - "No doctor name: emails say "we"."
  - The link length check reads `EMAIL_LIBRARY_LINK_KEYS` instead of a hard-coded pair.
  - The `review_link` help entry is removed.

## Files changed

| File | Change |
| --- | --- |
| `backend/services/tcEmailLibrary/source.json` | handoff v1.2.0, byte-identical |
| `backend/services/tcEmailLibrary/__fixtures__/golden.json` | handoff golden, byte-identical |
| `backend/services/tcEmailLibrary/index.js` | `missingSettings` gating, `blankOptionalSettings`, header counts |
| `backend/services/tcEmailLibrary/tcEmailLibrary.test.js` | sha pin, golden shape, review_link cases, new W tests |
| `backend/routes/tc/emailLibrary.js` | retired-key strip on read, `blankOptional`, no review_link merge value |
| `backend/routes/tc/tcEmailLibrary.route.test.js` | v1.2.0 facts, new M/R tests |
| `backend/tc/contract.gen.cjs` | regenerated (pinned generator) |
| `new-dashboard/shared/tc/emailLibrary.ts` | contract as above |
| `new-dashboard/client/src/pages/AdminPatientEmails.tsx` | neutral blank-optional lines |
| `new-dashboard/tests/admin-patient-emails.test.tsx` | v1.2.0 fixtures, three new tests |
| `new-dashboard/tests/tc-email-library-shots.test.tsx` | v1.2.0 fixtures, `blankOptional` |
| `docs/screenshots/tc/tcemlib-0{1,2}-*-{light,dark}.png` | refreshed |

## Proof compose.js is unchanged

`git diff origin/develop -- backend/services/tcEmailLibrary/compose.js` is empty (0 lines).

## Golden hashes reproduced (unchanged composer, sha256 of `JSON.stringify(compose(source, answers))`)

| Case | Emails | Stages | Hash |
| --- | --- | --- | --- |
| blank | 1872 | 18 | `5f0f2839…0170d` ✔ |
| same_day_buffered | 1872 | 18 | `30ec60a2…7bf1` ✔ |
| everything | 1638 | 17 | `5c035561…b551e` ✔ |
| links_set | 1872 | 18 | `9c434f80…72d54` ✔ |

The source sha256 pin is now `21a063957b4e075ef01c77071a8a48adffe7aab29262d28ef00f4966e35d4033`.

## Edited tests (all added by PR #356)

### `backend/services/tcEmailLibrary/tcEmailLibrary.test.js`

| Test | Before | After |
| --- | --- | --- |
| P (pin) | `SOURCE_SHA256 = '8dd80e2e…31ce5aa'` | `'21a06395…4d4033'` |
| G (golden) | `assert.equal(unresolvedTokens, c.unresolved_token_emails)`; `out[0].id === c.first_id`; `out[last].id === c.last_id` | `assert.deepEqual(sorted union of merge_fields, c.merge_fields)`. The v1.2.0 golden no longer records `unresolved_token_emails`, `first_id` or `last_id`. The "no `[[` slot" check moved to the new W test, where it asserts zero. |
| V (refusal codes) | `{ review_link: 'https://…x*300' } → LINK`; `{ review_link: 'javascript:…' } → LINK` | the same two inputs on `schedule_link → LINK`, plus `{ review_link: 'https://…' } → UNKNOWN_KEY` |
| M (missing) | `missing({})` fields `= [schedule_link, doctor_name, review_link]`; review_link stages `= [review_referral]`; schedule_link stages include `tp_recap` | `missing({}) = []`; `blankOptional({}) = [schedule_link, doctor_name]`; partial and fully-set cases |

### `backend/routes/tc/tcEmailLibrary.route.test.js`

| Test | Before | After |
| --- | --- | --- |
| P (PUT) | `libraryVersion === '1.1.0'` | `'1.2.0'` |
| V (refusals) | `{ review_link: 'http://…' } → LINK, field review_link` | `{ schedule_link: 'http://…' } → LINK`, and `{ review_link: 'https://…' } → UNKNOWN_KEY` |
| M (profile) | empty profile `missing` fields `= [schedule_link, doctor_name, review_link]`, with stages for each; after SAMPLE `= [review_link]` | blank profile: `missing = []`, `blankOptional = [schedule_link, doctor_name]`; then `[schedule_link]`; then `[]`, including on the PUT read-back |
| C (catalog) | version `'1.1.0'`, `emailCount 1980`, 20 questions ("22 in source") | `'1.2.0'`, `1872`, 19 ("21 in source"); no `review_link` question; no `review_referral` stage |
| X (preview unset) | `unresolved` includes `schedule_link`; body matches `{{schedule_link}}` | `unresolved` excludes `schedule_link`; body has no `{{schedule_link}}`. The `office_phone` assertions are unchanged. |
| N (no tc_messages) | preview stages `[tp_recap, scheduled_confirm, review_referral]` | `review_referral` replaced by `post_op_checkin`. The old stage no longer exists, so that call had silently turned into a 400. |

### `new-dashboard/tests/admin-patient-emails.test.tsx`

| Item | Before | After |
| --- | --- | --- |
| catalog fixture | `libraryVersion "1.1.0"`, stage `review_referral` | `"1.2.0"`, stage `post_op_checkin` |
| profile fixture | `missing: [{ schedule_link, [tp_recap] }]` | `missing: []`, `blankOptional: [schedule_link, doctor_name]` |
| preview fixture | body "book online at {{schedule_link}}, or call…"; unresolved `[office_phone, schedule_link]` | body "Reply to this email or call us at {{office_phone}}"; unresolved `[office_phone]` |
| test 1 | `missing-schedule_link` contains "Treatment recap"; 2 unresolved tokens | that assertion moved to its own test (below); 1 unresolved token |

### `new-dashboard/tests/tc-email-library-shots.test.tsx`

| Item | Before | After |
| --- | --- | --- |
| profile mock | `libraryVersion "1.1.0"` | `"1.2.0"`, plus `blankOptional` from the library |
| preview mock | merge value `review_link: null` | removed |

No other existing test was edited.

## New tests

- **Service W1:** across all four golden cases (subject, preheader and body of every email):
  - no `{{schedule_link}}`, `{{doctor_name}}` or `{{review_link}}`
  - no `[[`
  - no `{` or `}` outside a `{{merge}}` token
  - no email with stage `review_referral`
  - the source has no `review_referral` stage, `review_link` question or `review_link` merge field
- **Service W2:** for crown with `schedule_link` set, the exact URL appears in `tp_recap` A, `objection_time` B and `last_touch` C. With it blank, there is no link and no "book online" sentence.
- **Service W3:** `EMAIL_LIBRARY_RETIRED_SAVED_KEYS` is exactly `['review_link']`, and none of its keys is an answer key. `EMAIL_LIBRARY_MERGE_SETTINGS` is `['schedule_link', 'doctor_name']`.
- **Route M** (real assembled app): GET /profile with blank answers returns `missing = []` and `blankOptional` with both fields.
- **Route R1:** a stored 1.1.0 row holding `review_link`:
  - GET /profile returns 200 (strict-contract valid) without the key; catalog returns 200; saved-answers preview returns 200 and prints the saved link.
  - The row still holds the key after these reads, and no audit row is written.
  - The next PUT drops the key.
- **Route R2:** a PUT with `review_link` gets 400 `EMAIL_LIBRARY_UNKNOWN_KEY` (field `review_link`). An unsaved preview with it is also 400. Nothing is saved.
- **Route R3:** a stored row with `review_link` **and** `favorite_color` still gets the STALE 409 on profile, catalog and preview, naming `favorite_color`.
- **Mutation check:** with the strip removed, R1 and R3 fail. With it restored, both pass.
- **Page:**
  - With blank settings, both neutral lines appear with the exact copy, the amber box is absent, and the lines are not amber.
  - Only the blank settings get a line, and no lines show when both are set.
  - The amber box appears when `missing` is non-empty.

## Suites

| Gate | Result |
| --- | --- |
| `node --check server.js` | ok |
| backend `node --test` | **5164 tests: 5161 pass, 0 fail, 3 skipped** |
| `pnpm run check` (tsc --noEmit) | **clean** |
| `pnpm run test` (vitest) | **235 files passed / 41 skipped; 3395 tests passed / 256 skipped** |
| `tests/tc-contract-bundle.test.ts` | passes (bundle byte-identical to the pinned regeneration) |

## Guardrails

- No migration; `tc_email_library_profile` and its CHECKs are untouched.
- No change under `backend/services/messaging/` or `backend/services/tcNurture/`. No `tc_messages` row is written; test N covers this.
- No Open Dental calls, no AI calls, no `.env` read, no new secrets.
- The office is still `?office=`; `office_name` and `office_phone` are still refused.
- No `SELECT *`. No real patient names (the samples are "Jordan", "Dr. Sample" and `example.test` hosts). Strict TypeScript with no `any`. No files deleted.

## Staging test plan

1. **Legacy row.** Before deploying, an office that saved under v1.1.0 with a review link set has a row holding `review_link`. After the deploy, open `/admin/patient-emails` for that office.
   - Expect: the page loads with no "saved answers no longer match" error, and there is no review-link question.
   - Expect: `GET /api/tc/email-library/profile?office=<x>` shows no `review_link` and `libraryVersion: "1.1.0"`.
2. **Blank settings.** Use an office with no doctor name and no scheduling link.
   - Expect: no amber box, and two neutral lines: "No online scheduling link…" and "No doctor name: emails say "we"."
   - Expect: the Crown / Treatment recap preview has no `{{schedule_link}}` and no "book online" sentence.
3. **Link set.** Enter `https://book.example.test/sample` as the scheduling link and save.
   - Expect: "Saved", and the scheduling-link line disappears.
   - Expect: the Crown preview prints the URL in Treatment recap (Warm), Time objection (Short) and Last touch (Educational).
   - Expect: the profile row no longer holds `review_link`.
4. **Refusal.** `PUT /profile?office=<x>` with `{ "answers": { "review_link": "https://review.example.test" } }` returns 400 `EMAIL_LIBRARY_UNKNOWN_KEY`. A GET afterwards shows the profile unchanged, and `tc_messages` has no new rows.
