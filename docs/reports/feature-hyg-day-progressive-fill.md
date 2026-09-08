# Hyg — the day paints instantly; names fill in

Branch `feature/hyg-day-progressive-fill`, off `origin/develop` (`e16ded4`).
**Independent of #152** — no stacking, no retarget needed.

---

## The measurement

`node backend/scripts/measure-hyg-day-cost.js`, 40 distinct patients, 1000ms per
request (Open Dental's documented one-per-second-per-credential):

```
BEFORE  cold, all-at-once           44 OD requests  (4 list, 40 patient)     43.0s
AFTER   cold, SCHEDULE PAINTS        4 OD requests  (4 list, 0 patient)       3.0s
                                    45 OD requests  (5 fill batches)         45.0s  ← names, after the paint
AFTER   second load, warm cache      1 OD requests  (1 list, 0 patient)       0.0s
AFTER   first load, pre-warmed       4 OD requests  (4 list, 0 patient)       3.0s
```

**43.0s → 3.0s, and it is not a saving.** The fan-out still costs one request per
patient — the two rulings that would have made it cheaper were rejected on
9/03 and are not revisited here. What changed is that the schedule no longer
waits behind it. Row 3 is that cost, paid while she is already reading the day,
and it is **five requests LARGER** than row 1 because each batch re-reads the
schedule. That is deliberate; see "The fill takes no PatNums".

The second load falls to **one** list read: the three config lists are now cached
for an hour per office. Only `/appointments` is re-read, and it has to be — a
schedule an hour old is a schedule somebody added a patient to.

The code under measurement is the shipped code; only the network is simulated,
behind a gate that enforces the documented spacing. Same harness as #145, so the
BEFORE row is comparable to the one in `docs/HYG_MODULE.md` §7.

---

## Acceptance

| # | | Evidence |
| --- | --- | --- |
| 1 | Cold day: schedule visible in ~list-read time, harness-proven; names fill | the table above; `hygDayCache.test.js` — "THE SCHEDULE DOES NOT WAIT FOR THE NAMES" asserts **zero** patient reads on the first paint |
| 2 | A never-resolves patient leaves an honest card, not a spinner | `hyg-day-view.test.tsx` — "A PATIENT WHO NEVER RESOLVES…", "stops asking when a batch makes no progress", "A CARD THE FILL NEVER REACHES STOPS SHIMMERING" |
| 3 | Flags: unresolved shows unknown; audit only on actual disclosure | acceptance 1's test asserts `flags.premed === null` on every pending card **and** zero `hyg_day_patient` rows; `hygGuard.test.js` asserts the rows appear on the fill |
| 4 | Config lists cached 1h; `/patients` TTL untouched | `odConfigCache.test.js` — 7 tests, including "THE RESOURCE LIST IS CLOSED — /patients can never be cached for an hour" |
| 5 | Failure states name the failing read; `[hygday]` carries timings | below |

### Gates

- `node --check server.js` OK
- `node scripts/shard-runner.mjs` — **4 shards green · 2349 tests · 2346 pass · 0 fail · 3 skipped**
- `pnpm run check` clean, no `any`
- `pnpm run test` — **1371 passed, 95 skipped, 0 failed**
- `backend/hyg/contract.gen.cjs` regenerated with the pinned esbuild; its byte-compare test passes
- Screenshots: `docs/screenshots/hyg/hyg-fill-0{1,2,3}-*-1180x820-{light,dark}.png`

TC, RCM and `backend/platform/` untouched. No migration. No OD write path; the
hyg write-guard test is unchanged.

---

## 1 — Progressive fill

`GET /api/hyg/day` resolves identities **from the patient cache only** and issues
no `GET /patients/{PatNum}` at all. Whatever it could not name comes back
`identity: "pending"`, with `identitiesPending` saying how many. The client then
loops `GET /api/hyg/day/identities`, merging each batch onto the cards on screen.

### The mechanism, and why this one

A poll of the day endpoint would have re-sent the whole schedule every few
seconds and given the client no way to know whether progress was being made. A
follow-up fetch that resolved everything at once would have been the same
40-second wait with a schedule drawn behind it. **A bounded batch is the only
shape where the screen changes visibly and the loop has an obvious end.**

Batch size is 8 (`HYG_DAY_IDENTITY_BATCH`): about nine seconds of wall clock per
wave, so a 40-patient day is five round trips rather than forty, and names arrive
in groups rather than a trickle. It is not a throughput lever — the credential is
the throughput, and it is shared.

### ⚠️ The fill takes no PatNums

This is the part worth reviewing hardest. `GET /day/identities` derives the set
of patients from **that day's own schedule**, server-side. A route that accepted
a list would be a name-and-medical-alert lookup for any patient number in the
practice, walkable one integer at a time — a far larger disclosure surface than
"who is booked today", and one no amount of auditing makes acceptable.

`hygDayCache.test.js` — "the fill takes no PatNums — the set comes from the day"
— asks for a synthetic patient who is not booked, by three different query-param
spellings, and asserts the record is never read and never audited.

The cost is one extra `/appointments` read per batch. It also buys freshness: a
patient added mid-fill is picked up rather than missed until a refresh.

`scope` is validated on the fill exactly as on the day, and the fill honours it —
a fill under a wider lens would name patients the day never served, which is #149
given back plus an audit row for a disclosure that never reached a screen.

### Honest states, four of them

`identity` is `resolved | pending | unavailable | no_patient`. One nullable name
cannot carry four facts, and drawing them the same way would have a hygienist
waiting on a card that is finished or giving up on one that is still coming.

`no_patient` is new information the old code discarded: an appointment with no
PatNum is a blockout, not a failed read, and it now says so.

**The loop stops, three ways.** It runs while `pending` is FALLING; a batch that
does not move it will not move it next time either. A patient Open Dental refuses
comes back in `unavailable`, never in `pending`. And when the loop stops for any
reason — including a failure — the page settles every remaining `pending` card to
`unavailable`. **A shimmer with no request behind it claims something untrue**,
which is the same failure as an empty day wearing a different hat.

### Audit follows the disclosure

`GET /day` audits only appointments whose identity it actually carries. A pending
card carries a PatNum, a time and a chair and **no name and no flags** — nothing
about that person has been disclosed. The fill writes the row at the moment it
sends the name.

This is the same rule the patient cache follows from the other side (a cache HIT
still discloses, so it still audits), and `hygDayCache.test.js` pins both halves
in one test as it always did.

One consequence worth naming: `patientsRequested = hits + deduped + reads` no
longer holds — the fourth term, still-unasked, used to be zero. The invariant is
now `= hits + deduped + reads + identitiesPending`, and the test says so.

---

## 2 — Hour-long TTLs on the config lists

`backend/services/odConfigCache.js`, new. `/appointmenttypes`, `/providers`,
`/operatories`, keyed by **office + resource**, one hour, the `commlogTypes`
precedent.

Two guards, and both are load-bearing:

- **The office half of the key is not optional.** Operatory 4 is a different room
  in each practice and ProvNum 7 is a different person — the quieter sibling of
  the cross-office PHI bug `odPatientCache` guards against. `cacheKey()` throws
  on an office that is not in the Open Dental registry rather than defaulting one.
- **The resource list is closed.** Three names, and `getList('roland',
  'patients', …)` throws. `/patients` stays at five minutes because that TTL is a
  clinical bound, and a closed list is how "config ages slowly, clinical facts do
  not" becomes a property of the code rather than a comment somebody has to
  notice.

**A failed or truncated read is never stored.** A partial list is the right thing
to render — three quarters of the chairs beats an outage — and the wrong thing to
keep, because it would turn one bad minute into an hour of missing chair names
with nothing on screen saying so after the first request.

The tests needed a `resetOdConfigCache()` in two `beforeEach` hooks. Without it,
one test's chairs were served to the next — which is the shape of a cross-office
leak, caught here as a cross-test one.

---

## 3 — Failure visibility

**"Fails at times" is now something to act on.**

- `warnings[]` gained `detail`: Open Dental's own status or timeout under the
  sentence a hygienist reads. One tells her what she is missing; the other is
  what she reads out when she calls somebody. Both are on screen —
  `hyg-fill-03-failed` shows `Chair names are unavailable. HTTP 504`.
- The day's 502 carries `phase` and `detail`, and logs
  `[hygday] … FAILED phase=appointments detail="…"`.
- `[hygday]` gained `ms_appointments= ms_operatories= ms_labels= ms_identities=`,
  plus `pending=` and `warn=`. Flat `key=value`, because a nested object in a log
  line is a thing nobody can filter on. `stats.phaseMs` carries the same numbers
  in the body.
- `[hygfill]` is the fill's own line: `named= unavailable= pending= od_list=
  od_patient= cache_hit= ms=`.

**Retry on the failed phase only.** A failed fill gets its own banner with "Try
the names again", which re-runs the fill and **never** refetches the schedule —
refetching the day to recover the names would throw away a schedule that loaded
perfectly well, and on a slow morning that is the thing she is actually reading.

The banner is amber-with-a-border rather than red: red on this page means "the
schedule did not load", and it did. The first screenshot had it in the same tone
as the notices above it and the two read as one long amber block; it is
deliberately heavier now.

The config-list warnings have no retry of their own, and that is a limit rather
than a decision I am pleased with: they are part of the day fetch, so the only
way to retry them is Refresh. With the hour-long TTL that is now cheap, but it is
the one phase where "retry the failed phase only" is Refresh.

---

## Beyond the brief: opening a visit

`routes/hyg/visit.js` read the whole day — **including every patient on it** — to
find one appointment. Opening one visit on a cold cache paid the entire 40-second
fan-out to learn one name.

It now reads the day with cached identities and resolves **the one patient this
page is about**. Same name on screen, one request instead of forty.

I flag it because it is outside the brief's four deliverables. It is two lines,
it is the same lever, and "the patients page is slow and fails at times" is
plausibly this as much as the day view — but say the word and I will split it.

---

## What is still open

1. **Nothing is measured on staging.** The module is dark everywhere: `/api/hyg`
   is behind `requireModule('hyg')` with no tenant entitled, and every office's
   `hygOdEnabled` is false. A staging before/after needs this branch deployed AND
   both switches flipped — the same constraint #145's report records.
2. **The fill's extra `/appointments` read per batch is a real cost** — five
   requests on a 40-patient day. It is the price of the client not naming
   patients, and I think it is obviously worth paying, but it is a number and the
   PM should see it rather than find it.
3. **The batch size is a guess with a rationale, not a measurement.** Eight feels
   right at 1 req/s; the first real day at a chair is what should settle it, and
   `HYG_DAY_IDENTITY_BATCH` moves it without a deploy.
4. **A card that settles to `unavailable` has no per-card retry.** "Try the names
   again" re-runs the whole fill, which is correct and slightly blunt. A
   per-card retry would need the fill to accept a PatNum, which is exactly what it
   must not do — so if this matters, the answer is a scoped "retry the unnamed
   ones", not a lookup.
