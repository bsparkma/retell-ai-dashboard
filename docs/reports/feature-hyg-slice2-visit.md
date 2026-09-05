# Hyg H1 Slice 2 — the visit workspace and the routing slip

Branch `feature/hyg-slice2-visit`, off `origin/develop` (`81b25d7`, which is #146
merged). The module is still DARK — no tenant is entitled and no office's pilot
switch is on — so everything here 403s until Beau flips both.

**Read this section first.** One acceptance criterion could not be met as
written, and the reason is a genuine conflict rather than a shortcut.

---

## THE ONE DEVIATION THAT MATTERS: criterion 7

> *"`hygNoOdWrites.test.js` green and byte-identical. Include the diff proving
> it is unchanged."*

**It is green. It is not byte-identical**, and it could not be. Two of its five
statements are not about Open Dental at all:

```js
// slice 1
test('no hyg source issues a POST, PUT or PATCH through any client', …)
  src.match(/\.(post|put|patch)\s*\(/)          // ← `router.post(` matches this

test('no hyg ROUTE is registered on a non-GET method', …)
  src.matchAll(/router\.(post|put|patch|delete)\s*\(/g)
```

Slice 2's whole point is mutations. Any POST route in `routes/hyg/` fails both,
and the second test's own comment says so: *"This makes slice 2's first mutation
a deliberate edit to this test."* The only ways to keep the file byte-identical
were to put the mutations outside the module or to obfuscate the route
registration — both of which are evading a guard, which is the thing the file
exists to prevent.

So I made the smallest edit that keeps every statement's teeth and sharpened
both in the direction that matters:

| Statement | Before | After |
| --- | --- | --- |
| behavioural: day route reaches no write verb | — | **byte-identical** |
| source scan for `apiWriteRaw` | — | **byte-identical** |
| write-shaped calls | matched `.post(` anywhere | captures the **receiver** and requires it to be `router`/`app`. `client.post`, `this.od.client.put`, `axios.patch` are all now NAMED; the old regex could not tell them apart |
| non-GET routes | forbade all | **one-file allow-list** (`visit.js`), the same shape slice 3 will give the OD write. A second file that learns to mutate is a red build, and the allow-list asserts the named file really does mutate so a rename cannot empty it |
| *(new)* | — | **driving the MUTATIONS to success reaches no OD write verb** — open, add item, stage, save slip, all against the throwing client |

`git diff --numstat origin/develop -- backend/routes/hyg/hygNoOdWrites.test.js`
→ `120 15`. The 15 deletions are those two regexes and their comments; the
additions are the two replacements, the new behavioural test, and a header
section explaining exactly this. The module still names `apiWriteRaw` in zero
files.

If the PM would rather this be split — the guard edit as its own PR — say so and
I will lift it out.

---

## Acceptance criteria

| # | | Evidence |
| --- | --- | --- |
| 1 | GRANT block in the same migration | `1788200000000_hyg_visit.js`, quoted below; `services/hyg/visitSchema.test.js` asserts every `createTable` is in the granted list |
| 2 | `priority`/`category` separate columns, separate CHECKs | DDL quoted below; same test file pins both, and that the two vocabularies stay disjoint case-insensitively |
| 3 | Office non-null everywhere, cross-office impossible by construction | `routes/hyg/hygVisitOffice.test.js` (4 tests) + 5 of the 20 live-Postgres checks |
| 4 | Staged-write transitions server-side; a client cannot reach `Written` | `hygVisitStage.test.js` — "a client cannot ask for a state", "a write that has left Draft/Staged is immutable" |
| 5 | Every body zod-parsed; a malformed body is a 400 naming the field | `hygVisit.test.js` — "a malformed body is a 400 that NAMES the field" |
| 6 | Send never disabled by a completeness check | `hygVisitStage.test.js` (backend) + `hyg-visit.test.tsx` (screen) + screenshot 05 |
| 7 | `hygNoOdWrites.test.js` | **see above** |
| 8 | TC and RCM untouched | diffstat below |
| 9 | `tsc --noEmit` clean, no `any`, green on 4 shards | below |

### 1 and 2 — the DDL

```js
pgm.createTable('hyg_treatment_item', {
  // ⚠️ TWO AXES, TWO COLUMNS, TWO CHECKS. ⚠️
  category: { type: 'text', notNull: true },
  priority: { type: 'text', notNull: true },
  …
});
pgm.addConstraint('hyg_treatment_item', 'hyg_treatment_item_category_check', {
  check: `category IN ('Restorative','Endo','Surgery','Perio','Prosth','Ortho','Cosmetic','Other')`,
});
pgm.addConstraint('hyg_treatment_item', 'hyg_treatment_item_priority_check', {
  check: `priority IN ('urgent','preventative','cosmetic')`,
});
```

```js
// Least-privilege app role — the audit_log / tc_schema / rcm_schema mechanism.
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
const HYG_TABLES = ['hyg_visit', 'hyg_treatment_item', 'hyg_staged_write'];
…
      FOREACH t IN ARRAY ARRAY[…] LOOP
        EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
      END LOOP;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        FOREACH t IN ARRAY ARRAY[…] LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', t, r);
        END LOOP;
```

The vocabularies are inline literals rather than imported from the contract,
because a migration is a historical record of what a database was told and one
that reads today's source silently changes meaning. `visitSchema.test.js` pays
the drift cost: it asserts each list against the zod enum.

### 8 — shared files

```
$ git diff --stat origin/develop -- backend/routes/tc backend/routes/rcm \
    backend/services/rcm backend/services/tc backend/platform \
    new-dashboard/client/src/pages/rcm new-dashboard/client/src/pages/tc
(empty)
```

`backend/platform/` is untouched, so the #145 `writeRow` precedent does not
apply. Outside `hyg`, three files move:

| File | Change |
| --- | --- |
| `client/src/lib/permissions.ts` | `ROLE_HOME.hygiene` → `/hyg/day` (step 5), +5/−1 |
| `tests/role-permissions.test.ts` | that home, and `hyg.read` added to the hygiene fixture so "every role's home is somewhere it may go" still holds |
| `scripts/shoot-hyg.mjs` | an optional `@WxH` suffix on a dump name. The WIDTH is still fixed at the device's 1180 — only the frame height varies, for shots whose subject is below the fold |

### 9 — gates

- `node --check server.js` OK
- `node scripts/shard-runner.mjs` — **4 shards green · 2300 tests · 2297 pass · 0 fail · 3 skipped** (develop: 2253)
- `pnpm run check` clean, no `any`
- `pnpm run test` — **1333 passed, 78 skipped, 0 failed** (develop: 1318)

---

## Verified against a real Postgres 16

The route tests use a statement-dispatch fake (`FakeHygDb`) that enforces the
constraints that carry meaning. A fake is a second implementation of the rules,
and its failure mode is agreeing with itself and not with Postgres — RCM learned
that twice (`rcm_office_settings` already existed; a CHECK that evaluates to
NULL is ACCEPTED). So `backend/scripts/rehearse-hyg-visit.js` runs the REAL
migration and the REAL store against a real database, **as `carein_app`**, and
tries to break each constraint on purpose:

```
PASS  connected  — as carein_app
PASS  grants: the app role can read all three hyg_* tables
PASS  re-opening an appointment finds the visit already there
PASS  the same aptNum in the other office is a different visit
PASS  a well-formed treatment item stores
PASS  a CATEGORY value in the priority column is refused  — hyg_treatment_item_priority_check
PASS  a PRIORITY value in the category column is refused  — hyg_treatment_item_category_check
PASS  a child row whose office disagrees with its parent's is refused  — hyg_treatment_item_visit_fk
PASS  an office that is not ours is refused  — hyg_visit_office_check
PASS  a valley read of the same aptNum sees valley's own empty visit
PASS  a whole-mouth item stores with no teeth
PASS  a whole-mouth item that also names teeth is refused  — hyg_treatment_item_teeth_check
PASS  a tooth-level item that names no teeth is refused  — hyg_treatment_item_teeth_check
PASS  the slip round-trips through jsonb and still parses
PASS  a router slip stages  — The slip for 2026-09-08 — 2 treatment items
PASS  re-staging replaces rather than adding a second row
PASS  a Failed staged write with no reason is refused  — hyg_staged_write_failed_reason_check
PASS  half an attribution (sent_by with no sent_at) is refused  — hyg_staged_write_sent_pair_check
PASS  a Written row cannot be re-staged
PASS  deleting a visit cascades to its items and staged writes

[rehearse-hyg-visit] 20/20 checks passed
```

Recipe is in the script's header (postgres:16 container, `carein_app` role,
`migrate.js up` + `migrate-tenant.js up --tenant carein`).

---

## Decisions the brief asked me to make and say

### One visit per appointment — `UNIQUE (office, apt_num)`, upserted

Re-opening the same appointment finds the visit already there. The alternative —
a row per open — means a hygienist who backgrounded the app mid-visit comes back
to an empty slip with her work in a sibling row nothing renders. `ON CONFLICT DO
UPDATE` rather than `DO NOTHING` so the caller gets the row back without a
second SELECT and a race between them.

### `patNum` is never in a request body

A client that could name the patient could attach a slip — and one slice later a
chart note — to somebody else. `POST /:aptNum/open` reads the appointment's own
day from Open Dental and takes the PatNum from there. No route in this module
accepts a `patNum`.

**The cost, stated honestly:** opening a visit costs the day's four list
requests (per-patient reads are answered by #145's cache, which the day view has
usually just warmed). A single-appointment read would be cheaper — `GET
/appointments/{AptNum}` is plural-with-id, the shape that works for `/patients`
— but H0 never proved it against a live database, and a guess here is a guess
about which patient a note lands on. Worth a probe in slice 3.

### A GET does not create

`GET /:aptNum` answers `visit: null` when nobody has started one. If it created
a row, glancing at a card would leave a visit behind for a patient nobody worked
on and "which visits happened today" would stop being answerable. The workspace
renders an empty slip from the contract's `emptySlip()` and calls `open` on the
first change.

### The slip is one jsonb column

Forty nullable text columns would buy nothing: every field on the slip is free
text, a chip list or a nullable enum, and nothing joins on any of them. The
shape is enforced by `HygSlipSchema` on BOTH sides of the wire. The two facts a
database must guard — priority and category — are real columns with real CHECKs
on the treatment item.

### The backend now runs zod

`backend/hyg/contract.gen.cjs` (620KB), built from `backend/hyg/contract.entry.ts`
with the pinned esbuild and the load-bearing `--alias:zod`. Drift guard:
`new-dashboard/tests/hyg-contract-bundle.test.ts`, identical in shape to TC's.
The "650KB bundle" argument was indeed a frontend number; the backend is
unbundled CommonJS on Container Apps.

---

## A live defect found and fixed

`services/hyg/odDay.js` passed **PatNum 0** — Open Dental's "this appointment
has no patient" — straight into `services/odPatientCache.js`, which throws
(`PatNum must be a positive integer`). `readDay` reported that as a failed read,
which **502'd the WHOLE day**. One blockout or unattached row would have taken a
hygienist's entire schedule down, and it only became reachable when #145 put the
cache in that path.

Fixed in two places (the fan-out filter and the appointment mapping): a PatNum
must be `> 0` to be a patient, and an appointment with 0 comes back with
`patNum: null` — an appointment with no name, which is what it is. That path is
now covered by "an appointment with no patient on it cannot become a visit".

---

## Screenshots

`docs/screenshots/hyg/hyg-visit-*` — five states, light and dark. Shot by the
EXISTING `scripts/shoot-hyg.mjs`, unchanged in width: one shooter, because a
second would eventually disagree with the first about the device.

| | Frame | |
| --- | --- | --- |
| `01-workspace` | 1180×2000 | the slip and the treatment, populated |
| `02-item-open` | 1180×2800 | one treatment item mid-edit — **"How soon?" and "What kind of work?" as two separate labelled questions** |
| `03-staged` | 1180×1500 | the tray, showing the SERVER's own preview lines |
| `04-unknowns` | 1180×820 | a patient whose flags nobody could read |
| `05-recare` | 1180×1600 | **the shot that matters**: both front-desk questions unanswered, in a muted tone, with the staged router and the Send affordance beside them |

The width is the iPad's in every shot. Three name a taller FRAME because their
subject sits below the fold — the same page, scrolled. A screenshot that does
not contain the thing it is evidence for is not evidence.

The day-view shots were re-taken because the summary strip changed (below).
`hyg-05-visit-placeholder` is replaced by `hyg-05-visit-no-office`: the
placeholder is gone, and what is worth a picture on that route now is the
refusal to guess an office.

**The screenshots caught one thing.** The tooth row wrapped mid-arch, putting
#17 under #3 — on a tooth chart the arches lining up is not cosmetic. Now one
grid column per position, scrolling sideways rather than wrapping.

---

## The two slice-1 nits

1. **"5 Unknowns" vs "6 unknown".** Two different units under one word: the tile
   counted APPOINTMENTS with at least one unknown flag, the chip counts unknown
   FLAGS on one card. Both are useful; the label was wrong. It now reads **"Cards
   with unknowns"**.
2. **Dead vertical space.** The four tall tiles became one compact row, ~70px of
   an iPad's 820 back above a grid that is already short at five appointments.

---

## What I deliberately did NOT build

- **Perio charting.** `perio` composes to nothing and staging it is an honest
  422 that says why: a stray Probing row is PERMANENT in Open Dental. H4.
- **The ortho workup** — the prototype's 1,400-line tab. Its own arc.
- **Photos.** `TreatmentItem.photos` is in the contract and always empty; an
  upload path needs a blob store, a retention answer and an audit story.
- **The prototype's pre-visit block** (insurance verified, balance to collect,
  premed taken) and its admin block (pre-auth, referral, Rx). Front-desk work;
  this screen is used at a chair. The slip here is the subset a hygienist fills
  about THIS visit — about fifteen fields, not sixty.
- **Dictation.** The prototype's mic buttons are a stub over the Web Speech API.
  PHI through a browser speech service needs its own decision.
- **A `Finish visit` action.** It set an appointment status in the prototype's
  local store. Doing it for real is an Open Dental write, which is slice 3.
