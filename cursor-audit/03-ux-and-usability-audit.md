# 03 — UX & Usability Audit

A usability audit through the eyes of a non-technical front desk team member, an office manager, and a dental practice owner.

> **Read this with [`11-evidence-and-confidence.md`](./11-evidence-and-confidence.md).** Confirmed UX-affecting bugs:
> - Agent Builder Save = `localStorage` only — `new-dashboard/client/src/pages/AgentBuilder.tsx:295-298`
> - Scheduling Rules Save = `toast.success` only — `new-dashboard/client/src/pages/Scheduling.tsx:279-281`
> - Callbacks queue seeded with fake patients — `backend/routes/callbacks.js:329`
>
> Other UX commentary in this file (legacy-vs-new dashboard friction, accessibility, mobile, time zones) is exploratory observation rather than a verified bug, and isn't on the P0 list in file 08.

---

## The biggest UX problem: there are two products

There is a legacy CRA frontend (`frontend/`, deployed at `159.89.82.167`) and a new Vite + shadcn dashboard (`new-dashboard/`, not deployed). They have **different navigation, different terminology, different visual language, and different feature sets**. The legacy one is what offices would see today. The new one is what's being demoed.

Until consolidation happens, every office training session has to cover "ignore this part of the legacy UI, those features moved." That is the worst possible onboarding state.

**Recommendation:** pick one (clearly the new dashboard — it's better designed and more dental-aware). Put the legacy one in maintenance mode. Add a banner. Don't ship anything new to the legacy one.

The rest of this audit assumes the new dashboard is the target.

---

## Page-by-page usability findings

### Dashboard (`/`) — `pages/Dashboard.tsx`

**What works:**
- Clean stats grid with color-coded cards.
- Real data, with sensible empty states ("—", "No data").
- The "urgent" ring on the Pending Callbacks card when high-priority callbacks exist is a nice trust signal.
- Click-through from a callback or recent call into detail.

**What breaks:**

1. **"Good morning" is hardcoded.** [`Dashboard.tsx:127`](../new-dashboard/client/src/pages/Dashboard.tsx). At 8pm it still says "Good morning." This is exactly the kind of small thing that erodes "this product cares" feeling.
2. **The hourly chart only shows 8am–5pm** ([`Dashboard.tsx:48-55`](../new-dashboard/client/src/pages/Dashboard.tsx)). After-hours calls are invisible. For a dental office that wants to know "did the AI catch our after-hours call traffic?" — the answer is hidden.
3. **No alerting on bad days.** If 30% of today's calls were missed or transferred, no badge, no banner. The dashboard treats a great day and a disastrous day with the same visual weight.
4. **"AI Handled %" is misleading.** Source-based, not outcome-based. A 4-second call that failed and went to voicemail still counts as "AI handled." A real metric would be "AI completed without escalation" or "AI booked the appointment."
5. **No system status banner.** If Open Dental sync hasn't run in 6 hours, or Mango is logged out, or OpenAI is over quota, the Dashboard doesn't surface it. You only find out by clicking into Admin → Integrations.
6. **"Today's Schedule" caps at 6** with a "+N more" link. For a busy office with 60 appointments today, this is a 5-second tease that adds nothing.
7. **Refresh button uses `setLastRefresh(new Date())`** which retriggers the effect — fine, but there's no "auto-refresh every N seconds" affordance, so staff must click manually all day.
8. **The chart uses Recharts but no `aria-label` or text alternative.** Anyone using a screen reader gets nothing.

### Calls (`/calls`) — `pages/Calls.tsx`

**What works:**
- Tabbed view (Calls + Callbacks) reduces nav.
- Source badge (AI / Mango), status pills, sentiment dots are visually clean.
- Last-utterance preview ([`getTranscriptPreview()`](../new-dashboard/client/src/pages/Calls.tsx)) gives quick context without opening detail.
- Search and filters are responsive.

**What breaks:**

1. **No bulk actions.** Can't multi-select calls to mark them "reviewed", export to CSV, or assign to a staff member. For a 100-call day, this is painful.
2. **No "needs review" queue.** A staff member can't easily see "which calls had no patient match, no callback created, and the AI flagged appointment_requested = true." That's the single most useful filter for a front desk.
3. **The Sync button** is global and lacks confirmation. Click it accidentally and it triggers a Retell sync of up to 50 calls (potentially expensive and noisy). No "are you sure" guard.
4. **Mango calls without recordings** show without a clear visual indicator. Staff click expecting audio and get nothing.
5. **No call counts** ("Showing 24 of 137 calls") makes it hard to know if a filter is hiding what you want.
6. **The transcript view in CallDetail** (separate page) is a wall of `[Speaker]: text` lines. There's no:
   - Highlighting of patient PII (name, DOB, phone, insurance) for quick scan.
   - Highlighting of appointment-related sentences.
   - Jump-to-time from a transcript line to the audio.
   - Side-by-side AI analysis ("This call was about X, sentiment Y, action needed Z").
7. **No way to redact a transcript** before sharing with another staff member or printing for a chart note.

### Callbacks tab — `Calls.tsx` (callbacks tab)

**What works:**
- Priority filter (high/medium/low/emergency).
- Status pills.
- Attempt counter shown.

**What breaks:**

1. **Sample data appears mixed in with real data.** Every server restart re-seeds "John Smith / Sarah Johnson / Mike Davis / Emily Brown" callbacks ([`backend/routes/callbacks.js:261-326`](../backend/routes/callbacks.js)). A real office staring at this list cannot tell which callbacks are real.
2. **No assignment.** "Assigned to" field exists in the data model but no UI to pick a person.
3. **No "snooze" or "reschedule callback time".** If a callback is due now but the staff is mid-task, they can either complete it, fail it, or ignore it.
4. **No SLA color-coding.** An overdue emergency callback should be visually different from an overdue low-priority one. They're not.
5. **No notification.** A new emergency callback arrives via webhook → it lands in the queue → the office's UI doesn't beep, doesn't vibrate, doesn't badge a tab.
6. **Failure after 3 attempts is silent.** Code marks `status: 'failed'` after 3 no-answers ([`callbacks.js:201`](../backend/routes/callbacks.js)) but no escalation, no reassignment.
7. **The "Add Callback" path in the UI is missing.** Staff cannot manually create a callback for a walk-in or an email lead.

### Scheduling — Rules tab — `pages/Scheduling.tsx`

**What works:**
- The rules taxonomy is *good*. It distinguishes new vs existing patient, recall vs no-recall, hygienist vs doctor, child vs adult, emergency, ortho.
- Toggle pattern is familiar.
- Per-rule duration and provider type badges.

**What breaks (badly):**

1. **The "Save Rules" button is theatre.** It calls `toast.success("Scheduling rules saved")` and persists nothing. ([`Scheduling.tsx:279`](../new-dashboard/client/src/pages/Scheduling.tsx)). An office that toggles rules thinking they've changed AI behavior is being lied to.
2. **All rules reset on page reload** because state is a `useState(DEFAULT_*)` with no `localStorage` and no API.
3. **No validation.** Two rules can be enabled with conflicting durations and providers; no warning.
4. **No preview.** "If I enable buffer time, what does my AI now do?" — no answer in the UI.
5. **No way to add a custom appointment type.** Real offices have things like "implant consult", "denture try-in", "perio maintenance". The hardcoded 7 types are not extensible.
6. **No per-day-of-week scheduling rules.** Offices have different rules on Fridays. No place to express that.
7. **No per-provider override.** "Dr. Sparkman doesn't see ortho on Mondays" cannot be expressed.

### Scheduling — OD Calendar tab — `pages/Scheduling.tsx`

**What works:**
- The calendar feature was refactored well. Provider filter, date picker, drawer for appointment detail.
- Real Open Dental data when the bridge is up.

**What breaks:**

1. **Read-only.** Staff cannot move, cancel, reschedule, or annotate appointments without leaving the dashboard.
2. **Error message is unhelpful**: "Open Dental unavailable. Ensure the backend is running and Open Dental is configured." A non-technical person doesn't know what to do with this.
3. **No operatory grouping.** Just provider columns. Real offices think operatory-first ("op 3 has the laser").
4. **No "drag to reschedule"** even visually.
5. **No view of provider lunch breaks, blocks, or PTO** — anything from OD's `Schedule` table.
6. **No diff view between "what AI booked" and "what staff confirmed."**

### Agent Builder (`/agents`) — `pages/AgentBuilder.tsx`

**What works:**
- The IA is good: split between "personality/prompt" (left) and "knowledge base" (right).
- Templates (Inbound Scheduling, Emergency Triage, New Patient Welcome, Recall Reminder) are dental-literate starter prompts.
- Knowledge base sections have realistic placeholders (hours, locations, providers, services, insurance, policies).
- Compiled-prompt preview shows what the AI will see.
- Word count + "filled" badges give progress signal.

**What breaks (catastrophically):**

1. **"Save" writes only to `localStorage`** ([`AgentBuilder.tsx:295-301`](../new-dashboard/client/src/pages/AgentBuilder.tsx)). A different browser, a different staff member, or just clearing site data → all configuration is gone.
2. **No backend route receives this.** No `POST /api/agents/:id` that updates Retell. Configuring the agent here does not change the AI.
3. **The "Copy Prompt" button is the actual production workflow.** A staff member is expected to copy the compiled prompt, log into Retell, paste it into the right agent, and save it. There is no documentation telling them this. There is no link to Retell. There is no warning "this isn't actually live yet."
4. **No multi-agent management.** One config slot. Real offices need different agents per scenario (inbound, after-hours, recall, billing handoff) and the UI doesn't show that they're managing multiple.
5. **No version history / revert.** Edit the prompt badly, save, leave the page → the previous prompt is gone.
6. **No "test this agent" surface.** Even fake — there's no "type a caller utterance and see what it would say" sandbox.
7. **No collaborative editing.** Two staff editing simultaneously in different browsers will overwrite each other (and neither will affect anything real).
8. **No template diff.** Loading "Recall Reminder" wipes the user's current prompt with no warning.
9. **Knowledge base placeholders include real Valley/Roland data.** That looks polished in a demo but for office #2 it's confusing — they see another practice's example data.
10. **Custom sections** can be added but their titles are free-form, so nothing constrains them and the prompt just becomes "## Random Office Section" which the AI may or may not respect.

### Admin (`/admin`) — `pages/Admin.tsx`

**What works:**
- Real status data from `/api/admin/health`, `/api/admin/config`, `/api/admin/costs`.
- Per-integration "Test Connection" button.
- Cost tracking surfaced (Deepgram, OpenAI). For a SaaS this is unusually transparent.

**What breaks:**

1. **"Offices" and "Users" tabs are stubs.** A SaaS admin without users or offices is an admin for one tenant.
2. **No way to enter credentials.** Test Connection only verifies env vars set on the droplet.
3. **No audit log of actions** (who started/stopped sync, who tested what).
4. **"Test Connection" for Mango spawns Puppeteer.** No throttling, no rate limit. Easy footgun.
5. **Cost data shows lifetime totals** rather than month-to-date. For a billing decision, MTD matters more.
6. **No alerting threshold.** Ops can't say "alert me if today's call volume is 3× the average" or "alert if Mango sync hasn't completed in 2 hours."
7. **Sync controls (start/stop scheduler, manual sync)** are global with no confirmation. One stray click stops syncs for everyone.

### Analytics (`/analytics`)

(Read separately; the surface exists but is mostly chart-rendering of `/api/analytics/summary`.)

**What breaks:**
- Generic SaaS-style charts (volume over time, sentiment breakdown).
- No dental-specific metrics: appointment booking rate, new patient capture rate, recall completion rate, after-hours capture rate, average wait-for-callback time.
- No cohort analysis (week vs week, month vs month).
- No drill-down (click a bar → see the calls that made it up).

---

## Cross-cutting UX problems

### 1. No "what is happening right now"
Live calls show on the legacy `/live` page but not on the new dashboard. An office's primary screen of interest is "is the AI on a call right now and is it going okay?" — the new dashboard does not surface this at all.

### 2. No system status visibility
There is no global "all systems operational / degraded / down" badge anywhere. The Admin page has it, but a non-admin staff member never sees it. When the AI is broken at 9am Monday, the office finds out from a missed-call complaint, not from the product.

### 3. No notification system
Nothing pings the office for new high-priority callbacks, AI failures, OD disconnects, missed-call surges. The product is purely pull-based.

### 4. No mobile/tablet design intent
The screens are responsive (Tailwind grid breakpoints), but there's no offline mode, no touch-optimized control sizes for a busy front desk on a tablet, no PWA install prompt, no mobile push for callbacks. Real front desks live on tablets and headsets.

### 5. No accessibility intent
- No ARIA labels on icon-only buttons.
- Color is the only signal for many states (sentiment dots, priority dots).
- No keyboard shortcut documentation.
- No focus rings consistently styled.
- Light mode only by default, dark mode toggle exists but isn't tested for contrast.

### 6. Time zones
The app uses `new Date().toISOString()` and `toLocaleTimeString()` everywhere. There is no concept of office time zone. An office in Pacific time looking at appointments will see times that may or may not be in their zone depending on browser locale. For a dental SaaS, this is a known foot-gun.

### 7. Loading states are inconsistent
Some pages use a spinner, some use "—", some use skeleton cards, some show stale data while loading. The grammar of loading is inconsistent.

### 8. Error states are inconsistent
- Some failures fall back to mock data silently (legacy frontend).
- Some show a red banner.
- Some show a yellow banner.
- Some toast briefly and disappear.
- A staff member never knows the rules.

### 9. Empty states are weak
"No callbacks pending" — fine. But no "next best action" — when there are no callbacks, what should staff be doing? A premium product would suggest reviewing recent transcripts, confirming tomorrow's appointments, etc.

### 10. Confirmation dialogs are missing where they should exist
- "Reset agent config" → has a `window.confirm()` (good).
- "Sync Retell" → no confirmation (bad — costs money, takes time).
- "Stop sync scheduler" → no confirmation (bad — stops production sync globally).
- "Delete callback" → no confirmation (bad — irreversible, no undo).

### 11. Confirmation dialogs use `window.confirm()`
This is a 1990s alert. A premium SaaS uses a modal dialog with a clearly-labeled destructive action and a focus-trapped escape.

### 12. No undo anywhere
Edit the agent prompt badly → no undo. Delete a callback → no undo. Reset the agent → no undo.

### 13. No keyboard shortcuts
For a power user spending hours in the product, no `g d` (go dashboard), no `/` (focus search), no `?` (show shortcuts).

### 14. No search across the product
Calls have search. Nothing else does.

### 15. No documentation surfaces in-product
There is no "?", no help link, no tooltip with "what does this mean", no link to a how-to. The office is on its own.

### 16. Terminology drift
- "CommLog" appears in code. A dental staff knows what this means. The UI calls it nothing — these things are written silently.
- "Operatory" vs "op" vs "room" — inconsistent.
- "Patient" vs "caller" vs "lead" — used somewhat interchangeably.

### 17. The "Reset" button in Agent Builder is dangerous
[`AgentBuilder.tsx:346-348`](../new-dashboard/client/src/pages/AgentBuilder.tsx) — top-right, same row as Save. One mis-click and the entire prompt + knowledge base wipe to defaults. The confirm dialog is the only guard.

### 18. The sidebar nav is minimal but sometimes unclear
"Agents" → goes to Agent Builder. Plural label, singular surface. Office staff might expect a list of agents to manage. They get a builder for one.

### 19. No multi-window safety
Two tabs open on Agent Builder, both loaded the same config from `localStorage`, both edit, both save → second-saver wins. No conflict detection.

### 20. The "preview" mode in Agent Builder
Toggles the right panel between editor and preview. But the preview is just the compiled prompt as text. There's no preview of "how the AI would say this" or "what the first turn would sound like." For a dental office worried about how the AI sounds, this is the most important missing feature in the entire product.

---

## Prioritized usability fixes

### Tier 1: Stop trust-damaging behavior (do before any real office sees the product)
1. Remove sample callbacks from production seeding.
2. Remove the "Save Rules" button (or make it actually save) — fake save is worse than no save.
3. Remove the "Save" button on Agent Builder until it pushes to Retell — same logic.
4. Add a global "system status" banner.
5. Add a confirmation dialog before global sync/admin actions.

### Tier 2: High-friction daily-use fixes (do before beta)
6. Make the Dashboard the live-call view — staff want to see the active call.
7. Add notifications (sound + badge + email) for emergency callbacks.
8. Add a "needs review" queue for unmatched calls and `appointment_requested = true` calls.
9. Add bulk actions and CSV export to the Calls tab.
10. Make the AgentBuilder save to a persistent backend that pushes to Retell.

### Tier 3: Premium-feel polish (do before sale)
11. Time zone awareness throughout.
12. Mobile/tablet-optimized controls.
13. Accessibility pass.
14. Keyboard shortcuts.
15. In-product help and onboarding tour.
16. Undo for destructive actions.
17. Real loading/empty/error grammar (one pattern, used everywhere).

A dental office will judge the product in the first 10 minutes by whether the demo feels like a tool that has its act together. Right now, the screens look polished but several of the most important interactions are theatrical. That gap — polish without follow-through — is the fastest way to lose trust with operators who will look up from the dashboard the moment a real patient call goes wrong and ask "wait, did the AI know our hours? Did we tell it that?" — and find out the answer is "no, because none of that ever saved."
