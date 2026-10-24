# Pre-auth "Linked case ID" must be this office's case — NEEDS REVIEW (RED)

**Branch:** `fix/preauth-case-link-office`, cut from `origin/develop` at `2b166f3` (after #267).
**Pushed for review. Not merged.** There's no migration and no contract change.

## The bug

`tc_preauth_cases.case_id` has a foreign key to `tc_cases(case_id)` alone, not to
`(office_id, case_id)`. Both `POST /api/tc/preauth` and `PUT /api/tc/preauth/:id` wrote a
client-typed `caseId` without checking which office the case belongs to. The result was that a
pre-auth could be hand-linked to the other office's case.

## The fix

- **What's checked.** When create or PUT carries a `caseId`, the server checks it with
  `preauthStore.caseInOffice` (`WHERE office_id = $1 AND case_id = $2`), using the office from
  `?office=` as the route already does.
- **When it runs.** The check runs in the same transaction as the write, before it.
- **How a bad id is refused.** Another office's case and an unknown id both get the same response:
  `404 { success: false, error: 'Case not found', code: 'NOT_FOUND' }`. That is word for word what the
  referral routes return, so the response says nothing about the other office. Nothing is saved and
  no audit row is written.
- **Clearing a link.** `caseId: null` on PUT still clears the link, with no lookup needed. A PUT
  without `caseId` doesn't touch `tc_cases` at all.
- **Start case** (#267) was already office-scoped and is unchanged.

The schema-level fix (a composite FK) is a migration, and this task said none was expected, so I've
left it as a possible follow-up.

## Existing cross-office rows: count NOT yet measured

`preauthStore.countCrossOfficeCaseLinks` runs one read-only `SELECT … JOIN` and returns counts per
(pre-auth office → case office) pair. It returns counts only: no ids, no names.
`scripts/tc-preauth-cross-office-links.js` runs it inside a `BEGIN READ ONLY` transaction that is
always rolled back:

    MIGRATE_TENANT_DB_URL=postgres://... node scripts/tc-preauth-cross-office-links.js

I haven't run it against staging or prod data. I had no tenant DB connection from this session.
**No data was modified.** If the count is non-zero, the cleanup (null the bad links, or relink them)
needs a separate, reviewed step.

## Tests

- **Existing tests.** None needed editing: no test pinned the old lax behavior.
- **New: `routes/tc/tcPreauthCaseLink.test.js` (5 tests).**
  - Linking to a case in the same office works, on both create and PUT.
  - Linking to another office's case, or to an unknown id, returns the identical 404, saves nothing,
    and writes no audit row (on both create and PUT).
  - `null` clears the link.
  - A PUT that doesn't set a case never looks one up.
  - The count query is read-only.
- **Backend `node --test`:** 4103 tests, 4100 pass, 0 fail (the other 3 are skipped).
- **Dashboard `pnpm run check`:** clean. There are no TypeScript changes.
