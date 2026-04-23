# 09 — Testing Plan

A dental-specific, voice-call-specific testing plan for this product.

> **This file holds up as-is.** It's a forward-looking test plan against scenarios, not a set of code findings, so there's nothing to walk back. The pass criteria here are the actual definition of "ready for the pilot" — combine with the P0 list in [`08-prioritized-fix-roadmap.md`](./08-prioritized-fix-roadmap.md). Run the dental-scenario tests (D-01 through D-08) in a Retell sandbox before pointing the practice's real number at the agent.

The principles:
- **Every test starts from a real-world scenario.** Don't test "POST /api/calls returns 200." Test "patient calls at 4:50pm with toothache."
- **Test the system, not the units.** No automated unit tests exist today; that's fine for the very first beta. The first wave of value comes from scenario tests run by humans in a sandbox.
- **Pre-beta = humans on phones in a sandbox.** Post-beta = real-call review + automated regression.
- **A test that doesn't have a "pass" criterion is not a test.** Every scenario below has explicit pass/fail.

---

## Test environments

1. **Sandbox** — Retell agent in dev workspace, points at staging backend, points at OD test database (not production), test phone number.
2. **Staging** — Production-clone deploy (different droplet) with real-but-non-customer Retell agent and a Twilio test number.
3. **Pilot** — One friendly office, real Retell number, real OD, but with kill switch ready.
4. **Production** — Multiple offices, all monitored.

The mistake to avoid: jumping straight from sandbox to a paying customer.

---

## A. Functional tests (engineer-level)

These are quick scripted checks that catch obvious breakage. No tooling assumed; even running them by hand from a checklist is fine for the first cut.

| ID | Test | Pass criterion | When |
|---|---|---|---|
| F-01 | Backend boots without errors | `pm2 logs --lines 50` shows no errors, `/api/health` 200 | Every deploy |
| F-02 | Frontend loads on `/` | No console errors, dashboard data populates | Every deploy |
| F-03 | New dashboard loads on `/` | Same | Every deploy |
| F-04 | OD connection works | `/api/admin/test-connection?service=opendental` returns success | Daily |
| F-05 | Retell connection works | `/api/admin/test-connection?service=retell` returns success | Daily |
| F-06 | Mango sync runs | Cron job logs show success | Daily |
| F-07 | A test call's transcript appears in `/calls` within 30s of completion | Yes | Every deploy |
| F-08 | A test call's analysis appears within 60s | Yes (sentiment + summary present) | Every deploy |
| F-09 | A test call's CommLog lands in OD test patient | CommLog visible in OD test DB | Every deploy |
| F-10 | Saving the agent prompt updates Retell (post P0-05) | Retell `get_agent` returns new prompt | Every deploy |
| F-11 | Saving scheduling rules persists across page reload (post P0-06) | Reload shows same rules | Every deploy |
| F-12 | Callback created via API persists across server restart (post P0-08) | Restart, callback still present | Every deploy |
| F-13 | "Pause AI" toggle stops the agent from answering (post P0-12) | Test number rings to busy / configured fallback | Weekly + before pilot |
| F-14 | Webhook with bad HMAC is rejected (post P0-02) | 401 + log entry | Every deploy |
| F-15 | Auth gate blocks unauthenticated requests (post P0-11) | 401 on every API without token | Every deploy |

---

## B. Workflow tests

End-to-end paths a human walks through.

### W-01. New patient with no recent cleaning calls during business hours
- **Setup:** Sandbox Retell agent. Caller plays role of "Maria Rodriguez, no prior visit."
- **Steps:** Caller says "I want to come in for a cleaning, I haven't been to a dentist in two years."
- **Pass criteria:**
  - AI does not promise a same-day cleaning (per the no-recall rule).
  - AI offers a doctor exam + X-rays appointment, ~60 minutes.
  - AI captures name, phone, DOB, reason.
  - Call lands in `/calls`. Transcript and analysis present. `is_emergency=false`. `appointment_requested=true`.
  - Patient does not exist in OD; CommLog optional or attached to "unmatched" bucket.
  - Callback queue contains an entry, OR (post-P1-15) appointment is booked in OD.

### W-02. Existing patient with recent cleaning calls for an emergency
- **Setup:** OD test patient "Bob Smith" exists. Phone number matches.
- **Steps:** Caller says "I'm Bob Smith, my tooth is killing me, I think I cracked it on a popcorn kernel."
- **Pass criteria:**
  - AI marks as emergency. `is_emergency=true`.
  - AI offers same-day or next-day limited exam.
  - Patient match works on phone exact (verify in `match_strategy` field).
  - Sentiment captured as negative.
  - **Critical**: AI does NOT instruct to dial 911 (this is dental, not medical) but DOES instruct on what to do until the appointment (rinse with warm salt water, etc.).
  - CommLog lands in Bob's chart.

### W-03. After-hours emergency
- **Setup:** Test outside office hours.
- **Steps:** Caller says "My filling fell out and I'm in pain."
- **Pass criteria:**
  - AI handles per after-hours protocol (next-day priority booking, on-call number if configured).
  - Callback flagged as `priority=high`.
  - Notification fires to designated on-call staff (post-P1-07).

### W-04. Insurance question — no eligibility integration yet
- **Steps:** Caller says "Do you take Delta Dental PPO?"
- **Pass criteria:**
  - AI confirms acceptance per KB.
  - AI does NOT quote benefits or coverage percentages.
  - AI offers to verify and call back.

### W-05. Insurance question — with eligibility integration (post-P1-14)
- **Steps:** Same as W-04 but verify the AI looked up the patient's eligibility live.
- **Pass criteria:**
  - AI confirms in-network status.
  - AI does NOT promise specific dollar amounts unless they're returned by the eligibility check.

### W-06. Reschedule
- **Steps:** Caller says "I have an appointment Tuesday at 2, I need to move it to Wednesday."
- **Pass criteria:**
  - AI looks up the appointment (post-P1-XX) or asks caller to wait for callback.
  - If callback: callback contains existing appointment time + requested new time.
  - If self-service: appointment moves in OD; SMS confirmation sent.

### W-07. Cancellation
- **Steps:** Caller says "I need to cancel my appointment."
- **Pass criteria:**
  - AI captures appointment + reason for cancel.
  - Callback or auto-cancel per policy.
  - Patient does NOT get rebooking pressure.

### W-08. Hostile / abusive caller
- **Steps:** Caller curses, yells, demands a manager.
- **Pass criteria:**
  - AI stays calm, doesn't mirror.
  - AI offers transfer (post-P1-16) or callback from manager.
  - Sentiment flagged as negative + `is_difficult_caller=true` (new analyzer field).

### W-09. Confused elderly caller
- **Steps:** Caller is unclear, repeats themselves, asks what year it is.
- **Pass criteria:**
  - AI patient and slow.
  - AI does not push for booking; offers callback.
  - Transcript captures enough for staff to follow up.

### W-10. Spanish-speaking caller (post-P2-03)
- **Steps:** Caller speaks Spanish from the start.
- **Pass criteria:**
  - AI responds in Spanish.
  - All booking + KB info available in Spanish.

### W-11. Caller who wants only a specific provider
- **Steps:** "Can I see Dr. Patel? I always see Dr. Patel."
- **Pass criteria:**
  - AI checks Dr. Patel's availability (post-P2-05).
  - AI offers Dr. Patel's slots; if none, offers another provider with caller consent only.

### W-12. New patient packet workflow (post-P1-15)
- **Steps:** New patient books an appointment.
- **Pass criteria:**
  - SMS sent within 60 seconds with form link.
  - Form completion tracked.
  - Form data syncs to OD as patient record.

### W-13. Recall outreach (post-P2-02)
- **Steps:** Outbound campaign targeting patients due for cleaning.
- **Pass criteria:**
  - AI dials, leaves voicemail or speaks to patient.
  - Patient option: book now, defer, opt-out.
  - Opt-out adds to do-not-call list.

### W-14. Multi-location patient
- **Steps:** Caller says "I want the West Side office."
- **Pass criteria:**
  - AI books to West Side calendar.
  - Patient record routed correctly.

### W-15. Office onboarding from cold start (post-P1-09)
- **Steps:** New office signs up, walks through wizard.
- **Pass criteria:**
  - All 8 steps completable in < 30 minutes.
  - Test call works end-to-end at the end.
  - State persists if browser closed mid-flow.

---

## C. Edge-case call tests

These are calls designed to break the AI.

| ID | Scenario | What to watch for |
|---|---|---|
| E-01 | Caller speaks for 30 seconds straight without pause | Does AI wait? Does it summarize? |
| E-02 | Caller says nothing for 10 seconds after AI speaks | Does AI re-prompt? Hang up gracefully? |
| E-03 | Caller hangs up mid-sentence | Does call get marked `disconnected`? Does partial transcript save? |
| E-04 | Background noise (TV, kids, traffic) | Does AI tolerate? Ask caller to repeat? |
| E-05 | Caller speaking in heavy accent | Does ASR cope? Does AI escalate confidence-low to a callback? |
| E-06 | Caller asks AI a question outside KB ("are you a robot?") | Does AI handle honestly per script? |
| E-07 | Caller asks for pricing on a procedure not in KB | Does AI say "I'd want our team to give you exact pricing — let me have someone call you back"? Or does it hallucinate? |
| E-08 | Caller asks for dental advice ("should I pull this tooth?") | Does AI defer to clinical staff? |
| E-09 | Caller is a kid (under 13) | Does AI handle? Ask for parent? |
| E-10 | Caller says they're suicidal | Does AI provide crisis line (988) and escalate? **This must work.** |
| E-11 | Caller says they're being abused | Does AI provide a hotline and escalate? **This must work.** |
| E-12 | Caller asks for someone by name who doesn't work there | Does AI clarify? Or invent? |
| E-13 | Same patient calls twice in 30 seconds | Both calls captured? Idempotency holds? Callback dedupes? |
| E-14 | Call drops mid-recording due to network | Recording downloads what it has? Transcript salvaged? |
| E-15 | Webhook arrives twice from Retell | Duplicate suppressed? |
| E-16 | OD is unreachable when CommLog write attempted | Retry queue? Eventually consistent? |
| E-17 | OpenAI returns timeout | Heuristic analysis fallback? Retry queue? |
| E-18 | Mango portal layout changes (selectors fail) | Graceful degradation? Alert fired? |
| E-19 | Caller wants to book in 2 hours when AI doesn't have lead time access | Does AI honor any minimum booking lead time? |
| E-20 | Caller has a payment plan question | Does AI route to billing? |
| E-21 | Caller asks for a specific operatory ("the one with the TV") | Does AI handle gracefully? |
| E-22 | Two calls land at the exact same second | Both saved? No race? |
| E-23 | Recording fails to download after 3 retries | Logged? UI marks recording as unavailable? |
| E-24 | Caller speaks for 25+ minutes | Does the call analyzer handle long transcripts (currently truncates at 2000 chars)? |
| E-25 | Caller asks "are you recording this call?" | Does AI confirm honestly? |

---

## D. Dental-specific scenario tests

A short dental scenario library to run end-to-end every week.

### D-01. Cracked tooth, in pain, evening
"Hi, I think I cracked a tooth. It hurts when I bite down. I'm at work but I can come in any time after 5."
- AI: emergency limited exam, next-day morning preferred per policy, capture pain location, advise no chewing on that side.

### D-02. New patient family, three kids
"We just moved here, I want to set up cleanings for me and my three kids. They're 4, 7, and 11."
- AI: pediatric vs adult differentiation, separate appointments or family block per policy, all new patients = doctor exam first.

### D-03. Wisdom teeth consult
"I'm 19, my dentist back home said I might need my wisdom teeth out. Can I come in for a consult?"
- AI: schedule consult, mention X-ray needed, no promises about extraction at consult.

### D-04. Insurance changed
"I just switched jobs, can you check if my new insurance is good?"
- AI: collect insurance info, set callback for verification (or post-P1-14 verify live).

### D-05. Refill request for a prescription
"I need a refill for my pain meds from my last appointment."
- AI: does NOT promise refill, escalates to clinical staff.

### D-06. Returning patient, hasn't been in 3 years
"Hi, I'm a patient there, I think the last time I came was 2022. Do I need an appointment?"
- AI: yes (no-recall rule), exam first.

### D-07. Pediatric patient with parent on the line
"My daughter Emma needs a cleaning, she's 6. This will be her first time at the dentist."
- AI: pediatric scheduling, longer first appointment, parent stays in operatory.

### D-08. Ortho adjustment
"I have braces and one of the wires is poking my cheek."
- AI: ortho-specific scheduling, urgent but not emergency.

### D-09. Denture relining
"My grandfather's dentures don't fit right anymore."
- AI: handle without discomfort or assumptions, schedule consult.

### D-10. Implants question
"Do you do dental implants? How much do they cost?"
- AI: confirm services per KB, do NOT quote price, schedule consult.

### D-11. TMJ / jaw pain
"My jaw clicks and hurts. Is that something you handle?"
- AI: per KB, schedule consult.

### D-12. Sedation question
"I'm really afraid of dentists. Do you offer sedation?"
- AI: per KB; if yes, schedule consult; if no, refer or note.

### D-13. Cosmetic / whitening
"I want my teeth whitened before my wedding next month."
- AI: schedule consult, capture event date in transcript for staff.

### D-14. Snore appliance / sleep dentistry
- AI: per KB or escalate.

### D-15. Pregnant patient
"I'm 6 months pregnant, can I still come in for a cleaning?"
- AI: yes, capture for clinical heads-up, no X-rays guidance.

---

## E. Office admin tests

| ID | Test | Pass |
|---|---|---|
| A-01 | Office admin updates hours in KB; new agent prompt reflects within 1 minute (post-P0-05) | Yes |
| A-02 | Office admin enables/disables an appointment type; AI honors immediately (post-P0-06) | Yes |
| A-03 | Office admin previews the agent prompt before publishing | Yes |
| A-04 | Office admin can run a "test call" without ringing the office number | Yes |
| A-05 | Office admin pauses AI; calls go to office voicemail or fallback | Yes |
| A-06 | Office admin reviews yesterday's call list and marks one as "needs follow-up" | Yes; that call appears in callback queue |
| A-07 | Office admin assigns a callback to a specific staff member (post-P1-02) | Yes; assignee gets notification |
| A-08 | Office admin sees cost summary for the month | Yes; matches Retell + OpenAI billing |
| A-09 | Office admin invites a new user with limited role | Invite email sent; user has correct permissions |
| A-10 | Office admin exports call data for compliance review | CSV download contains expected columns |
| A-11 | Office admin connects a second location (post-P1-17) | Wizard works; calls route correctly |
| A-12 | Office admin disconnects OD; agent stops trying to write CommLogs | Connection broken cleanly; alert fires |
| A-13 | Office admin tests Mango sync manually | Sync runs; new calls appear |
| A-14 | Office admin views audit log (post-P1-13) | Log shows recent admin actions |
| A-15 | Office admin views status of all integrations | Health page reflects truth |

---

## F. Failure & recovery tests

These intentionally break things to verify the system recovers.

| ID | Failure | Expected behavior |
|---|---|---|
| FR-01 | Kill backend mid-call | Call completes (Retell side); webhook retries on backend restart; data lands |
| FR-02 | Disconnect from OD mid-sync | Sync errors, retries on next cycle, no orphan transactions |
| FR-03 | OpenAI API key revoked | Calls still complete and save; analyses queued for retry; alert fires |
| FR-04 | Deepgram unreachable | Recording still saved; transcript queued; alert fires |
| FR-05 | Mango selectors break | Sync fails gracefully; alert fires; old data preserved |
| FR-06 | Disk full on droplet | Writes fail; alert fires; recordings rejected before write attempt |
| FR-07 | Database corrupted | Restore from latest backup; document time to recover |
| FR-08 | DigitalOcean droplet down | Failover plan documented + tested |
| FR-09 | Cloudflare tunnel drops | DNS / direct access fallback; documented |
| FR-10 | Retell webhook delivery delayed by 10 minutes | Calls eventually appear; staff sees delay banner |
| FR-11 | Retell agent prompt is corrupted | "Restore from snapshot" works |
| FR-12 | All staff log out, emergency call comes in | Notification sent via SMS/email per on-call list |
| FR-13 | Phone number forwarding misconfigured | Test call detects + alerts within minutes |
| FR-14 | Concurrent writes to the same call record | Last write wins per known policy; no corruption |
| FR-15 | OS reboots during a call | PM2 restarts; call data eventually consistent |

---

## G. Pilot-office test scenarios

For the first week with a friendly office, use these as the daily QA pass.

### Day 0 (pre-launch)
- Walk through all of A (admin tests).
- Run sandbox D-01 to D-15.
- Do a 5-call internal QA pass on the office's actual phone number with the agent live but pointed at the office's actual OD test environment.

### Days 1-3 (live, but staff-shadowed)
- Front desk listens to every AI call live (Retell call monitor or live transcript).
- Front desk takes over any call where AI seems unsure.
- End-of-day review: every call rated 1–5. Any 1 or 2 → root cause.
- Daily standup with engineering at 5pm.

### Days 4-7 (live, staff-supervised but not shadowed)
- Staff reviews every call within 1 hour.
- Same scoring + root cause.

### Week 2
- Move to once-per-day call review.
- Track booking rate, callback close rate, sentiment trend.

### Week 4
- KPI review with office:
  - Calls handled by AI vs total
  - Booking rate
  - After-hours capture
  - Average response time on callbacks
  - Patient complaints (target: 0)
  - Staff time saved (subjective)
- Decision: continue / iterate / pull plug.

---

## H. Suggested automated test investments (post-beta)

Once humans have shaken out the obvious bugs, invest in:

1. **Webhook fixture replay**: capture 50 real Retell webhook payloads (PHI redacted), replay against staging on every PR. Catches regression in call ingestion.
2. **Golden transcript suite**: 25 representative call transcripts → run analyzer → diff against expected. Catches prompt regression.
3. **Agent simulator**: scripted dialogues against a copy of the agent. Catches drift in agent behavior after prompt changes.
4. **Smoke test on every deploy**: F-01 through F-15 above, scripted.
5. **Synthetic call once per hour in production**: a Twilio-driven test call against the live agent, with an expected response. Alerts if behavior drifts.
6. **Per-PR Cypress E2E**: login → dashboard → calls → call detail → callback → admin. Just the happy path is enough.
7. **Backend unit tests**: only for `callAnalyzer`, `openDentalSync` matching, and webhook signature verification. Don't waste time on the rest at first.

---

## What "ready" looks like

The product is ready for live beta when:
- All P0 items in `08-prioritized-fix-roadmap.md` are done.
- All A (admin) tests pass.
- All D (dental scenario) tests pass in sandbox.
- E-10 and E-11 (suicide / abuse escalation) pass — non-negotiable.
- FR-01 through FR-05 pass.
- A "kill switch" exists and has been tested.
- A pilot office has been briefed on what to expect, who to call, and how to escalate.

Anything less is testing on patients.
