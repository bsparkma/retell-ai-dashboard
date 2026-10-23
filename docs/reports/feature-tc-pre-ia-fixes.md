# Pre-IA fixes F1–F5 and F8 — NEEDS REVIEW

**Branch:** `feature/tc-pre-ia-fixes`, cut from `origin/develop` at `1bde6a5` (after #260).
**Lane:** RED. Pushed for review. Not merged.
**Source:** `docs/reports/feature-tc-incoming-work-ia.md` §4 (findings) and §7 (fixes).
**Scope:** F1, F2, F3, F4 (ratified by Beau), F5 and F8. **Not** F6 or F7.

**Guardrails held:**
- no new permissions or roles;
- no migration;
- no Open Dental reads or writes;
- no send paths;
- TypeScript strict, `tsc --noEmit` clean;
- fixtures are the synthetic test patients only.

One commit per fix:

| Commit | Fix |
|---|---|
| `cd6f3b1` | F1: assign an unowned case to whoever answers its checkout |
| `2bb55ee` | F2: hide a call's Send to TC from users without `voice.send_to_tc` |
| `1620fd8` | F3: show the TC Inbox read-only to users without `tc.full` |
| `736089d` | F4: run the checkout and sign-off alerts app-wide |
| `1097da9` | F5: fan the sign-off page out across offices and honour `?office=` |
| `4364099` | F8: one name per thing, plus two stale copies |

---

## Pre-existing test edits, for ratification

Only two pre-existing tests changed, both because copy they pin changed in F8. No other
pre-existing test was edited.

| Test | Edit | Why |
|---|---|---|
| `new-dashboard/tests/role-nav.test.tsx` | The test title and the expected hygiene nav are now `["TC Inbox", "Hygiene handoff", "Submissions"]`; they were `"Intake"` | F8 renames the nav item "Intake" to "Hygiene handoff" |
| `new-dashboard/tests/tc-handoffs.test.tsx` | The first test is now titled "says where call handoffs land…". It asserts the heading "Voice handoffs" (was "Voice handoffs — coming soon") and the text "Send to TC" and "on the Pipeline" (was "its own slice"). It still asserts "no sample patients", no button, no digits and no network | F8 removes the stale "coming soon" strip copy |

---

## F1: no case is left ownerless by a checkout outcome

**Finding O2.** "Scheduled" and "Not scheduled" attach to the patient's open case, usually the same
visit's unclaimed `hygiene_review` case. That moves the case out of the TC Inbox, but it set only
`status`, so the case reached the board with nobody on it.

**Change** (`backend/routes/tc/checkout.js`, inside the outcome transaction):
- An attached case that nobody owns (`assigned_tc = ''`) is assigned to the person who answered the
  checkout.
- A timeline note is added: "Checkout: assigned to the person who answered it (nobody owned this
  case)".

**Judgment calls:**
- **Every unowned case, not only `hygiene_review`.** Beau's rule is "no case is ever left ownerless
  by a checkout outcome", so the rule covers any status.
- **An owned case keeps its owner.** The UPDATE is conditional in SQL. If an Inbox Claim commits
  first, the claimer stays the owner.
- **Note placement.** The note goes after the existing status-change and note events. The funnel's
  `from → to` text is unchanged.
- **No new audit row.** The existing `tc_case` UPDATE audit covers the change, and the race's
  rollback undoes the assignment along with everything else.
- **Created cases are unchanged.** A case created at checkout was already owned by the answerer.

**Tests:** new file `backend/routes/tc/tcCheckoutOwner.test.js`, 8 tests.
- Scheduled, and separately Not scheduled, on an unclaimed `hygiene_review` case: the case is
  assigned, the note is written once, and the funnel format is kept.
- An owned case keeps its owner and gets no note.
- An unowned `considering` case gets an owner and is not moved backwards.
- A created case is owned.
- Nothing needed assigns nothing.
- Office-scoped.
- A second answer is a 409 and changes nothing more.

**Mutation check:** with the conditional broken, 4 of the 8 fail.

## F2: Send to TC honours `voice.send_to_tc`, and the 403 names the real reason

**Finding D2.** The button checked the TC module only. A `tc` user saw it, got a 403, and was told
"The TC module isn't enabled."

**Change:**
- `lib/sendToTc.ts`: `sendToTcState` takes `mayHandOff`, and the button hides without it.
- `SendToTcButton.tsx` reads the same permission the route enforces.
- `tcErrorMessage` now tells the two 403s apart:
  - `MODULE_NOT_ENTITLED` or `TC_MODULE_NOT_ENTITLED` → "The TC module isn't enabled." (unchanged);
  - a permission 403 (`FORBIDDEN`, or any other 403) → "Your role can't send calls to TC — nothing
    was sent. Ask an admin if you need to."

**Judgment call to ratify.** A user object with **no** `permissions` field is not hidden; the
server decides.
- `/auth/me` always carries the list: `lib/auth.ts` turns a missing one into `[]`. So in the app
  this is the strict check, and a `tc` user does not see the button.
- Absent-means-hidden would have broken 12 pre-existing component tests (`send-to-tc`,
  `send-to-tc-reactivity`, `link-patient-only`), whose mocked users carry no permissions. Editing
  those mocks is not a copy change.
- If you prefer strict hiding, it is a one-line change plus adding `permissions` to those three
  mocks.

**Tests:** new file `new-dashboard/tests/send-to-tc-permission.test.tsx`, 8 tests.
- The visibility rule.
- Both 403 messages.
- A `tc` user gets no button, in either the panel or the worklist icon.
- An office user can send.
- A permission 403 toasts the role message and nothing reads as sent.

## F3: TC Inbox actions follow `tc.full`

**Finding D1.** A hygienist saw **Claim** (it 403s) and **Open case** (it bounces home).

**Change** (`pages/tc/TcHygieneInbox.tsx`): without `tc.full` (or super admin), a hygienist sees
the queue read-only.
- Claim and Open case are not drawn.
- The patient's name is plain text, not a dead link.
- The subtitle reads "Hygiene handoffs waiting for a treatment coordinator to claim them".

**Tests:** new file `new-dashboard/tests/tc-inbox-permissions.test.tsx`, 5 tests.
- A hygienist sees no Claim, no Open case and no case link.
- A TC's Claim writes.
- A TC's links point at the case.
- A super admin can work the queue.
- The page title is "TC Inbox" (F8).

## F4 (ratified): checkout and sign-off alerts run app-wide

**Finding D3.** Badges and toasts were computed only on `/tc` routes. Front desk on Calls or Home
got no checkout toast, though the Notifications settings promise alerts "while it is open".

**Change** (`components/DashboardLayout.tsx`): the checkout watch and the sign-off watch now run on
**any** route.
- The checkout watch runs for anyone holding `tc.full`; the sign-off watch for anyone holding
  `tc.referral_signoff`.
- The office scope is unchanged.
- **Preferences are still honoured**, because the hooks themselves are unchanged.
- No new alert types.
- The Texts badge and the Referrals hub nav check stay TC-only.

**Judgment call.** Off a TC route, nothing else vouches for the tenant's TC module, so the layout
now checks it. Without that check, a voice-only practice would poll a 403ing TC endpoint every
minute.

**Tests:** new file `new-dashboard/tests/tc-alerts-app-wide.test.tsx`, 6 tests, on the real layout.
- The checkout toast fires on `/calls`.
- A `silent` preference on `/home` gives no toast.
- A voice-only tenant is never polled.
- A hygienist is never polled.
- The Texts badge is not polled off TC.
- A doctor on `/home` gets the sign-off toast, with no checkout poll and no preference read.

**Mutation check:** against the old layout, 4 of the 6 fail. The two "never asked" tests passed
before too.

## F5: sign-off fans out across offices and honours `?office=`

**Finding D4.** The badge counted every office in scope, but the page was single-office: on "All
offices" it asked to pick one. The toast's `?office=` was ignored.

**Change** (`pages/tc/TcReferralSignoff.tsx`):
- **One list.** The page fans out over the scope with the same helpers Checkout and the Inbox use.
  Each office answers oldest first; the merged list keeps that order and badges each row on "All
  offices".
- **Partial failure.** If one office fails to load, the other office's rows still show, with a
  "partial data" notice.
- **Actions.** Every read and write after that (open, approve, decline, edit, send back, files) goes
  to the office the referral was listed from.
- **Deep link.** The alert now links `?office=<o>&referral=<id>`, which opens that referral, as
  Checkout's `?office=&handoff=` opens its sidebar. An office outside the scope is ignored.
- **Compatibility.** `SignoffInner office=` is kept as a one-office wrapper, so the existing tests
  that render it are unchanged.

**Tests:** new file `new-dashboard/tests/tc-signoff-offices.test.tsx`, 7 tests.
- Both offices listed, badged, oldest first.
- A Valley referral is opened and approved in Valley.
- Partial failure.
- One office: no badges.
- `?office=valley&referral=` opens the referral.
- An out-of-scope office is ignored.
- The alert's Open button navigates to the referral link.

## F8: one name per thing, and two stale copies

| Thing | Was | Now |
|---|---|---|
| The async queue | page title "Hygiene Inbox"; "TC inbox" on the Intake page, its toast and the urgent flag | **TC Inbox** |
| The handoff (P1, P8) | nav "Intake", page "Hygiene Handoff", visit tray "Treatment handoff" (client label **and** the server's staged-write title) | **Hygiene handoff** |
| The `hygiene_review` status | badge "Hygiene Review", default stage "New from Hygiene" | **New from hygiene** |
| Checkout, hygiene side | "Tell the front desk…", "The front desk did not get your final notes", "Send to the front desk again", "The front desk still did not get…" | **Checkout** in each; the "Alert checkout" button is unchanged |
| Checkout, Platform | "TC checkout handoff", switch label "Checkout handoff for …" | **TC Checkout**, "Checkout for …" |
| Dashboard strip | "Voice handoffs — coming soon" (Send to TC on a call is live) | "Voice handoffs": calls arrive through Send to TC on the call and are on the Pipeline, not listed here. Still no counts, rows or fetch |
| Platform "TC referrals" | "shows the Referrals section… Nothing is sent yet." | It names what the switch gates (Settings, the hub, the case panel, Start referral on a visit / call / checkout, the doctor's sign-off queue) and that nothing is emailed unless referral email is on too |

**Left alone, on purpose:**
- **Checkout's own subtitle**, "sent to the front desk today": there it names the people, on a page
  already titled Checkout.
- **The routing slip's "For the front desk"**: that is the desk's own tasks, not the queue.
- **The intake kind labels "Treatment" / "Ortho"**: those name a kind, not the handoff.
- **Backend code comments and table names** (`tc_checkout_handoffs`).
- **The skipped screenshot harness `hyg-send-shots`**, which still feeds "Treatment handoff" as
  input data. It pins nothing, so I did not edit it.

**Notes:**
- The staged-write title is not part of the preview fingerprint (only the preview lines are), so
  renaming it cannot invalidate a staged visit.
- The default stage label only reaches offices that never saved their own stages. A saved stage
  library keeps whatever label it stored.

**Tests:** new file `new-dashboard/tests/tc-names-f8.test.ts`, 7 tests, pinning every name above
and both stale copies.

---

## Verification

| Gate | Result |
|---|---|
| `pnpm run check` (`tsc --noEmit`) | clean |
| `node --check server.js` | OK |
| Backend `node --test` | 4013 tests: 4010 pass, 3 skipped, 1 fail. The failure is `services/onDemandTranscription.test.js`, with "Unable to deserialize cloned data", the known Node 22 runner decode flake. That file is untouched and passes 24/24 alone |
| Dashboard `vitest run` | 215 files: 180 pass, 34 skipped, 1 fail. 2992 tests: 2787 pass, 204 skipped, 1 fail. The failure is `rcm-shell` "keeps Posting history out of the nav…", a **5 s timeout under full-suite load**. It passes 36/36 alone and **also times out on develop's client code** (checked by running the suite with `new-dashboard/client` reset to `origin/develop`), so it is not from this branch |

New tests on this branch: 41 (8 backend, 33 dashboard).

## Not in this branch

- **F6:** unfiled referrals, and linking a checkout referral to its case.
- **F7:** the doctor's alert preference, and hiding the sign-off preference.
- The IA layout itself (Option B).

## Decisions for Beau

1. Ratify the two test edits above.
2. **F2:** keep "no permissions field ⇒ server decides", or switch to strict hiding (one line plus
   three test mocks)?
3. **F1:** assigning any unowned attached case (not only `hygiene_review`) follows "no case is ever
   left ownerless". Confirm.
