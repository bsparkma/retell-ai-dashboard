# Discovery: where TC work arrives (queue slice C5)

**Type:** discovery document only. This PR changes no code, nav, route or config. It touches only
`docs/reports/`.
**Branch:** `docs/tc-incoming-work-ia`, cut from `origin/develop` at `c8de121` (after #250).
**Method:** read the code. Citations are to `origin/develop` at that commit. Paths are relative to
`new-dashboard/client/src/` unless they start with `backend/` or `new-dashboard/shared/`.
**Screenshots:** linked from the existing `docs/screenshots/tc/` set. They were rendered from
synthetic fixtures, so they contain no real patients. This PR adds no new images.

---

## 1. Summary

Work for a treatment coordinator now reaches TC through **six producers**:
- three hygiene buttons;
- two call buttons;
- the nightly Open Dental sync.

It lands in **five queues**: TC Inbox, Checkout, Awaiting sign-off, Opportunities and the Pipeline.
Each queue has its own vocabulary, its own idea of "Claim", and its own alerts, or none.

On staging, the result is that **one hygiene visit can create four items in three places**:
- a treatment case and an ortho case, both in the TC Inbox;
- a checkout row;
- a referral in the doctor's queue.

Those four items **do not know about each other**.

The biggest single problem is that answering a checkout quietly moves the same visit's TC Inbox case
onto the board with no owner (§4, O2).

**Recommendation (§6): Option B, "Now / Inbox / Sign-off".**
- Keep the real-time Checkout queue separate. The patient is standing at the desk.
- Fold the TC Inbox into one **TC Inbox** that also takes call handoffs and unfiled referrals.
- Keep sign-off as the doctor's own page.

Ship it after a short set of **pre-IA fixes** (§7). Those fixes are bugs whatever layout is chosen,
and most are small.

---

## 2. The producers: what creates TC work

| # | Producer | Who presses it | Where | What it creates | Lands in |
|---|---|---|---|---|---|
| P1 | **Treatment handoff**: the "Treatment handoff" staged write ("The treatment, to the treatment coordinator.") that rides the visit **Send** | hygienist | hygiene visit (`components/hyg/StagedWritesTray.tsx:78-111`) | a **new** `tc_cases` row, status `hygiene_review`, plus `tc_hygiene_intakes` (kind `hygiene`) | TC Inbox |
| P2 | **Ortho screening → "Send to TC"** | hygienist | visit's Ortho tab (`features/hyg/visit/OrthoScreening.tsx:391`) | a **new** `hygiene_review` case (kind `ortho`), chip "Ortho · needs work-up" | TC Inbox |
| P3 | **"Alert checkout"** button, and **every visit Send** in an office with checkout on | hygienist | visit header (`features/hyg/visit/CheckoutAlert.tsx`) | a `tc_checkout_handoffs` row (kind `checkout`), **no case** | Checkout |
| P4 | **"Start referral"** chairside | hygienist | visit (`features/hyg/visit/VisitReferral.tsx`) | a `tc_referrals` row, source `hyg_visit`, **`tc_case_id` null** | Awaiting sign-off (or nowhere: §4, D5) |
| P5 | **"Send to TC"** on a call | office / admin | call detail and worklist row (`pages/calls/SendToTcButton.tsx`) | attaches to ANY open case (even an unclaimed `hygiene_review` one), or creates a case at `pending_tc` **assigned to the clicker** | Pipeline board, skipping the Inbox |
| P6 | **"Start referral"** on a call | office / admin | call detail (`pages/calls/CallReferralButton.tsx`) | `tc_referrals`, source `call`; linked to a case only if the call was already sent to TC | Awaiting sign-off, or nowhere if saved as a draft |
| P7 | Nightly OD sync of unscheduled treatment plans | system | n/a | `tc_opportunities` rows; Claim creates or attaches a case at `pending_tc` | Opportunities |
| P8 | TC's own **Intake** form ("Submit handoff to TC") | TC / office / hygienist | `/tc/hygiene` (`pages/tc/TcHygieneIntake.tsx`) | the same as P1 | TC Inbox |

TC staff also create referrals themselves: "New referral" on a case, and "Start referral" in the
checkout sidebar. Those are done inside TC, so the referral is born attached to a case or handoff.

---

## 3. The queues: where it is read

| Queue | Route / nav | Who sees it | Contents | Actions | Alert |
|---|---|---|---|---|---|
| **TC Inbox** | `/tc/hygiene/inbox`, nav "TC Inbox" (Hygiene group); page title "Hygiene Inbox" | admin, office, tc, **hygiene** (`tc.hygiene`) | unclaimed `hygiene_review` cases, urgent first | **Claim** (assign to me + `pending_tc`), **Open case**; no dismiss or reject | **none**: no badge, no toast |
| **Checkout** | `/tc/checkout`, nav "Checkout" (Casework); only when the switch is on in scope | admin, office, tc (`tc.full`) | today's handoffs: Waiting / Done today; lazy expiry at the day boundary | Claim ("I've got this patient"), Dismiss (reason), **Scheduled / Not scheduled / Nothing needed**, Start referral | badge "N waiting at checkout"; toast "{patient} is headed to checkout"; obeys the `checkout_handoff` preference |
| **Awaiting sign-off** | `/tc/referrals/signoff` (Casework); only when referrals is on in scope | **admin, doctor only** (`tc.referral_signoff`) | `pending_signoff` referrals, oldest first; files viewable | Approve, Decline (reason) | badge "N awaiting sign-off"; toast "{patient}'s referral is waiting for your sign-off" |
| **Opportunities** | `/tc/opportunities` | `tc.full` | unscheduled OD treatment plans | Claim, Dismiss | dashboard card only |
| **Pipeline** | `/tc` (board / list) | `tc.full` | open cases; the **board excludes** `hygiene_review`, the **list includes** it | drag between stages | "Tx not in OD" chip on cards (C2b) |
| Case page | `/tc/cases/:id` | `tc.full` | read-backs: Ortho screening, **Treatment from hygiene** (C2b attestation), **Referrals** panel | attest, New referral, verbs | n/a |

Screens: Checkout [inbox](../screenshots/tc/tccheckout-01-inbox-1280x900-light.png) ·
[sidebar](../screenshots/tc/tccheckout-02-sidebar-1280x1100-light.png) ·
[case treatment](../screenshots/tc/tccheckout-06-case-treatment-1280x900-light.png) ·
[hygiene panel](../screenshots/tc/tccheckout-07-hygiene-panel-1280x700-light.png) ·
[sign-off queue](../screenshots/tc/tccheckout-09-signoff-queue-1280x700-light.png) ·
[case referrals](../screenshots/tc/tccheckout-10-case-referrals-1280x800-light.png) ·
[chairside referral](../screenshots/tc/tccheckout-11-chairside-referral-1280x900-light.png) ·
[attachments](../screenshots/tc/tccheckout-12-referral-attachments-1280x1100-light.png).

### Today's TC nav (`components/DashboardLayout.tsx:188-231`)
- **Casework:** Dashboard · Pipeline · Nurture · Follow-Ups · Texts (badge) · Opportunities ·
  **Checkout** (badge) · **Awaiting sign-off** (badge) · Pre-Auth
- **Hygiene:** **TC Inbox** · **Intake** · **Submissions**
- **Tools:** Financing · Gallery · Email Templates · Communications · TC Guide · Reports · COB
  Calculator · Library · Settings

| Role | TC nav it gets |
|---|---|
| admin | everything |
| office, tc | everything except Awaiting sign-off |
| hygiene | only the Hygiene group (plus hygiene "Today") |
| doctor | only Awaiting sign-off |
| reviewer, rcm_biller | no TC |

**Incoming work is split across two nav groups.** Checkout and sign-off are in Casework, TC Inbox
is in Hygiene, and Opportunities sits between Texts and Checkout.

---

## 4. What overlaps, confuses or dead-ends

Every finding was read from code. **"Verified"** means I re-read the cited lines myself, on top of
the inventory pass.

### Overlaps: the same work in more than one place
- **O1. One visit, four items.**
  - P1 and P2 each create a **separate new** `hygiene_review` case. Hygiene intakes never attach to
    an open case; only a `sourceKey` replay dedups.
  - P3 adds a checkout row, and P4 adds a referral.
  - So the TC sees the same patient twice in the Inbox and once in Checkout. The doctor sees them in
    sign-off.
- **O2. Answering a checkout silently empties the Inbox. Verified.**
  - "Scheduled" / "Not scheduled" attach to "the patient's open case", which is usually the same
    visit's unclaimed `hygiene_review` case.
  - The update sets `status` only (`backend/routes/tc/checkout.js:502-503`, `UPDATE tc_cases SET
    status = …`), never `assigned_tc`.
  - So the case leaves the Inbox **unclaimed** and lands on the board with **no owner**.
- **O3. Call Send to TC can join an unclaimed Inbox case.**
  - P5 attaches to any open case, `hygiene_review` included (`new-dashboard/shared/tc/contract.ts:141-150`).
  - The caller is told "Added to {name}'s existing TC case", but the case sits in the Inbox with
    nobody on it.
- **O4. Hygiene treatment shows twice on one case.** It appears as the intake's "Suspected:" text and
  as C2b's "Treatment from hygiene" panel plus its $0 plan phase. They come from two snapshots of
  the same chairside decision.
- **O5. `hygiene_review` shows in two views:** the Inbox and the Pipeline **list** (but not the
  board).

### Wording drift: one thing, several names
- **W1. The Inbox has four names:** nav "TC Inbox", page title "Hygiene Inbox", the Intake page's
  "TC inbox", and code comments "hygiene inbox".
- **W2. The handoff has five names:** nav "Intake", page "Hygiene Handoff", tray "Treatment
  handoff", kind label "Treatment", and status "Hygiene Review", which Settings → Stages calls "New
  from Hygiene".
- **W3. Checkout has three names:** the hygienist sees "front desk" and "Alert checkout", TC sees
  "Checkout", and the Platform tab says "checkout handoff".
- **W4. "Send to TC" means three different things:**
  - from a call, an **owned case on the board**;
  - from ortho, an **unowned case in the Inbox**;
  - "Submit handoff to TC", the Inbox.
- **W5. "Claim" means three different things:**
  - Inbox: take ownership and move the stage.
  - Checkout: "I've got this", with no case change.
  - Opportunities: create a case.

### Dead ends: a door that 403s, or work with no home
- **D1. A hygienist in the TC Inbox** sees **Claim** (the server needs `tc.full`, so it 403s) and
  **Open case** (`/tc/cases` needs `tc.full`, so it bounces home). Neither is hidden.
- **D2. A `tc` user on calls sees Send to TC, and it 403s with the wrong reason. Verified.**
  - The button checks the module only (`lib/sendToTc.ts:50-52`), not `voice.send_to_tc`.
  - The 403 maps to "The TC module isn't enabled." (`lib/sendToTc.ts:~98`).
  - The call's Start referral button does check the permission.
- **D3. Alerts fire only on `/tc` pages. Verified.**
  - Badges and toasts are computed only when `isTcRoute` (`DashboardLayout.tsx:375-378, 455-459`).
  - Front desk on Calls or Home gets **no checkout toast**, though the Notifications settings
    promise alerts "while it is open".
- **D4. Sign-off office scope doesn't match.**
  - The badge counts every office in scope, but the page is single-office: on "All offices" it says
    pick an office.
  - The toast's `?office=` is ignored there, though Checkout honours it.
- **D5. Referrals not tied to a case have no TC home.**
  - There is **no referrals list page**; the case panel lists by `tc_case_id` only.
  - Referrals with no case: chairside `hyg_visit` referrals (always null), call drafts ("finish it
    in TC"), and checkout referrals made before the outcome created a case.
  - No code links a referral to a case created later.
  - A **declined** chairside referral notifies nobody.
- **D6. Preferences go to the wrong people.**
  - Every `tc.full` user can set "A referral is waiting for the doctor's sign-off", which never fires
    for office or tc.
  - The doctor, who does receive it, can't open Settings, so a doctor always gets "Banner".
- **D7. The Inbox has no reject path.** Claim is the only exit. Checkout and Opportunities both
  have Dismiss with a reason.
- **D8. Stale copy.**
  - The Dashboard's "Voice handoffs — coming soon" strip, though P5 is live.
  - The Platform "TC referrals" copy says the switch shows a Settings section. It also gates the
    case panel, the checkout chip, sign-off, the chairside referral and the call referral.

---

## 5. Who uses what

| Person | Produces | Reads | Pain today |
|---|---|---|---|
| **Hygienist** (chair) | P1-P4 | Submissions (own status) | Four buttons for four destinations. Sees an Inbox they can't act on (D1). |
| **Front desk / office manager** | P5, P6 | Checkout, Pipeline, Opportunities | No checkout alert outside TC (D3). Send to TC and the Inbox disagree (O3). |
| **Treatment coordinator** | case referrals | TC Inbox, Checkout, Pipeline, Opportunities, Follow-Ups, Texts | Same patient in two or three queues (O1). Owner-less cases on the board (O2). No unfiled-referrals list (D5). |
| **Doctor** | approvals | Awaiting sign-off | Can't set their own alert (D6). Office picker mismatch (D4). |
| **Admin / Beau** | switches | everything | Platform copy understates the referral switch (D8). |

---

## 6. Consolidation options

All three options keep Awaiting sign-off as the doctor's own page. A doctor has exactly one job here,
and `tc.referral_signoff` is deliberately not held by office or tc.

### Option A: one "Incoming" page with source tabs
Replace TC Inbox, Checkout and the Opportunities entry point with **Incoming**, tabbed:
Checkout today · From hygiene · From calls · Referrals to finish · Opportunities.
- **Pros:**
  - One nav item and one badge.
  - The clearest answer to "where is new work?"
- **Cons:**
  - It mixes a **real-time** queue (the patient is at the desk now) with **async** ones (claim
    within a day). The real-time one gets buried under backlog, and Checkout's whole value is
    speed.
  - It is the largest change: a new route, folded badges, re-pointed links and toasts.
  - Hygienists hold `tc.hygiene` but not `tc.full`, so tab-level gating is needed.

### Option B (recommended): split by time horizon, "Now / Inbox / Sign-off"
- **Now = Checkout**, unchanged, but its alert works app-wide (fix D3). It stays at the top of
  Casework.
- **Inbox = one TC Inbox for async work**, moved into Casework and fed by:
  - hygiene handoffs and ortho screenings (as today);
  - **call handoffs** (P5 lands unowned, or in the Inbox when it is not already owned — a product
    choice, below);
  - **unfiled referrals** (drafts and declined ones with no case: D5);
  - a source chip on each row ("Hygiene" · "Ortho" · "Call" · "Referral").
  - It gains a badge, Dismiss with a reason (D7), and Claim from the case being created.
- **Sign-off**, the doctor's page, unchanged apart from fixing D4 and D6.
- **Hygiene group** shrinks to the hygienist's own pages: Intake and Submissions. The Inbox moves to
  Casework, which also removes D1.
- **Pros:**
  - It matches how the office works: one thing is urgent now, the rest is a to-do list.
  - Each item lives in exactly one queue.
  - Moderate size, mostly re-pointing; Checkout and sign-off barely change.
- **Cons:**
  - Opportunities stays a separate queue. It is a different kind of work, mined from OD rather than
    handed over, but it is a sixth door.
  - It needs a decision on whether call handoffs keep creating **owned** cases (today) or become
    Inbox items.

### Option C: patient-centric "visit card"
Collapse everything one visit produces into a **single visit record**: treatment, ortho, checkout
and referral as sub-items, with one owner and one status. The case becomes the home for all of it.
- **Pros:**
  - It fixes O1, O2 and O4 at the root, not with links: one visit, one case.
  - It is the long-term shape.
- **Cons:**
  - It is a **data-model change**, not an IA change: intake dedup, a case attach rule, and migrating
    existing `hygiene_review` cases.
  - It is RED and multi-slice.
  - The real-time Checkout view still has to exist on top of it.

### Recommendation
Do **Option B** now. Take **Option C's data rule** as its own later slice: "a hygiene intake attaches
to the patient's open case, like a call does". Option B's single Inbox makes that rule easy to see
working.

---

## 7. Pre-IA fixes: worth doing under any option

Ordered by harm. Each is a normal slice; none changes nav.

| # | Fix | Finding | Lane guess |
|---|---|---|---|
| F1 | A checkout outcome that attaches to an unclaimed `hygiene_review` case also **assigns** it to the person answering (or explicitly leaves it in the Inbox) | O2 | GREEN (behaviour plus a route test) |
| F2 | The call's Send to TC button honours `voice.send_to_tc`, and the 403 copy names the real reason | D2 | GREEN |
| F3 | Hide Claim / Open case for users without `tc.full` in the Inbox | D1 | GREEN |
| F4 | Checkout and sign-off watches run app-wide for permitted users, not only on `/tc` routes | D3 | GREEN, but **confirm with Beau**: it changes when alerts fire |
| F5 | Sign-off page fans out across offices and honours `?office=` like Checkout | D4 | GREEN |
| F6 | An "unfiled referrals" view, plus linking a checkout referral to the case its outcome creates | D5 | RED if it needs a migration or a new vocabulary; the link alone is GREEN |
| F7 | The doctor gets a personal alert preference; the sign-off preference is hidden from users who never receive it | D6 | RED (a permission change) |
| F8 | Copy pass: one name per thing (W1-W3), the stale Dashboard strip, the Platform referral copy | W1-W3, D8 | GREEN |

---

## 8. Decisions for Beau

1. **Option B, A or C?** The recommendation is B, then C's attach rule.
2. **Call handoffs:** keep creating an **owned case on the board** (the clicker is the owner), or land
   in the shared Inbox for a TC to claim?
3. **Should checkout alerts reach front desk anywhere in the app** (F4), or only inside TC?
4. **Hygiene intake attach rule** (Option C's rule): may a hygiene handoff join the patient's
   existing open case instead of making a new one?
5. **Names.** Proposed:
   - "TC Inbox" for the async queue;
   - "Checkout" everywhere, including the hygiene side's "Alert checkout";
   - "Hygiene handoff" for P1 and P8;
   - "New from hygiene" for the status.

## 9. Not in this document
- No code, nav, route or config change. No screenshots were added.
- R5 (sending referrals) stays on hold. Nothing here proposes a send path.
- No Open Dental reads or writes are proposed.
