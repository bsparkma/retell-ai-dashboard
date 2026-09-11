# RCM — the practice owner's walkthrough (staging)

A checklist for walking the new RCM screens yourself on **staging.carein.ai**,
before anybody at the front desk sees them. It follows the same road as the
September combined walk, and the same road the automated smoke test walks
(`new-dashboard/tests/rcm-smoke.test.tsx`). Each step says what to do and **what
you should see**. If what you see is different, stop and write down what the
screen said, word for word.

**The whole walkthrough runs in shadow mode.** Posting is switched off for Roland,
so nothing you do here reaches a patient's chart in Open Dental. You never press
**Post to Open Dental**.

---

## Only these two patients

| Patient | PatNum | Office |
| --- | --- | --- |
| Stedi Test 2 | 12827 | Roland |
| Test, MangoTest | 12828 | Roland |

**Never 11373** — that number is a shared family phone, not a test patient. Never
any real patient. If a name you don't recognise, or 11373, appears anywhere on
these screens, stop there.

---

## Before you start (done by the engineer, not you)

1. **Fresh test checks.** The four test 835 files in `docs/fixtures/rcm-reseed/`
   name claims that were torn down after the September walk, so they will not
   match anything now. The engineer re-runs the reseed for Roland on staging
   (`docs/fixtures/rcm-reseed/README.md`, "Generating them"). That creates fresh
   claims on the two test patients and four fresh files — **R1** (a clean check,
   three claims), **R2** (one line for the office to write off), **R3** (a
   takeback, −$29.00) and **R4** (a check that deliberately matches nothing).
2. **Posting switched off.** An administrator opens **Admin → Office** and makes
   sure Roland's posting switch is **off**. Leave it off for the whole walkthrough.
3. You sign in as a user who is allowed to approve.

---

## The walkthrough

### 1. Today

Open **/rcm**.

**What you should see**
- A greeting and today's date at the top.
- In the header: your **name · Roland Family Dental** (your name, not your email
  address) and an amber pill: **Shadow mode — nothing is sent to Open Dental yet**.
- Lower down, **Get work in**, with two drop zones: one for the carrier's 835
  file, one for an EOB PDF. This is the only place in RCM you can add a check.

### 2. Add the test checks

Under **Get work in**, upload **R1**, **R2** and **R4** (the 835 zone). Leave R3
for step 11.

**What you should see**
- After each upload, a line naming the payer, check number and amount, with a link
  that opens that check.
- "Proposals only — a person still decides what gets posted."

### 3. Checks

Open **Checks** in the left menu.

**What you should see**
- Exactly four tabs: **Needs attention · Saved for tomorrow · Set aside · All**.
- No upload box on this page. Its **Add a check** button takes you back to Today.
- A **Waiting on** column where every row names *who*: "You — 3 claims to check
  over", "You — it is ready to approve", "Shadow mode — posting is switched off",
  "Nobody — …". A long sentence wraps onto a second line; it is never cut off with
  "…". (A payer name *may* be cut off — that is fine.)

### 4. The check's own page (R1)

Open R1.

**What you should see**
- Under the payer name: the amount · the date received · how many claims.
- A row of five steps: **Add the check › Match it up › Check it over › Post to
  Open Dental › Deposit**. Under the row, one line of evidence per step (for
  example, "The carrier's 835 file read Sep 10."). **Deposit** is grey and says
  "Coming soon".
- One button at the top right: **Match it up**. There is no second match button
  anywhere else on the page.
- In the claims table, the **Where the patient stands** column reads "Not judged
  yet — match it up and check it over." — never a guessed dollar figure.

### 5. Match it up — the run says what it did, and what it skipped

On R1, press **Match it up**.

**What you should see**
- A one-line summary: **Matched 3 claims**. When nothing was skipped, it names
  nothing skipped.

Now open **R4** and press **Match it up**.

**What you should see**
- **Matched no claims · 1 with nothing in Open Dental to match.** R4 is built to
  match nothing — this is the screen being honest about it, not a fault. The
  summary must always say what it left alone and why; it must never say
  "Matched 1" for a claim it did not match.

### 6. Match one claim — a confident match

Back on R1, open the first claim.

**What you should see**
- A green sentence saying what agrees — the claim number, the name, the service
  date, every line. It **never** says the birthday or the subscriber agree (the
  carrier's file doesn't carry those, so nothing compared them). Open Dental's
  own birthday and subscriber may be *shown* in the Open Dental column; that is
  fine.
- **Yes, that's the one.** Press it. It links straight away, with no extra question.
- Footer note: "Nothing is written to Open Dental in this step — matching only
  tells the app which claim you mean."

> **A question you won't see here.** When the carrier's claim number does *not*
> agree with the Open Dental claim, confirming asks you first, names what doesn't
> agree (claim number first), and has **Cancel** highlighted. None of the four
> staging files has a disagreeing claim number, so you will not meet that question
> on staging. The automated smoke test covers it (step 1.9).

### 7. Check it over — a green claim, and saving for tomorrow

Still on that claim.

**What you should see**
- A green banner at the bottom: the patient's figure and "matches the EOB".
- The line under the step row reads "Linked to Open Dental claim …".
- Press **Mark checked over**. The line changes to "… and checked over by
  ⟨your name⟩ on ⟨date⟩."

Now press **Save for tomorrow** at the top of the claim, and go back to **Today**.

**What you should see**
- A **Where you left off** card showing R1, and a sentence naming the next thing
  by name — for example "Next: keep checking it over — Test, MangoTest is up, 1
  more after." — and one button: **Pick up where you left off**. It takes you
  straight to that claim.

Match and check over the rest of R1's claims the same way, then go back to R1's page.

**What you should see**
- In the claims table, **Where the patient stands** repeats each claim's banner
  sentence in the banner's own colour: a claim that matches the EOB is **green**,
  an amber claim is amber, a red one red. A claim not matched yet reads
  "Not judged yet" in plain grey.

### 8. The office write-off — an amber claim (R2)

Open R2, match it, and open the claim with the line that leaves **$480.00**.

On that line press **Write it off**, then pick a reason.

**What you should see**
- The banner turns **amber** and says the patient's figure is below the EOB
  because you wrote that line off.
- A chip inside the banner: the procedure code · **$480.00** · the reason ·
  "decided by ⟨your name⟩, ⟨time⟩". Your **name** — never your email address.
- There is no box to type an amount, and no way to record a write-off without a
  reason.

Press **Mark checked over**.

### 9. Before you say yes (R1)

On R1's page, press **Review and approve**.

**What you should see**
- **Before you say yes.** Money on the left, **What the app checked** on the right.
- The checklist is only the conditions the app actually checked. Every line has a
  tick or a cross, and a cross names which claim it is about.
- The totals row at the bottom of the money table adds up to the rows above it.
  Add them up yourself once.
- **Yes — this check is right** and, beside it, **Go back and change something**,
  with "This is the last moment anything can be changed."

**Two-tab test.** Open this same page in a second browser tab. In the first tab,
press **Yes — this check is right**. Then press it in the second tab.

**What you should see**
- First tab: "N claims approved — $…" and **Back to the check**.
- Second tab: **Already approved — see it on the Posting screen**, with a link.
  The button is gone. It never invites you to press again.

Reload the page.

**What you should see**
- The grey button with "Every claim on this check is already approved…" beside it.
  Every tick in the checklist is green. Nothing says "waiting".
- **Take me to the check to post it.**

### 10. The post step, held by shadow mode

Go back to R1's page.

**What you should see**
- In the step row, **Post to Open Dental** reads "Switched off while shadow mode
  is on. Approved checks wait here." It is not red — nothing is wrong.
- The **Post to Open Dental** button is grey, and the reason is printed beside it
  (not in a tooltip): "Posting is switched off for Roland (shadow mode). Approved
  checks wait here." — the practice's name, capitalised, the same as the banner
  below it says.
- Under it: "Approved and waiting. Nothing has been written to Open Dental yet."
- A grey banner: "You can do everything on this check except send it to Open
  Dental — and that's on purpose…" with **Who can switch this on?**
- **What this app would have done, if posting were on** — a table: payment, the
  office's write-off, and what each patient would owe. It appears only on an
  approved check.
- **Did the app get this check right?** with two answers.
  - Press **No — something was off**: a small form opens asking why. Press
    **Cancel**; nothing was saved.
  - Press **Yes — same as I did by hand**: it is saved in one click, with no
    second question.

**Do not press Post to Open Dental** (it is grey anyway).

### 11. The takeback (R3)

Upload **R3** on Today, then find it on **Checks**.

**What you should see**
- Its **Waiting on** reads "A takeback — money the carrier is reclaiming", whole,
  never cut off. On Today, its row reads "The carrier is reclaiming money. It is
  authorised on its own."

Open it, then press **Review and approve**.

**What you should see**
- One sentence saying the claim is the carrier taking money back and is authorised
  on the check itself, and one button: **Take me to the takeback**. No checklist,
  no wall of crosses, no **Yes** button.

On the takeback panel (**The carrier is taking money back**):

**What you should see, in order**
1. The box for typing the amount is **grey**, with the reason beside it: the
   claim is not linked to an Open Dental claim yet.
2. **As an adjustment (can be undone)** is already selected.
3. Match the claim (open it, **Yes, that's the one**), then come back. The box is
   now live.
4. Click **As a negative supplemental (PERMANENT)**. It does **not** switch. A
   question appears instead, with **Cancel** highlighted. Press **Cancel** — you are
   still on the adjustment.
5. Type `29.00`, then `-29`, then `-29.0`. **Approve the takeback** stays grey
   each time, with "Type the amount above exactly as it is shown to enable this."
6. Type `-29.00`. The button turns on.

**Stop there. Do not press Approve the takeback on staging** — in shadow mode the
takeback's original payment has never posted, so there is nothing for it to come
off, and it would only leave an approval behind that nobody can use.

### 12. The Posting history (an administrator)

Signed in as an administrator, open **Posting history**.

**What you should see**
- In shadow mode, only **Ready to post** rows: "Approved and waiting. Nothing has
  been written to Open Dental yet."

If a row in any other state is ever on this screen, this is how it must read.
Every row's heading shows the check's own amount — that is the carrier's number
and it is fine. The table is about the sentences under the heading:

| State | It must say | It must never show |
| --- | --- | --- |
| **Ready to post**, tried before | "An earlier posting run did not finish. Press Post again…" | "Nothing has been written" |
| **Failed** | "The run stopped while ⟨step⟩. Press Post again…" | a dollar amount, a fix, the run's own error text |
| **Partly posted**, stopped early | "It stopped while ⟨step⟩ — before it compared any patient's balance…" and "Nothing on this screen is a reason to change a chart." | a dollar amount, a fix, **Check it again** |
| **Partly posted**, measured | Green first: "The payment did reach Open Dental… Do not enter it again by hand." Then what the app promised against what the chart says. | — |
| **Posted** | "Confirmed in Open Dental", the Open Dental check number | "will owe", "projection" |

On the check's own page, a failed, re-tried or **Blocked** check that already has
an Open Dental check from an earlier run shows the check **number** — "An Open
Dental check #N from an earlier run exists. Do not enter this payment again by
hand." — and **no amount**.

### 13. When you're done

Leave Roland's posting switched **off**. Before anybody switches it back on, ask
the engineer to retire the checks you approved here (**Retire this check** on the
Posting history), so a later **Post** press does not send your walkthrough checks
to the test patients' charts.

---

## What must NOT appear, anywhere

If you see any of these, stop and send a screenshot.

- **A dollar figure on a stopped check** — in what a failed check, a partly posted
  check that stopped before measuring, a check put back in line after an
  interrupted run, or a **Blocked** check carrying an earlier run's Open Dental
  check says about itself. The Open Dental check *number* may appear. An
  *amount* may not. (The check's own amount in a page heading or a list is the
  carrier's number and is fine.)
- **Remediation steps without a measurement** — "correct the line", "add an
  adjustment", "raise the write-off", **Check it again** — anywhere except the one
  screen that starts with "The payment did reach Open Dental" and then shows what
  the app promised against what the chart says now.
- **"Nothing was written" after an attempt** — or "no check was created", "starts
  clean". Only a check that was approved and **never tried** may say "Nothing has
  been written to Open Dental yet."
- **An email address where a name belongs** — in the header, "decided by",
  "approved by", "checked over by", or on the Admin cards.
- **A practice's system name** — "roland" or "valley" in lowercase, anywhere a
  sentence names the practice. It should always read "Roland" (or the full
  practice name).
- **Two state sentences on one card** — for example "already approved" beside
  "waiting for", or "Finished" beside "stopped".
- **A grey button with no reason beside it.** Every button that can't be pressed
  says why, next to it — never only in a tooltip.
- **The old words:** drain, batch, plan, read-back, recoupment, withheld.
- **Any patient other than Stedi Test 2 (12827) and Test, MangoTest (12828).**
