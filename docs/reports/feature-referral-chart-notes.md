# R6.10: Referral chart notes

**Branch:** `feature/referral-chart-notes` (off `origin/develop` dd0e408) · **Lane:** RED, NEEDS REVIEW, not merged

Staff can write a referral milestone to the patient's Open Dental chart as a commlog. A person has to press "Write to chart" on text they can see; nothing writes by itself.

**No real chart has been written.** Every Open Dental call in the tests is faked, inside the test process. The staging walk has not run. When it does, it uses **only** the two test patients: Roland PatNum **12827** ("Test 2, Stedi") and Valley/Riley PatNum **7115** ("Stedi TestValley").

## What changed

1. **The drafted notes.** On the hub's referral detail, tc.full staff see a **Chart note** section, one row per milestone the referral has reached.

   | Milestone | Draft |
   |---|---|
   | Sent | "Referral sent to Dr. X at Practice for possible cracked tooth." |
   | Specialist confirmed receipt | "Dr. X at Practice confirmed receipt of the referral for …" |
   | Patient scheduled | "Patient scheduled with Dr. X at Practice on Tue, Nov 3, 2026." (or "(no date given)") |
   | Patient seen | "Patient seen by Dr. X at Practice for …" |
   | Declined | "Referral to … declined by the doctor: <the doctor's reason>." |
   | Closed | "Referral to … closed: <the note given>." |

   - "Review note" opens the draft for editing.
   - **The final text sits immediately above "Write to chart"**, and it is exactly what is sent and stored.
   - A written milestone shows when, by whom, the Open Dental note number and the words. It has no button.
   - The drafts and the reached/written rule are one pure function in the shared contract. The client draws from it, and the server refuses by it.
   - The specialist's name comes from the directory entry. It is new on the detail read, as the optional `specialistName`.

2. **The write.** `POST /api/tc/referrals/:id/chart-notes { milestone, note }`, with a strict body.
   - **The writer is the voice module's own `openDentalSync.createCommLog`**, the same function every call note goes through. There is no second writer.
   - The server takes these from the referral, never from the request:
     - **PatNum** from the referral row;
     - **office** from the request's server-derived office, with the row read in that office only;
     - **commlog type** from the office's new configuration;
     - **date** from the milestone's own history row.
   - The order, where the first refusal stops everything:
     1. The environment's `OPENDENTAL_WRITE_DISABLED` → 403.
     2. The office's Open Dental readiness and its configured type → a named 409 or 503.
     3. The note must already be OD-safe → otherwise 400 `CHART_NOTE_NOT_OD_SAFE`.
     4. In one tenant transaction, holding the referral's row lock:
        - the milestone must be reached and not yet written;
        - the configured type must be in **this office's own** commlog-type list (`commlogTypes.assertAllowed`).
     5. The Open Dental half (`services/tc/referralChartNote.js`):
        - read the patient's commlogs, and refuse if this exact note is already there;
        - `createCommLog` (type, `SentOrReceived: "Neither"`, `Mode_: "None"`, date as the office's wall clock);
        - **read back**, and the row Open Dental minted must match on PatNum, type and text.
     6. Only then: the `chart_note_written` history row and the audit row (`CREATE commlog`, resource = CommlogNum).
   - **Configuration** (`config/odOffices.js`) uses the same mechanism as the call-note DefNums: an env override, otherwise a verified per-practice default.
     - Roland: `OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM`, default **491**.
     - Valley: `OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM_VALLEY`, default **452**.
     - Both numbers were read live from each practice's own definitions on 2026-10-28.
     - An office with neither gets `null`. Its button is disabled with the named reason `REFERRAL_COMMTYPE_NOT_CONFIGURED`. It never falls back to the call-note type.
     - A test pins that no DefNum appears in the route or service code.

3. **The record.** Migration **1793200000000** (above develop's newest, 1793100000000).
   - The verb CHECK gains `chart_note_written`, pinned equal to the contract.
   - Three columns: the milestone, the CommlogNum and the type.
   - CHECKs:
     - the milestone vocabulary, pinned to the contract;
     - all three facts on a chart-note row and **none** on any other;
     - from = to;
     - a note of 1–2000 characters;
     - positive ids.
   - A **unique index**: one chart note per milestone per referral, whatever the route does.
   - `down()` clears the three facts in the same UPDATE that unlabels the rows (1793100000000's lesson). The commlog stays in Open Dental, and the audit row still names it.
   - **Every reader of the verb was checked:**
     - the timeline label (the typecheck requires it): "Chart note written: Referral sent (Open Dental note 50001)";
     - `NON_MOVE_VERBS` gains it, so a note never hides a doctor's return or clears a failed send.
     - The unsubscribe lookup, `referralResponses`, the badges and the send path key on other verbs, so none of them needed an edit. `referralSend.js` is untouched.

**Guardrails held:**
- No automatic write.
- The writer is the existing one.
- DefNums come from per-office config and never cross (both offices are pinned).
- The office and PatNum are server-derived, and the body is strict (20 smuggled or invalid shapes get a 400).
- No transition or state-machine change.
- TypeScript is strict and the typecheck is clean.

## Decisions and findings for you

1. **The voice path does not read back from Open Dental.** The brief asked for "the same honest read-back-after-write". The voice send claims success when the POST succeeds, and it reports the `CommlogNum` from the response without checking it is there.
   - This slice reads the commlog back from Open Dental (`GET /commlogs?PatNum=`, paged) and matches PatNum, type and text before claiming anything. That is stricter than voice, in the hygiene module's style.
   - Retrofitting voice is a separate decision.
2. **The shared writer gained one optional argument.** `createCommLog(..., { sentOrReceived })` and `buildCommLogApiPayload(..., sentOrReceived)`.
   - It is omitted, or any value outside Open Dental's three, it writes `"Received"` exactly as before. A test pins the voice payload unchanged.
   - The referral note passes `"Neither"`. A milestone note is neither sent nor received, and `"Received"` would mislabel "Referral sent to …".
3. **Pre-existing gap (not fixed): the voice send ignores `OPENDENTAL_WRITE_DISABLED`.** `createCommLog` posts through the raw axios client, and that switch is enforced only in `apiWriteRaw` and in route middleware. `/api/unified-calls/:id/resolve-patient` mounts neither. This route checks the switch itself.
4. **Possible voice dating issue (not verified, not changed).** `formatODDateTime` keeps an ISO string's clock digits verbatim, and Open Dental reads them as practice-local time.
   - So a UTC timestamp dates the note 5–6 hours off.
   - This slice converts the milestone time to the office's wall clock (`OFFICE_TIMEZONE`) first.
   - The voice path passes `call.call_date` straight through. If that is a UTC ISO string, voice notes are dated in UTC. Worth a look.
5. **Duplicate guard before writing.** The same paged read refuses with 409 `CHART_NOTE_ALREADY_IN_CHART` when a note with this type and this exact text is already on the chart.
   - That is what stops a second note after a write that landed but could not be confirmed or recorded. Both cases are tested.
   - The cost is one more paged read per write. A refused milestone stays "not written" in the UI, and the message says the note is already on the chart.
6. **The row lock is held across the Open Dental call** (two reads and one POST). Two clicks cannot both write; the second sees the first one's row and is refused. Other actions on that one referral wait those few seconds.
7. **Open Dental's commlog paging is assumed, not proven live.** The read pages by `Offset` at 100. It also stops when a page is short or adds nothing new, so a build that ignores `Offset` still ends cleanly. The staging walk should confirm it.
8. **Milestone scope:**
   - "Declined" is the doctor's decline at sign-off.
   - "Cancelled" is not a milestone, since the brief did not list it.
   - "Scheduled" uses the latest date given (`scheduledDate`).
   - A milestone counts once, ever, for a referral.
9. **Finding in R6.9 (not fixed):** `tc_referral_events_correspondence_fields_check` has the `(verb = x) = (all three set)` shape. That lets a non-correspondence row carry one or two of the correspondence facts. The Postgres rehearsal caught the same shape here, and this migration uses the strict form. R6.9's needs its own small migration if you want it closed.

## Pre-existing test edits (for ratification)

| File | Edit |
|---|---|
| `backend/routes/tc/tcReferralSend.test.js` | The full event-verb list gains `'chart_note_written'` at the end, the pre-ratified shape. |
| `backend/routes/tc/tcReferralCorrespondence.test.js` (V) | "`correspondence` is last" now reads R6.9's frozen list (`TC_REFERRAL_R69_EVENT_VERBS`) instead of the live one, because `chart_note_written` now follows it. |
| `backend/test/referralCorrespondenceMigration.test.js` | 1793100000000's CHECK is pinned to the frozen `TC_REFERRAL_R69_EVENT_VERBS` instead of the live list. This is the same pattern R6.9 used for R5b. The live list is now pinned by 1793200000000's test. |

Also a comment-only edit in `1793100000000_tc_referral_correspondence.js`'s header, so it names the frozen list it actually holds. No dashboard test was edited.

## Tests

- **Backend `tcReferralChartNotes.test.js` (28)**, with Open Dental faked per office (each office's own client, every call recorded with its office):
  - **Verb:** the verb is a non-move; the send path doesn't mention it.
  - **Config:** 491 and 452, never crossed; one office's override doesn't reach the other; a junk override falls back; no config gives `null` with a named reason; no DefNum in the code.
  - **The writes:**
    - Roland: the exact POST body is `{PatNum: 12827, CommType: 491, SentOrReceived: "Neither", Mode_: "None", CommDateTime: "2026-10-27 10:00:00"}`, it goes through `createCommLog`, it is read before and after, and the event and audit are written.
    - Valley: 7115 with 452, on valley's client only.
    - The detail read touches no Open Dental.
  - **Disabled:** no type, the write switch, or a crossed type (Roland set to 452) — each refused by name, nothing posted.
  - **Strict body:** 20 shapes get a 400; an OD-unsafe note gets a 400.
  - **Milestones:** not reached gets a 409; a second write gets a 409 before any Open Dental call; all six are reachable and dated from their own rows.
  - **Failures:** each claims nothing and writes no event:
    - Open Dental refuses (audited as ERROR);
    - a 201 with no CommlogNum, where the retry then finds the note and refuses;
    - a read-back with different text or type;
    - the note already on the chart;
    - the chart unreadable;
    - written but not recorded, which gives a 500 that says so, rolls back, and refuses a retry with no second POST;
    - a direct-DB client.
  - **No automatic writes:**
    - A static scan of the whole backend: only `routes/tc/referrals.js` requires the route module, only the route module requires the Open Dental half, the call is inside the `POST /:id/chart-notes` handler, neither file has timers or listeners, and the service holds no transport. The only files that name `createCommLog` are the voice module, its legacy webhook and this service.
    - Behavioural: every referral move, sign-off, mark, close, cancel, decline, the correspondence log, the detail read and the hub — zero commlog writes, zero chart reads.
  - **Role and office:** a doctor is refused at the mount; another office's referral is a 404.
  - **Sanitizer:** the shared OD-safe text equals `sanitizeForOd` character for character.
- **Backend `referralChartNoteMigration.test.js` (9):** CHECK equals the contract, the columns, the vocabulary, the four CHECKs, the unique index, nothing else touched, the down order and restore, the numbering, and the schema replay.
- **Dashboard `referrals-chart-notes.test.tsx` (17):**
  - milestone derivation, including pre-R6 rows;
  - drafts, OD-safe text, non-move, the strict request, the timeline label;
  - who sees the section (not through sign-off, not for a doctor, not on a draft);
  - the disabled reason, and fail-closed when the read is silent;
  - the written row;
  - the final text above the button being exactly what is sent;
  - a refusal shown with nothing claimed;
  - **no write without the click**, including a re-read with a newly reached milestone.

## Postgres 16 rehearsal (throwaway container, removed afterwards)

1. **Up:** the full tenant set ran clean through 1793200000000. The app role (`carein_app`) was created first, as the RCM migrations need it.
2. **Seed:** one `chart_note_written` row on a synthetic referral for 12827.
3. **Every bad row was refused:**

   | Row | Refused by |
   |---|---|
   | same milestone twice | the unique index |
   | a move dressed as a chart note | the status CHECK |
   | one fact on an edit row | the fields CHECK (the first version let this through; fixed) |
   | a chart note missing its type | the fields CHECK |
   | an unknown milestone | the vocabulary CHECK |
   | a blank note | the note CHECK |

   An ordinary edit row still goes in.
4. **Down:** the chart-note row stayed in the history, unlabelled, with its note and from = to. The columns and the index are gone, and the last migration is back to 1793100000000.
5. **Up again:** clean, and a new chart-note row goes in.

## Gates (local, Node 22, pnpm 10.4.1, `--frozen-lockfile`)

- `pnpm run check`: clean.
- `pnpm run test`: 194 files passed, 39 skipped, 0 failed, including the contract byte-compare.
- `node --check server.js`: OK.
- `node --test`: 4322 tests, 4319 pass, 0 fail, 3 skipped.
  - That full run started before the fields-CHECK tightening above. The migration's test was re-run on the final file and passes 9/9.

No screenshots.

## Staging walk (not yet run)

Once this is on staging:
1. Use **only** Roland 12827 and Valley 7115.
2. Walk one referral per office to `sent`.
3. Write the "sent" note. Confirm in each practice's Open Dental that the commlog is on that patient with type "Referral" (491 at Roland, 452 at Riley), the exact text, and "Neither".
4. Try the same milestone again; it should be refused.
5. Confirm the commlog paging assumption (item 7) on a patient with more than 100 commlogs if one exists among the fixtures. Otherwise note that it is unproven.
