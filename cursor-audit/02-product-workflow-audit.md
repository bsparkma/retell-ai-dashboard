# 02 — Product & Workflow Audit

A workflow-by-workflow assessment of what the product actually does versus what a real dental office would need it to do.

> **Read this with [`11-evidence-and-confidence.md`](./11-evidence-and-confidence.md).** That file is the authoritative version. Where this file makes a claim that isn't restated in file 11, treat it as exploratory. Specifically:
> - The Open Dental tools (`bookAppointment`, `findAlternativeTimeSlots`, `searchPatients`, etc.) **do exist as backend code** — see Correction D in file 11. The gap is the agent doesn't call them, not that they're missing.
> - "Office uses two products forever" is opinion, removed.
> - Anything framed as "best-in-class does X" without a corresponding gap in this codebase has been removed from the roadmap (file 08); the framing remains here for context only.

---

## The five workflows that exist

I found five distinct user journeys in the codebase. Each is at a different level of completeness.

| Workflow | Surface | Backend reality | Status |
|---|---|---|---|
| **A. Admin setup** | `Admin.tsx` integrations tab + `.env` files on droplet | Real (read-only health, test-connection, real configs) | Partly works |
| **B. Office onboarding** | None | None | **Does not exist** |
| **C. Caller / patient flow** (live AI call) | Configured in Retell, not in this app | Webhook → live monitor → store → OD commlog | Works |
| **D. Team review flow** (calls, callbacks, calendar) | `Calls.tsx`, `Dashboard.tsx`, `Scheduling.tsx (calendar tab)` | Real reads from Retell + Mango + OD | Works for one office |
| **E. Post-call workflow** (callbacks, follow-up) | `Calls.tsx (callbacks tab)`, `Dashboard.tsx` | Routes exist, in-memory only, seeded with fake data | Half-built |

Two crucial workflows are missing:
- **Office configuration** — agent persona, scheduling rules, knowledge base. The UI exists; the persistence does not.
- **Office onboarding** — there is no flow to bring a new office onto the platform.

---

## A. Admin setup workflow

### What the office sees
The "Admin" page ([`new-dashboard/client/src/pages/Admin.tsx:95-`](../new-dashboard/client/src/pages/Admin.tsx)) shows four tabs: Offices, Users, Integrations, Settings. Only Integrations is wired up. It pulls from real backend endpoints:
- `GET /api/admin/health` — service status (Retell, Open Dental, Mango, Deepgram, OpenAI)
- `GET /api/admin/config` — sanitized config (no secrets)
- `GET /api/admin/costs` — Deepgram + OpenAI token spend
- `POST /api/admin/test-connection` — pings each integration

### Where it breaks
1. **"Offices" and "Users" tabs are stubs.** A SaaS product where you can't add an office or a user is not a SaaS product.
2. **No integration *setup* flow.** You can test if Retell/OpenDental/Mango is connected, but you can't enter credentials through the UI. Every key is a `.env` line on the droplet that someone has to SSH in to set.
3. **Mango Voice login uses a single shared scraper credential** (`backend/config/mango.js`). There's no way to add multi-office Mango accounts.
4. **`POST /api/admin/test-connection` for `mango`** ([`backend/routes/admin.js:291-298`](../backend/routes/admin.js)) initializes a Puppeteer browser and logs in. From a UI button. With no auth. Anyone hitting that endpoint can spawn Chrome on the droplet.
5. **No audit log of admin actions.** If someone clicks "stop sync scheduler" ([`POST /api/admin/sync/stop`](../backend/routes/admin.js)), there's no record of who did it or when.

### Real-office friction
- An office manager who doesn't know what "Retell" or "Deepgram" is will see five integration cards labeled with vendor names and no plain-English explanation of what to do if one is red.
- The "Test Connection" button is the only diagnostic tool. There's no "what to fix" guidance when it fails.

---

## B. Office onboarding workflow

**This workflow does not exist.** I searched for any "create office", "first run setup", "wizard", "onboarding", or "office settings" surface. None exist.

What's there instead:
- A `setup.sh` script ([`setup.sh`](../setup.sh)) that installs npm deps, writes a `.env` with the leaked Retell key, and `pm2 start` the backend. This is a developer setup, not an office setup.
- A hardcoded office name ("Valley Family Dental / Roland Family Dental") shown in placeholder text in [`AgentBuilder.tsx:51`](../new-dashboard/client/src/pages/AgentBuilder.tsx).
- No record of "who is this office", "which Retell agent ID maps to them", "which Open Dental DB connection is theirs", "which Mango account is theirs."

### What a real office needs (and doesn't get)
1. Practice name, addresses, phone numbers, NPIs, time zone.
2. Office hours per day (the AI needs these to handle after-hours).
3. Provider list (doctors, hygienists) with schedules.
4. Operatory list with what each room is used for.
5. Insurance accepted.
6. Default appointment durations per type.
7. Which Open Dental instance to talk to and how (DB credentials or API tokens).
8. Which Retell agent to use for inbound calls.
9. Which phone numbers route to AI vs to humans.
10. Emergency overflow — where do critical callbacks go after hours? Which staff phone? Which on-call rotation?
11. A "test mode" / sandbox where you can place a fake call and see the whole pipeline run without it touching the real OD.

None of this exists in any form. The product implicitly assumes a developer hand-configures every office on the droplet.

---

## C. Caller / patient flow

This is the workflow that actually works. The flow:

1. Caller dials the number routed to Retell.
2. Retell answers using the agent configured **in the Retell dashboard** (not in this app).
3. Retell streams webhook events to `POST /api/webhooks/retell`:
   - `call_started` → `liveCallManager.addCall()` → Socket.IO emit `call:started`
   - `call_analyzed` / `call_ended` → unified store gets the final record + analyzer + Open Dental commlog
4. The legacy frontend `/live` page shows the active call with a live transcript stream.
5. After the call, OpenAI extracts caller name, call reason, sentiment, emergency flag, appointment_requested, callback_needed.
6. If matched to an Open Dental patient, a CommLog entry is written.

### Where it breaks
1. **The Retell agent is configured outside this product.** The `/agents` page in the new dashboard is theatre. There is no link between what the office configures in the UI and what Retell actually says on the call. This is the single most misleading thing in the product.
2. **The agent prompt template references `{{office_name}}` and `{{knowledge_base}}`** ([`AgentBuilder.tsx:84`](../new-dashboard/client/src/pages/AgentBuilder.tsx)) but no code path actually substitutes those variables and pushes them to Retell. The "Copy Prompt" button is the only export — you'd have to paste it into Retell's UI by hand.
3. **No way to know which Retell agent ID maps to which office.** With one office it works by coincidence. With two offices, a call to Office B could trigger Office A's commlog write.
4. **Webhook signature verification is bypassed in dev** ([`backend/routes/webhooks.js`](../backend/routes/webhooks.js): `if (process.env.NODE_ENV !== 'production') return true;`). And in production the signature uses `JSON.stringify(req.body)` which is non-canonical and likely not byte-equivalent to what Retell signs.
5. **No emergency handoff to a human.** If the caller has an emergency, the prompt says "I understand you're in pain. Let me get you in right away" and offers an emergency slot. It doesn't ring the on-call phone, doesn't text the doctor, doesn't initiate a 3-way transfer. It just books an appointment.
6. **No after-hours behavior is defined in code.** Whether the AI takes after-hours calls and how it handles "this is a true emergency" is entirely up to whatever's in the Retell agent prompt — which lives outside this codebase.
7. **No "give me a real person" path.** The only escalation in the data model is "create a callback", which is in-memory and resets nightly.
8. **The transcript shown to staff includes everything the patient said, including PHI.** Then it's shipped to OpenAI for analysis. There is no redaction layer.

### Real-office breakage
- A patient says "I'm bleeding from my mouth right now, this isn't stopping." The AI books them for "60 min limited emergency exam tomorrow at 9am." Nobody is alerted.
- A patient says "Can you transfer me to Sarah?" The AI cannot. It says "let me have someone call you back" and creates a callback that disappears at the next deploy.
- A patient says "My insurance is through Cigna, do you take that?" The AI's only knowledge is what's in the (currently empty) knowledge base. With Knowledge Base unconfigured, it will hallucinate or punt.

---

## D. Team review workflow

This is the second workflow that actually works. Three real surfaces:

### `/calls` — Unified Call Log + Callbacks tabs
[`new-dashboard/client/src/pages/Calls.tsx`](../new-dashboard/client/src/pages/Calls.tsx)
- Tab 1: Searchable, filterable list of all calls (Retell + Mango). Source filter, status filter, search by caller/intent.
- Tab 2: Callback queue with priority and status filters.

What works:
- Real reads from `/api/unified/calls`. Search and filters work.
- Click-through to call detail with transcript and audio.
- Sync button manually triggers Retell sync.

What breaks:
- The callback tab is fed by [`/api/callbacks`](../backend/routes/callbacks.js) which is in-memory and seeded with fake "John Smith / Sarah Johnson" data on every restart. **A real office's callback list is mixed with sample data.**
- No way to assign a callback to a specific staff member. The `assigned_to` field exists in the data model but there's no UI for it and no users to assign to.
- No notification when a new high-priority callback arrives. The dashboard shows a count but doesn't ring a bell, doesn't email, doesn't text.
- Audio playback for Mango calls depends on the recording having been successfully scraped from the portal — a Puppeteer flow that's known-fragile.
- The transcript view doesn't surface the AI's structured analysis (sentiment, emergency, appointment_requested) prominently. Staff have to read the full transcript to find what matters.

### `/` — Dashboard / Home page
[`new-dashboard/client/src/pages/Dashboard.tsx`](../new-dashboard/client/src/pages/Dashboard.tsx)
- "Good morning" header, hourly call volume chart, today's appointments from Open Dental, recent calls list, callback queue.

What works:
- Pulls today's appointments from `/api/opendental/calendar`.
- Pulls call volume from `/api/analytics/summary`.
- Live counts of pending callbacks and unconfirmed appointments.

What breaks:
- "Good morning" is hardcoded — at 11pm it still says "Good morning."
- The call volume chart only shows hours 8am–5pm (line 53–55), so any after-hours calls are invisible.
- "Today's Schedule" shows up to 6 appointments and says "+N more". There's no way to see the full schedule from the dashboard.
- "AI Handled" calculates as `(retell calls / total calls)` regardless of intent. A 4-second hangup-on-AI counts as "AI handled."
- No alerts for unusual conditions. If 30% of today's calls were missed, the dashboard doesn't surface that.

### `/scheduling` (Calendar tab) — Open Dental Calendar
[`new-dashboard/client/src/pages/Scheduling.tsx:292-326`](../new-dashboard/client/src/pages/Scheduling.tsx)
- Wraps the existing calendar feature. Provider filter, date picker, day view of operatories.

What works:
- Real read of Open Dental appointments.
- Provider filter. Drawer with appointment detail.

What breaks:
- It is read-only. Staff cannot move appointments, cancel them, or add notes from the dashboard. They have to open Open Dental separately.
- Error path: if Open Dental is unavailable, the user sees a yellow banner saying "Open Dental unavailable. Ensure the backend is running and Open Dental is configured." That message is confusing — the backend probably *is* running; the OD bridge or DB connection is the problem.

---

## E. Post-call workflow

The post-call sequence in the backend:
1. Webhook `call_ended` arrives.
2. `unifiedCallStore.addRetellCall()` persists the call to `data/unified_calls.json`.
3. `callAnalyzer.analyzeCall(call)` calls OpenAI to extract structured fields.
4. `openDentalSyncService.matchCallToPatient()` runs three strategies (phone exact, name+phone, name fuzzy) to find a patient.
5. If matched, a CommLog entry is created in Open Dental.
6. The Socket.IO room is notified.

### Where it breaks
1. **No "approve before write" gate.** The CommLog is written automatically based on a fuzzy match. If the match is wrong, you get a CommLog on the wrong patient's chart. There's no human-in-the-loop.
2. **Match confidence threshold is 0.7** ([`openDentalSync.js:49`](../backend/services/openDentalSync.js)). At that level, two patients with the same first name and similar phone area codes can collide.
3. **No queue for unmatched calls.** If the call doesn't match anyone, the analysis is stored but there's no UI list of "calls that need a patient assigned." Staff have to scroll through the call log to find them.
4. **No way to attach the call to a different patient after the fact.** Once the matcher decides, there's no UI to override.
5. **No "task" model.** When the analyzer says `appointment_requested: true`, that's not turned into anything actionable. It's a field on a call record. The team is expected to read every call and decide.
6. **No follow-up rules per call reason.** "Insurance question" → no automated action. "Billing question" → no automated action. "Lost filling" → no automated action. The product captures rich structured data and then doesn't act on it.

---

## Workflow gaps that hurt dental teams specifically

These are the dental-specific things that a generic SaaS playbook would miss:

1. **No "new patient packet" flow.** When the AI books a new patient, the prompt template says "we'll email you our new patient forms" — but there's no integration that actually emails the forms.
2. **No insurance verification path.** The AI can take an insurance carrier name but there's no eligibility check (Stedi, Vyne, manual verification queue, nothing).
3. **No recall list integration.** The "Recall Reminder" template exists for outbound calls, but there's no UI to upload or pull a recall list, and the system is inbound-only architecturally.
4. **Hygienist vs doctor scheduling is a UI label only.** The `Scheduling.tsx` rules tag appointments with `providerTypes: ["Hygienist"]` or `["Doctor"]`, but there's no code that uses this to find an appropriate provider's column in OD when booking. The AI cannot actually book intelligently against operatory/provider availability.
5. **Pediatric vs adult differentiation exists in rules** (30 min for child cleaning, 60 for adult) but again — no enforcement.
6. **Multi-location is unsupported.** The placeholder in the knowledge base shows "Valley Family Dental + Roland Family Dental." There is no code that lets the AI ask "which location?" or routes a call to one location's calendar vs another's.
7. **Operatory-aware booking is not implemented.** The AI cannot know that op #3 has the panoramic X-ray and op #5 has nitrous, and book accordingly.
8. **No 24-hour-before-appointment confirmation flow.** The dashboard shows "unconfirmed appointments" but there's no automated text/call to confirm them.
9. **No no-show tracking and no "fee after 2nd no-show" enforcement** despite that being baked into the default policy text.
10. **No multi-language support.** A meaningful chunk of dental patients in the US speak Spanish first. The agent prompt and the knowledge base are English-only and there's no Spanish path.
11. **No "this caller is a known difficult patient" surfacing.** No flag from OD comes through.
12. **No way to mark a caller as "do not call" or "do not schedule with AI."**

---

## Summary

The two workflows that work (caller flow, team review flow) are real and valuable. The two workflows that should be the heart of a dental SaaS product (office configuration, office onboarding) are missing or fake. The post-call workflow captures rich data and then doesn't do anything with it.

A dental office buying this product would expect that "the AI we configured" is the AI that talks to their patients, that scheduling rules they save will be enforced, that a callback they create today will still be there tomorrow, and that booking a new patient triggers a packet. Today, none of those expectations hold. Fixing them is the difference between a demo and a product.
