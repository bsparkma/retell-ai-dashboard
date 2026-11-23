# EL-1c: TC patient email library v1.3.0 (the doctor's clinical review)

Branch `fix/tc-email-library-v1-3` off `origin/develop` at `7db7911` (merge of PR #357).
No migration. No change to `tc_email_library_profile` or its CHECKs. Zero changes under
`backend/services/messaging/`, `backend/services/tcNurture/`, `backend/migrations*/`.
No Open Dental calls, no AI calls, no `.env`, no new secrets. No `tc_messages` row is written
(pinned by the existing `N:` route test and the new route test).

## Files changed

| File | Change |
| --- | --- |
| `backend/services/tcEmailLibrary/source.json` | Replaced with the handoff file, byte-identical. sha256 `f091ef388d9decc5561ec0fc7001a9bedb88aa2ce41fe1f56c8729dc1b663cd8` |
| `backend/services/tcEmailLibrary/__fixtures__/golden.json` | Replaced with the handoff file, byte-identical (sha256 `600023e6…82df3`) |
| `backend/services/tcEmailLibrary/compose.js` | The handoff's two behavior hunks only (diff below) |
| `new-dashboard/shared/tc/emailLibrary.ts` | Six new keys in the yes/no, select and multi lists and in the strict zod object |
| `backend/tc/contract.gen.cjs` | Regenerated with the pinned esbuild from `new-dashboard/` (`--alias:zod`); never hand-edited. `tc-contract-bundle.test.ts` passes |
| `new-dashboard/client/src/pages/AdminPatientEmails.tsx` | `show_if` evaluator plus the hidden-answer drop (see below) |
| `backend/services/tcEmailLibrary/tcEmailLibrary.test.js` | sha pin moved, plus 6 new tests |
| `backend/routes/tc/tcEmailLibrary.route.test.js` | 3 v1.2.0 pins moved, plus 1 new test |
| `new-dashboard/tests/admin-patient-emails.test.tsx` | 3 new tests (no existing test edited) |
| `new-dashboard/tests/tc-email-library-shots.test.tsx` | Version pin, plus two sample answers so the new questions show answered |
| `docs/screenshots/tc/tcemlib-0{1,2}-*-{light,dark}.png` | Refreshed (4 files) |

`index.js` needed no change: `catalog()` already passed `show_if` through to the client.
`blankOptional` and `missing` logic are unchanged.

## compose.js: the full diff against develop

The handoff file (sha256 `0beb017a…dd0ff11`) is a UMD IIFE. Develop's file is the CommonJS
port with `module.exports = { compose }`. As instructed, I kept the CommonJS export shape and
applied only the two behavior hunks. **The resulting file therefore does not hash to
`0beb017a…`; it is `7ff04256…76947`.** Proof of behavior identity: with indentation removed,
every function body from `function listPhrase` through `return out;` is byte-identical between
the two files (checked by script). Every golden hash also reproduces (next section).

```diff
@@ -56,7 +56,8 @@ function blockFor(src, ans, proc) {
   const b = JSON.parse(JSON.stringify(proc));
   for (const r of src.rules) {
     if (!r.procedures.includes(b.id) || !test(src, ans, r.when)) continue;
-    const val = Array.isArray(r.text) ? r.text.map(t => interp(src, ans, t)) : interp(src, ans, r.text);
+    const ip = t => (Array.isArray(t) ? t.map(ip) : interp(src, ans, t));
+    const val = ip(r.text);
     if (r.mode === "replace") b[r.field] = val;
     else if (Array.isArray(b[r.field])) b[r.field] = b[r.field].concat(val);
     else b[r.field] = b[r.field] + " " + val;
@@ -78,6 +79,7 @@ function fill(text, b, g) {
     WHOSE: parent ? "your child's" : "your", WHOM: parent ? "your child" : "you",
     HOW_FEELING: parent ? "How is your child doing?" : "How are you feeling?",
   }, g);
+  if (parent) for (const k of Object.keys(g)) if (k.endsWith("_KIDS")) t[k.slice(0, -5)] = g[k];
   b.faq.forEach((qa, i) => { t["Q" + (i + 1)] = qa[0]; t["A" + (i + 1)] = qa[1]; });
   let out = text;
   for (let pass = 0; pass < 2; pass++) out = out.replace(/\[\[(\w+)\]\]/g, (m, k) => (k in t ? t[k] : m));
```

Nothing else in the file changed. The header comment is untouched.

## Golden cases reproduced

`sha256(JSON.stringify(compose(source, answers)))` with the new compose.js:

| Case | Emails | Hash reproduces |
| --- | --- | --- |
| `blank` | 1872 | yes |
| `beau_offices` | 1872 | yes |
| `no_insurance_minimal` | 1638 | yes |
| `links_set` | 1872 | yes |

The source checks out as follows: version 1.3.0, 36 procedures, 18 stages, 54 frames,
27 questions, 36 rules, and the 4 new globals.

### One discrepancy with the brief: 17 FAQ rules, not 11

The brief says 11 rules target `faq`. The source has **17**, and all of them use
`[question, answer]` pair lists:

- 1 for `same_day_crowns` and 10 for `insurance_mode=no_insurance`. These are the 11.
- 3 for `parent_in_room` (yes, child_first, no).
- 3 for `sleep_test` (home_test, both, refer).

This does not affect the goldens. The new test pins the source's real count (17) and its
breakdown, not the brief's number.

## Contract

The six new keys use the same validation classes as their siblings:

- `surgical_guides` and `immediate_implants` are yes/no. A non-boolean is refused with
  `EMAIL_LIBRARY_NOT_BOOLEAN`.
- `parent_in_room` and `sleep_test` are selects. An undeclared value is refused with
  `EMAIL_LIBRARY_BAD_OPTION`.
- `sedation_kids` and `new_patient_welcome` are multis. An undeclared value is refused with
  `EMAIL_LIBRARY_BAD_OPTION`. A repeated value is **collapsed** into the source's option order,
  exactly as `sedation` and `schedule_perks` already behave. It is not refused; that is the
  existing sibling class.

Other contract behavior:

- `office_name` and `office_phone` are still refused (`EMAIL_LIBRARY_OFFICE_FIELD_REFUSED`).
- The `review_link` retired-key tolerance is unchanged: `EMAIL_LIBRARY_RETIRED_SAVED_KEYS`
  is still `["review_link"]`.
- The existing `C:` test, which pins the contract's key and option lists to the source, passes
  against 1.3.0.

## The settings page and `show_if`

Develop's `shown()` only understood a bare yes/no condition (`draft[show_if] === true`). The two
new conditions are `implant_surgery=in_house`, and `implant_surgery` defaults to `in_house`. The
old reading would have hidden both follow-ups for every office that left the default alone.
`shown()` now reads a condition exactly as compose.js `test()` does:

- `key=value` compares the answer to the value.
- A leading `!` negates the condition.
- An unanswered question reads as its library default.
- A bare `key` is true when the answer is `true`, a non-empty list, or text other than `"no"`.

When `show_if` hides a question, its answer is dropped client-side before validation. Preview,
"unsaved" detection and Save all work from that filtered set, so a stale hidden answer is never
previewed or saved. The draft itself keeps the value, but a Save replaces the draft with the
read-back, so the hidden value is gone after saving. The server still accepts the key if it is
sent, because it is a valid key.

This also applies to the existing `same_day_length` follow-up: unticking same-day crowns now
drops `same_day_length` from the save. That is the rule as specified ("a question whose show_if
is false"), and no existing test pinned the old behavior.

The six questions render in their source sections with the existing controls:

- **Technology:** `surgical_guides`
- **Comfort:** `sedation_kids`, `parent_in_room`, `new_patient_welcome`
- **Services:** `immediate_implants`, `sleep_test`

There was no layout work. The `laser` help text arrives through the catalog.

## Tests

### New tests

`tcEmailLibrary.test.js` (service level):

- All four golden cases reproduce. No `[[` slot, no `{` or `}` outside a `{{merge}}` token,
  no `review_referral` stage, no `{{review_link}}`.
- Source shape for 1.3.0: the counts, the new globals, and the 17 FAQ rules described above.
- Parent-audience emails (sealants, pediatric_restorative, space_maintainer, frenectomy,
  early_ortho), composed with `sedation=[nitrous,oral,iv]` and `sedation_kids=[nitrous]`, never
  contain "oral sedation" or "IV sedation". An adult email does.
- With `insurance_mode=no_insurance`, no FAQ email contains "check your benefits" or
  "maximize your insurance". Control: the standard wording does contain them (8 hits).
- `parent_in_room=child_first`: `pediatric_restorative.faq.B` contains "come get you". Control:
  it does not without the answer.
- `sleep_test=home_test`: `sleep_appliance.faq.B` contains "home sleep test".
- Validator refusals: `parent_in_room="maybe"`, `sleep_test="lab"`, `sedation_kids=["spa"]`,
  `new_patient_welcome=["pony"]`, `surgical_guides="yes"`, `immediate_implants=1`. Also checks
  dedupe and order, and that the office fields are still refused.

`tcEmailLibrary.route.test.js` (real assembled route):

- PUT `/profile` with all six new keys round-trips through PUT and GET.
- GET `/catalog` lists 25 questions (27 minus `office_name` and `office_phone`) and carries
  `show_if`.
- A refused PUT saves nothing, and no `tc_messages` row is written.

`admin-patient-emails.test.tsx` (page):

- The six questions render in their sections with the right controls.
- `implant_surgery=in_house` follows the default. Choosing "specialist" hides both follow-ups,
  and the preview and Save are sent without `surgical_guides` or `immediate_implants`.
- The new selects and multis send declared values in source order.

### Edited existing tests (all added by #356/#357, all v1.2.0 pins)

| File | Before | After |
| --- | --- | --- |
| `tcEmailLibrary.test.js` | `const SOURCE_SHA256 = '21a06395…d4033';` | `const SOURCE_SHA256 = 'f091ef38…63cd8';` |
| `tcEmailLibrary.route.test.js` (P test) | `assert.equal(put.body.libraryVersion, '1.2.0');` | `… '1.3.0');` |
| `tcEmailLibrary.route.test.js` (C test) | `assert.equal(before.body.libraryVersion, '1.2.0');` | `… '1.3.0');` |
| `tcEmailLibrary.route.test.js` (C test) | `assert.equal(ids.length, 19, 'the source has 21 questions; two are the office fields');` | `assert.equal(ids.length, 25, 'the source has 27 questions; two are the office fields');` |
| `tc-email-library-shots.test.tsx` (skipped unless `TC_SHOTS=1`) | profile mock `libraryVersion: "1.2.0"`; `ANSWERS` without new keys | `libraryVersion: "1.3.0"`; `ANSWERS` adds `sedation_kids: ["nitrous"]`, `parent_in_room: "child_first"` |

No other existing test was edited, and no other existing test failed.

### Suite results

| Gate | Result |
| --- | --- |
| Backend `node --check server.js` | clean |
| Backend `node --test` | 5171 tests: **5168 pass, 0 fail**, 3 skipped |
| Dashboard `pnpm run check` (`tsc --noEmit`) | clean |
| Dashboard `pnpm run test` | 276 files (235 passed, 41 skipped); 3654 tests: **3398 pass, 0 fail**, 256 skipped |

The Node-22 deserialize flake did not appear.

### Screenshots

`docs/screenshots/tc/tcemlib-01-admin-preview` and `tcemlib-02-read-only`, light and dark, at
1280×1400. Real 1.3.0 catalog and wording. The new Technology and Comfort questions are visible.
Services falls below the 1400 px crop, as it did before.

One known artifact: in the shots the `parent_in_room` select reads "Not set" although the
fixture answers `child_first`. The jsdom → HTML dump does not carry a controlled `<select>`'s
value, because React sets it as a property, not an attribute. The page itself is correct; the
page test asserts the sent value.

## Not changed, deliberately

`LIBRARY_CLINICALLY_APPROVED` stays `false`, so the draft banner still shows. The source's own
`status` still reads "DRAFT - clinical copy requires doctor review before any send", and the
brief did not ask for the flip. If 1.3.0 is the approved copy, flipping it is a one-line PR.

## Staging test plan (5 steps)

1. On staging, sign in as a practice admin and open `/admin/patient-emails` for Roland. The
   header data should read library 1.3.0. Technology shows "surgical guides", Comfort shows
   children's sedation, parent in room and new-patient first visit, and Services shows same-day
   implants and sleep test.
2. Leave "Who places implants?" on the library default. Both implant follow-ups show. Switch it
   to "A specialist": both disappear. Save, reload, and confirm the saved answers do not contain
   `surgical_guides` or `immediate_implants`.
3. Tick oral and IV sedation for adults and laughing gas only for children. Preview
   *Sealants → FAQ* (and *Pediatric Restorative → Fearful patient*): no "oral sedation" or
   "IV sedation". Preview *Crown → Fearful patient*: both appear.
4. Set "Can a parent stay in the room?" to "Child first". Preview *Pediatric Restorative → FAQ →
   Short and direct*: it contains "come get you". Set the sleep test to "Home sleep test".
   Preview *Sleep Appliance → FAQ → Short and direct*: it contains "home sleep test".
5. Set Paying for care to "No insurance". Spot-check several FAQ previews: no "check your
   benefits" or "maximize your insurance". Confirm the Benefits deadline stage is no longer
   offered. Finally confirm no `tc_messages` rows were created during the session.
