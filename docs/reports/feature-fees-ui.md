# Fee Schedule module — Slice 2: the UI

**Branch** `feature/fees-ui` (off `origin/develop`, which carries merged PR #192) ·
**Worktree** `C:\Users\beau\carein-wt\fees-ui` · **Backend changes: none.**

Slice 1 gave the module three endpoints and no way to reach them. Slice 2 is the
two screens: the import list with its upload, and the preview behind each
import. Nothing was added to the backend, and nothing here touches Open Dental —
`backend/routes/fees/feesNoOdAccess.test.js` is untouched and still passes 5/5.

---

## 1. What shipped

| Piece | Path |
| --- | --- |
| Module registry entry | `client/src/lib/modules.ts` (`fees`, "Fee Schedules", `/fees`) |
| Route gating | `client/src/lib/permissions.ts` (`"/fees": "fees.read"`) |
| Routes | `client/src/App.tsx` |
| API client | `client/src/features/fees/api.ts` |
| Pages | `client/src/pages/fees/{FeesImports,FeesImportDetail}.tsx` |
| Tests | `tests/fees-registry.test.ts` (22), `tests/fees-pages.test.tsx` (18) |

`ACTIONS` was **not** touched — it already carried `fees.read`/`fees.write` from
the PR #192 follow-up. No existing test was modified. No file under `backend/`
was modified (`git status -- backend/` is empty).

The Home tile and the module switcher entry both come from the registry, so
nothing was added to `Home.tsx`. `MODULE_IDS` gained `fees` alongside the
`MODULES` entry, because that array is the client mirror of the `tenant_module`
CHECK vocabulary and `isModuleId` reads from it — an entry in `MODULES` without
one in `MODULE_IDS` would not type.

---

## 2. The screens

### `/fees` — imports

Upload (drag-drop **and** file picker, `.pdf`/`.csv`, 10MB named up front) above
this office's imports, newest first: filename, uploaded-at, uploader, source
type, row count, a warning-count badge, and a failed badge.

**The failure reason is on the row itself**, not one click away. A "Failed"
badge whose *why* is hidden is a badge people learn to ignore.

Refusals render the server's own sentence **and** its code, verbatim — 413, 415,
422, 400 all go through the same path. The one distinction the page draws is
between refusals that stored something and refusals that did not:

- **422** — a real parse failure. The server stored a `failed` batch, returns it
  on the refusal, and the page shows it with a link. *"I uploaded it and nothing
  happened"* must not be the outcome.
- **415** — no lane for that file type, so nothing was stored. The page says so
  **without** claiming a record was kept; implying one is the same dishonesty in
  the other direction, and `fees-pages.test.tsx` asserts the stored-batch card is
  absent.

### `/fees/imports/:batchId` — the preview

Rows in file order: code, fee as dollars, warnings. Plus the four things the
prompt called for, each of which exists because the reference importer got it
wrong silently:

1. **Warned rows are visually distinct and show their `raw_line`.** The line is
   the only thing that lets a reader judge whether the parser's interpretation
   was right — a multi-column row is flagged *and* printed, so `1,150.00 920.00
   805.00` is visible and the reader can see which column was taken. An unwarned
   row shows no raw line, so the flagged ones stand out.
2. **`$0.00` renders as `$0.00`.** Never blank, never an em dash. Zero means
   *not covered* / *bundled* / *no fee*; the reference discarded every one with a
   `> 0` guard, and drawing it as an empty cell would put that defect back one
   layer up.
3. **Duplicate codes are grouped**, both fees side by side, with a conflicting
   group drawn distinctly from a merely-repeated one — a code listed twice at two
   fees is a decision somebody has to make; twice at the same fee is only untidy.
4. **File-level warnings render at the top**, above the rows. They describe
   something *absent* from the table ("line 3 named three codes, so no fees were
   read from it"), and filing an absence among presences is how it gets missed.

And the banner: **"Preview only — nothing has been sent to Open Dental."** True
today, and true until the posting slice. It is written up in the page header as
load-bearing: the reader who has learned to trust it is exactly who would be
misled if it were left behind when posting lands.

---

## 3. Office handling

Office comes from the global `OfficeContext`, like every other page. The two
halves of the list screen want different things from it:

**The list fans out.** Under "All offices" it fetches both and labels every row.
The rows are merged and re-sorted newest-first *across* offices — concatenating
two per-office sorted runs reads as unsorted.

**The upload does not.** It always requires a concrete office. Roland and Riley
hold different contracts with the same payers, so a schedule filed against the
wrong one would eventually reprice a practice against terms it never agreed to.
Under "All" the upload control asks the user to pick one and stays **disabled**
until they do. The picked office is deliberately *not* written back to the global
selection: choosing a target for one upload is not the same act as re-scoping the
whole app.

This is the affordance, not the guard — the server takes `?office=` and validates
it, and refuses `unknown` and everything else.

The **detail** page under "All offices" tries both offices for the batch id. That
cannot leak anything: the endpoint scopes by office in the `WHERE`, so the wrong
office returns 404 and nothing else. It is what makes a link pasted out of a
merged list still open. A non-404 (a 403, a network failure) stops the loop
rather than producing the same refusal twice.

---

## 4. Tests

```
pnpm run check   → clean (tsc --noEmit, strict, no `any`)
pnpm run test    → 133 files, 1858 passed, 125 skipped, 0 failed
```

40 new tests across two files:

| File | Tests | Covers |
| --- | --- | --- |
| `tests/fees-registry.test.ts` | 22 | `requiredActionFor("/fees")` and the detail path's inheritance, `canVisit`, the modules-registry entry, and the pure helpers — `formatFeeCents` (including `$0.00`), `groupRowsByCode` (conflicting vs merely repeated), office keys, `sourceTypeFromFilename` |
| `tests/fees-pages.test.tsx` | 18 | both pages against a mocked API: warned row shows its raw line, `$0.00` renders, duplicates grouped with both fees, file-level warnings at the top, the banner, failed batch shows its reason, upload disabled under "All", upload targets the selected office, 422 shows the stored batch, 415 does **not**, 413 verbatim, list fan-out and labelling, empty-vs-error |

**The two star assertions were negative-tested.** I broke the raw-line render and
removed the `targetOffice === null` term from `uploadDisabled`, confirmed exactly
those two tests went red, and restored. They fail when the behaviour is removed
rather than passing vacuously.

Backend, unchanged and re-run to confirm: `node --test routes/fees/feesNoOdAccess.test.js` → 5/5.

---

## 5. Notes for you

1. **No backend change was needed.** Every shape the UI renders was already in
   slice 1's responses, including the stored batch on a 422 refusal and
   `raw_line` on each row. I did not have to stop and ask.

2. **`fees` was added to `MODULE_IDS`, not just `MODULES`.** The prompt said to
   follow the existing entries; the existing entries live in both, because
   `MODULE_IDS` is the client mirror of the DB CHECK vocabulary and `ModuleDef.id`
   is typed from it. `tests/modules.test.ts` derives its assertions from
   `MODULE_IDS` rather than restating the list, so it did not need editing.

3. **The upload has no client-side size check.** The 10MB ceiling is stated in
   the hint text, but enforcement is left entirely to the server's 413, whose
   message the page renders verbatim. A second copy of the number in the client
   is a second thing to drift; the round trip on an oversized file is cheap and
   the refusal is honest. The extension check *is* done client-side, because it
   saves a round trip and says the same words the server's 415 does.

4. **The module still ships dark for anyone not entitled.** The registry entry
   only decides what the SPA *can* render; `requireModule('fees')` remains the
   source of truth, and a 403 renders as the server's own `MODULE_NOT_ENTITLED`
   in the list's error state rather than as an empty list.

5. **Posting is still the next slice.** When it lands, the preview banner is the
   first thing that must change, and the `fees.write` story gets a second half:
   today the only thing that action guards is the upload.
