# Staging walk: Checkout + Referrals (queue items 49–55, ALL SLICES DONE)

**For:** Beau, walking the feature end to end on **https://staging.carein.ai**.
**Covers:** C1, C2, C2b and C3 (checkout), and R1–R4 (referrals). All merged to `develop` as of #250.
**Time:** about 60–75 minutes. Do the parts in order; later parts reuse what earlier parts made.
**Nothing here sends anything to a specialist.** Referral sending (R5) is not built.

---

## Before you start

### Test patients: use only these
| Office | PatNum | Name in Open Dental |
|---|---|---|
| **roland** | **12827** | Stedi Test 2 |
| **valley** | **7115** | Stedi TestValley |

PatNum 7115 in roland is a **different, real person**. Always check the office badge before you act.

### What touches the chart, and what doesn't
- **Checkout and referrals write nothing to Open Dental.** They only show snapshots.
- **The hygiene visit's own Send does write to the chart** (the clinical note, and perio if you
  staged any). That is the existing hygiene feature, not this one.
  - Staging refuses those writes for anyone but the test patients (`HYG_TEST_PATIENTS_ONLY`), so a
    slip shows as a refusal, never a write.
  - Still: **only press Send on a 12827 or 7115 visit.**

### Set up once
1. **A hygiene appointment today** for **12827** in roland's Open Dental, on a hygiene operatory.
   That is what the Hygiene "Today" list shows. For Part 7, also add one for **7115** in valley.
2. **Hygiene is switched on** for roland: Platform Console (`/platform`) → **Hygiene** tab. It
   already is if you've been walking hygiene.
3. **Four logins** (or one admin account plus role switching on **Users**, `/admin/users`):
   - an **admin** (you);
   - a **hygienist**;
   - a **TC** or **office** user;
   - a **Doctor**: Users → pick a test account → role **Doctor** → save.
   A second browser profile per role makes this much faster.
4. **The call store** needs at least one staging call from roland for Part 5. Any recent call will do.

### Expected and fine
- **Attachment uploads answer "Attachment storage isn't set up here yet. Nothing was saved."**
  - That stays true until the `tc-referrals` blob container is created in TC's storage account and
    the app's managed identity is granted **Storage Blob Data Contributor**.
  - It is fail-closed by design. Part 6 checks that the refusal is honest.
- A switch flipped in the Platform Console usually applies immediately on staging (one replica).
  Allow up to 5 minutes before calling it a bug.

---

## Part 1: switch the offices on (admin)

1. Open **Platform Console → TC checkout**. Turn **roland ON**, confirm, and leave **valley OFF**.
   - ✅ The row reads On for roland and shows who changed it and when.
2. Open **Platform Console → TC referrals**. Turn **roland ON**, and leave **valley OFF**.
3. In **TC → Settings**, with office **roland**:
   - ✅ **Referrals** is now the last section.
   - ✅ Switching the office to **valley** hides it.
4. In **Settings → Referrals → Specialist directory**, **Add a specialist** twice. Use made-up
   practices, such as "Test Oral Surgery" and "Test Endo".
   - ✅ A bad email (e.g. `nope`) is refused by the form.
   - ✅ Edit one and mark it **inactive**. It disappears; **Show inactive** brings it back. Leave
     at least one active.
5. In **Referral settings**, check that **"Doctor signs off before a referral goes out"** is ON.
   - ✅ As the TC user, both toggles are read-only: "Only a practice admin can change these."

---

## Part 2: notifications (TC / office user)

1. Go to **TC → Settings → Notifications**.
   - ✅ "A patient is headed to checkout" reads **Banner (built-in default)**.
2. Set **Your alerts** for it to **Sound + banner**.
   - ✅ You hear the chime once, and the line reads "(your choice)".
3. **Leave this tab open on a TC page** (Pipeline is fine).
   - Checkout alerts fire **only while you are on a `/tc` page**. That is a known gap, logged in
     the C5 doc (finding D3).

---

## Part 3: hygiene Send → checkout → outcome (hygienist, then TC)

**Patient: roland 12827 (Stedi Test 2).**

1. **Hygienist:** **Hygiene → Today** → roland → open the **12827** visit.
   - ✅ **Alert checkout** appears above the tabs.
2. Stage treatment: a **crown on #3, marked urgent**, and an **SRP, whole mouth**.
3. Press **Alert checkout** twice, quickly.
   - ✅ It reads "Checkout alerted at h:mm · your final notes go with Send". Only one checkout is
     made.
4. **TC user (on the open TC tab):** within about 60 seconds:
   - ✅ the toast "<test patient> is headed to checkout" (the name as Open Dental formats it), with the chime;
   - ✅ **Checkout** in the nav with a badge of 1.
5. Open **Checkout**.
   - ✅ The row shows **Notes pending** and "2 items staged".
   - Click it. The sidebar shows the treatment, priority, next visit, and **Referral: None**.
6. **Hygienist:** stage the note and press **Send**. This is the chart write, so 12827 only.
   - ✅ The checkout line now reads "final notes sent at h:mm".
7. **TC:** **Check again**.
   - ✅ The sidebar badge changes to **Final notes in**.
8. Press **I've got this patient**.
   - ✅ The row shows Claimed with your name.
9. Answer it **Not scheduled**.
   - ✅ The toast says the case was created or added to, with an **Open case** link.
   - ✅ The row moves to **Done today**.

**Second outcome, quick:** if you have another 12827 visit (or after Part 7's reset), answer one
**Scheduled**:
- ✅ the patient's case lands in the **Scheduled** column.

Then answer one **Nothing needed**:
- ✅ no case is created.

**Dismiss:** on a fresh checkout, **Dismiss** asks for a reason.
- ✅ After confirming, it reads "Checkout dismissed".

---

## Part 4: treatment stays visible until attested (TC, then admin)

This picks up the 12827 case from Part 3, step 9.

1. **Pipeline board:**
   - ✅ The 12827 card shows **Tx not in OD**.
2. Open the case → **Treatment from hygiene**.
   - ✅ Both items are listed, with "**0 of 2 entered in Open Dental**".
   - ✅ The **Treatment** tab has a "**Hygiene visit <today>**" phase at **$0**.
3. **Present Case:**
   - ✅ the warning "This plan has unpriced hygiene-visit items — set fees before presenting".
   - **Back to the case to set fees** returns you.
   - **Present anyway** opens the deck. Close it.
4. **Pull from Open Dental:**
   - ✅ The review step names the "Hygiene visit <today>" section.
   - **Cancel.** Don't import.
5. **Mark both items entered** (this is your attestation; it writes nothing to OD).
   - ✅ The panel reads 2 of 2.
   - ✅ Back on the board, the **Tx not in OD** chip is gone.
6. **As the TC user:**
   - ✅ there is **no Undo** button.
7. **As admin:** **Undo** one item.
   - ✅ It returns to "not entered", and the board chip comes back.
   - Mark it entered again.

---

## Part 5: create a referral from all three surfaces

All three use roland test patient **12827**. Pick one of your made-up specialists each time.

### 5a. From TC (TC user)
1. On the 12827 case → **Referrals** → **New referral**.
   - Pick a specialist, write a reason, and set how soon.
   - **Save & submit**.
   - ✅ The row reads **Pending Dr. sign-off**.
2. Also try it **from the checkout sidebar**:
   - Open the Part 3 checkout in Done today (or a fresh one) → **Start referral**.
   - ✅ The chip moves **None → Pending Dr. sign-off**.

### 5b. From the hygiene visit (hygienist)
1. On the 12827 visit, press **Start referral** beside the tab switcher.
   - Pick a specialist, then enter a reason and teeth (e.g. #3).
   - **Send for Dr. sign-off**.
   - ✅ The badge reads "1 referral · Pending Dr. sign-off".
2. Note: a chairside referral is **not attached to a TC case**. It shows in the doctor's queue, but
   not on the case's Referrals panel. That is a known gap, logged in the C5 doc (finding D5).

### 5c. From a call (office or admin; this does NOT touch the chart)
1. Open **Calls**, pick a recent roland call, and match it to **12827** with **link only**.
   - "Link only" identifies the caller and writes nothing.
   - **Do not press Send to chart.**
2. On the call detail, press **Start referral**. Fill it in, then **Save & submit**.
   - ✅ It lands as Pending Dr. sign-off, listed under the button.
3. **Refusal check:** open an **unmatched** call.
   - ✅ There is **no** Start referral button.
4. **Pick the call deliberately.** The link stays on that call afterwards. On staging that is harmless,
   because a link writes nothing to the chart, but choose a call you don't mind leaving linked.

---

## Part 6: attachments (any referral surface)

Start a **new** referral (5a is easiest). In the dialog's upload zone, the hint reads
"**Press Win+Shift+S to snip the X-ray, then drag it here.**"

1. **Win+Shift+S**, snip anything, then **Ctrl+V** into the zone, or drag a PNG or PDF in.
   - ✅ It shows in the list with "N of 5 left".
2. Press **Save & submit**.
   - ✅ **Expected today:** the file is refused with "Attachment storage isn't set up here yet.
     Nothing was saved."
   - ✅ The referral is **kept as a draft**, and the message names the file. Nothing claims a
     success.
   - On the hygiene visit you also get a **Send for sign-off** button to finish it without the
     file.
3. **The client-side refusals work even without storage:**
   - ✅ A `.txt` file renamed `.png` is refused by the server for its contents (try once storage
     exists; today the storage refusal may answer first).
   - ✅ A file over 10 MB, or a sixth file, is refused before upload.
4. **Once the container exists** (re-walk this part later):
   - **View** opens the file in a new tab, and each view writes an audit row.
   - The doctor sees the file on the sign-off detail.

---

## Part 7: doctor sign-off (Doctor account)

1. Log in as the **Doctor**.
   - ✅ The **only** TC nav item is **Awaiting sign-off**, with a badge (it should count the
     referrals from Part 5).
   - ✅ A banner toast: "<test patient>'s referral is waiting for your sign-off".
2. Make sure the office picker is on **roland**, not All offices. On All offices the page asks you to
   pick one (finding D4).
3. Open the 5a referral. Check the reason, teeth, how soon and notes, then **Approve**.
   - ✅ "Approved. Ready to send — sending ships in a later update."
4. Open the 5b referral → **Decline** → reason "test" → **Decline referral**.
   - ✅ It leaves the queue.
5. **Back as TC:** the 5a row on the case now reads **Approved**. **Nothing was sent.**

---

## Part 8: the off-switch checks (admin)

### 8a. Valley was never switched on
Use valley test patient **7115 (Stedi TestValley)**.
1. **Hygienist:** open the **7115** visit in valley. This needs valley switched on in Platform → Hygiene; if it isn't, skip to step 2.
   - ✅ There is **no Alert checkout** and **no Start referral**.
   - Ordinary Send still behaves as hygiene always has. Only press it if you mean to walk the chart
     note on 7115.
2. **TC user, office valley:**
   - ✅ No **Checkout** nav item, and no Referrals panel on cases.
   - ✅ Settings has no Referrals section.

### 8b. Turn roland off, and everything goes dark without losing data
1. **Platform Console → TC referrals → roland OFF.**
   - ✅ **TC user:** the case's Referrals panel and the checkout sidebar's referral chip are gone,
     and Settings → Referrals is gone.
   - ✅ **Doctor:** **Awaiting sign-off** disappears from the nav.
   - ✅ **Hygienist:** **Start referral** is gone from the 12827 visit.
   - ✅ **Calls:** **Start referral** is gone from the matched call.
2. **Platform Console → TC checkout → roland OFF.**
   - ✅ **Checkout** leaves the nav, and the page says "Checkout isn't switched on for this office
     yet."
   - ✅ **Alert checkout** is gone from the 12827 visit, and a Send there makes no checkout.
   - ✅ The **Treatment from hygiene** panel and its attestations stay on the 12827 case. They
     belong to the case, not the switch.
3. **Turn both back ON for roland.**
   - ✅ The referrals from Part 5 and the checkouts from Part 3 are all still there, unchanged.

### 8c. Policy safety (admin, Settings → Referrals)
1. Turn **Doctor signs off** OFF, then try to turn **Send automatically once approved** ON.
   - ✅ It is refused, with the reason (sign-off off plus auto-send on is unsafe).
2. Turn **Doctor signs off** back **ON**.

---

## Part 9: the next morning (two minutes)
- **TC → Checkout → Waiting:**
  - ✅ yesterday's unanswered checkouts are gone. They expired automatically, and the audit shows
    the system did it, not a person.

---

## If something is off
For each problem, note:
- the part and step;
- the office and the PatNum (12827 or 7115 only);
- the exact on-screen words.

Do not copy patient details from any other chart into a note or screenshot.

## After the walk
The open decisions are in the C5 discovery doc (`docs/reports/feature-tc-incoming-work-ia.md`, PR #251):
- the consolidation option;
- whether checkout alerts fire outside TC;
- call-handoff ownership;
- the hygiene intake attach rule;
- names.

Referral sending (R5) stays on hold until you dispatch it.
