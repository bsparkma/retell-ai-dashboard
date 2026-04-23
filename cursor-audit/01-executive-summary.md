# 01 — Executive Summary (revised)

> **Status update — Phases A → B → C complete.**
>
> The audit below was the original, pre-fix snapshot. Most P0 items have
> shipped. Updated readiness ratings and the new "you are here" picture
> are in **§0 below**; the rest of the document is preserved as the
> historical baseline so the diff is auditable.
>
> - File 08 (roadmap) shows ✅ next to every shipped item.
> - File 11 (evidence) is unchanged — the original evidence still stands.
> - File 12 (verification checklist) is the ops-side gate that has not
>   yet been completed by a human.

A blunt, evidence-anchored assessment of the CareIN dental voice AI platform. Every major claim below carries a confidence tag and points to file:line evidence. The full classification table is in [`11-evidence-and-confidence.md`](./11-evidence-and-confidence.md). The roadmap to fix is in [`08-prioritized-fix-roadmap.md`](./08-prioritized-fix-roadmap.md).

---

## 0. Where we are now (post-fix)

### Updated readiness ratings

| Question | Was | Now | What changed |
|---|---|---|---|
| **Internal QA?** | 🟡 Yellow | 🟢 Green (modulo a manual QA pass) | Save buttons are honest, dashboard auth is on, persistence is atomic, QA runbook is in `13-qa-pass-procedure.md`. |
| **Live beta in a dental office?** | 🔴 Red | 🟡 Yellow → Green after the **`12-verification-checklist.md`** items are signed off by ops | Webhook HMAC verified, callbacks persist, Agent Builder publishes to Retell, recording disclosure + 911 directive in default prompt, pilot setup doc shipped. The remaining gates are key rotation, BAA, disk encryption, and the LK-01 / LK-02 verification scripts. |
| **Production deployment?** | 🔴 Red | 🟡 Yellow | Bearer-token auth on every `/api/*`, Socket.IO auth, atomic JSON persistence, PM2 entry fixed, leaked key scrubbed code-side. The single hardcoded production domain remains, and there is still no formal HA / monitoring story. |
| **Sell to multiple offices?** | 🔴 Red | 🔴 Red (unchanged) | Multi-tenant work was deliberately deferred; not in scope for the first pilot. |

### What shipped in this round

- **Security:** Retell HMAC verification rewritten to spec, dashboard
  bearer-token middleware on all `/api/*` and Socket.IO, leaked key
  scrubbed from live code + docs (rotation is still an ops task).
- **Honesty:** Agent Builder and Scheduling Rules screens now state
  what they actually do; the default agent prompt includes a recording
  disclosure and a 911 medical-emergency directive.
- **Reliability:** `data/unified_calls.json` and `data/callbacks.json`
  are now atomic-write + debounced. Sample callback seed removed.
- **Operability:** `ecosystem.config.js` now actually launches the new
  dashboard. `PILOT_OFFICE_SETUP.md` and `cursor-audit/13-qa-pass-procedure.md`
  give ops a single-source deployment + QA path.
- **AI booking surface (Phase C):** New `/api/retell-tools/*` endpoints
  (`lookup_patient`, `find_available_slots`, `book_appointment`,
  `create_callback`) re-using existing Open Dental code, gated behind
  `RETELL_TOOLS_ENABLED=false`. See `docs/retell-tools.md` for tool
  definitions to paste into the Retell dashboard. **Recommended pilot
  mode: keep this off for the first 1–2 weeks.**
- **Agent Builder publish (Phase C):** "Publish to Retell" button now
  PATCHes the live agent's System Prompt via the existing
  `/api/agents/:id` route. UI distinguishes "Save Draft" (local) from
  "Publish" (live) and shows the last-published timestamp + agent ID.

### What is still ahead

- **Ops gate:** `cursor-audit/12-verification-checklist.md` — Retell
  key rotation, BAA confirmation, droplet disk encryption check, network
  exposure review, and the two LK-01 / LK-02 verification scripts.
- **One full QA pass** against `cursor-audit/13-qa-pass-procedure.md`.
- **First-office pilot** per `PILOT_OFFICE_SETUP.md`. Operate without
  AI booking for the first 1–2 weeks, then enable `RETELL_TOOLS_ENABLED`
  per `docs/retell-tools.md`.
- **Multi-tenant + commercial sale:** out of scope for this round; will
  need its own roadmap.

---

Confidence tags:
- **Confirmed** — verified against this codebase or the vendor's docs.
- **Likely** — strong inference from the code, would need a runtime check to be 100%.
- **Possible** — real risk class, not directly observed.

If a claim isn't tagged, treat it as opinion.

---

## The four readiness ratings

| Question | Rating | One-line truth |
|---|---|---|
| **Internal QA?** | 🟡 **Yellow** | The backend works for one office. The voice→transcript→commlog pipeline is real. There are no automated tests. Several "Save" buttons are no-ops, so QA against the dashboard is misleading. *(Confirmed.)* |
| **Live beta in a dental office?** | 🔴 **Red** | The Agent Builder writes only to `localStorage`; the Scheduling Rules Save button is a `toast.success`. The callbacks queue resets every restart and is seeded with fake patients. Webhook signature verification is broken. The office cannot configure the AI through this product, and real callbacks would disappear nightly. *(All Confirmed.)* |
| **Production deployment?** | 🔴 **Red** | A live Retell API key is committed in `setup.sh:39`. The new dashboard's PM2 entry runs a non-existent `next` binary on a Vite project — it doesn't start. Every backend route is unauthenticated. Call data is a single non-atomic JSON file. *(All Confirmed.)* |
| **Sell to multiple offices?** | 🔴 **Red** | One hardcoded production domain (`backend/server.js:37-43`), one OD config object, one Retell account. No tenancy model, no per-office config storage, no billing, no onboarding. *(Confirmed.)* |

**Overall:** the bones of a real product are here. The voice→transcript→analysis→commlog pipeline runs end-to-end. The Open Dental integration is more substantial than I originally credited (real `bookAppointment`, `findAlternativeTimeSlots`, `searchPatients`, `verifyPatientAppointments` — see Correction D in file 11). The scheduling-rule taxonomy is dental-literate. But what's been built is a single-office demo with key configuration surfaces that don't persist.

The work to get to "first pilot" is concrete and finite — see file 08, P0 section. ~2 weeks for one engineer.

---

## The biggest launch blockers (evidence-anchored)

In order of "this hurts a real person or a real office first":

### 1. Medical emergencies are framed as bookable dental urgencies
- **Evidence:** `backend/services/liveCallManager.js:262-269` — `chest pain`, `can't breathe` are in the dental "is_emergency" keyword list. The repo doesn't contain the live Retell prompt, so I can't verify the agent's actual emergency behavior. *(Confirmed for the keyword list; Likely for prompt gap.)*
- **Why it matters:** A patient in real medical distress should be told to hang up and dial 911. Today's logic flags them for priority booking instead. Patient harm + liability risk.

### 2. Retell webhook signature verification doesn't actually verify
- **Evidence:** `backend/routes/webhooks.js:20-41`. Implementation re-stringifies parsed body (Retell signs raw bytes per their docs), bypasses entirely when `NODE_ENV !== 'production'`, doesn't parse the `v=,d=` format, and `crypto.timingSafeEqual` will throw on the length mismatch. *(Confirmed.)*
- **Why it matters:** In dev anyone can inject fake calls into the patient record system. In production every real Retell webhook either throws (caught and 200'd, so Retell never retries) or is rejected. Either way, the office's patient record reliability depends on a verifier that is wrong on every call.

### 3. The Agent Builder doesn't actually edit the agent
- **Evidence:** `new-dashboard/client/src/pages/AgentBuilder.tsx:295-298` — `handleSave` writes to `localStorage` and nothing else. `backend/routes/agents.js:6-22` returns four hardcoded mock agents ("Medical Receptionist", "Pharmacy Assistant"). *(Confirmed.)*
- **Why it matters:** Office manager edits "office hours: closed Wednesday," clicks Save, watches the next call book a Wednesday appointment. Trust gone.

### 4. The Scheduling Rules screen is decoration
- **Evidence:** `new-dashboard/client/src/pages/Scheduling.tsx:279-281` — `<Button onClick={() => toast.success("Scheduling rules saved")}>`. *(Confirmed.)*
- **Why it matters:** Office manager toggles "lunch block 12-1pm," patient gets booked at 12:30. Same trust problem.

### 5. A live Retell API key is checked into the repo
- **Evidence:** `setup.sh:39` literal `RETELL_API_KEY=key_5286e8b619b00ed6815991eba586`; same key referenced in `CURSOR_PRODUCTION_FIXES.md:17`; copies present across `.claude/worktrees/*` and `new-dashboard/.claude/worktrees/*`. *(Confirmed.)*
- **Note:** The earlier draft of this audit said "OpenAI key in `LIVE_PRODUCTION_TEST_RESULTS.md`" — that file does not exist; the leaked key is Retell, in setup.sh. Correction in file 11.

### 6. Every backend route is unauthenticated
- **Evidence:** `backend/server.js:91-102` mounts routers with no auth middleware. `webhooks.js`, `callbacks.js`, `agents.js`, `admin.js` and Socket.IO have no token check. *(Confirmed.)*
- **Why it matters:** Anyone with the URL can read every patient call transcript, watch live calls via Socket.IO, and trigger admin actions like the Mango Puppeteer login.

### 7. The callbacks queue is in-memory and seeded with fake patients
- **Evidence:** `backend/routes/callbacks.js:11, 261-329` — `let callbacks = []` plus `createSampleCallbacks()` invoked on module load. *(Confirmed.)*
- **Why it matters:** Real callbacks created during the day are lost on restart. Sample fake patients ("John Smith", "Mary Johnson") sit in the queue forever. Front desk can't tell real from fake.

### 8. Single non-atomic JSON file is the call store
- **Evidence:** `backend/services/unifiedCallStore.js:32, 472-490` — `fs.writeFile(...)` with no temp-file-and-rename. `backend/routes/webhooks.js` calls `persist()` on every webhook event including each transcript fragment. *(Confirmed.)*
- **Why it matters:** A power blip during a write loses every call record. Concurrent webhook events race with the 60-second auto-save tick (Likely for the race; Confirmed for the architecture).

### 9. PM2 starts the new dashboard with a non-existent Next.js binary
- **Evidence:** `ecosystem.config.js:24-26` runs `node_modules/.bin/next start`; `new-dashboard/package.json` has no `next` package — it's a Vite + Express project whose start script is `node dist/index.js`. *(Confirmed.)*
- **Why it matters:** The new dashboard fails silently under PM2. Today only the legacy frontend is reachable.

### 10. PHI handling and BAA status are unverified
- **Evidence:** `backend/services/callAnalyzer.js` posts transcripts to `gpt-3.5-turbo`. The repo has no record of a BAA being in place. Recordings live on local disk (`backend/services/mangoScraper.js` recordingsPath). *(LK-07: Possible — depends on operations.)*
- **Why it matters:** If no BAA, every transcript is a HIPAA exposure event. Worth confirming with operations before any patient call.

### 11. CommLog has no idempotency
- **Evidence:** `backend/routes/webhooks.js:218-279` — no check for an existing CommLog with the same call ID before insert. *(Likely; Retell does retry on 5xx.)*
- **Why it matters:** A patient chart can carry duplicate AI summaries of the same call.

### 12. Phone-format mismatch silently breaks patient match
- **Evidence:** `backend/config/openDental.js:918-962` does `LIKE %digits%` against `HmPhone`/`WkPhone`. If OD stores formatted phones (`(555) 123-4567`) and the lookup is digits-only, the match fails. *(Likely.)*
- **Why it matters:** AI summary lands on an "Unknown patient" CommLog instead of the patient's chart. Sub-threshold matches go to a `console.warn` and are never surfaced to staff.

---

## What is genuinely solid (worth defending)

These are real, not aspirational:

- **End-to-end pipeline:** Retell webhook → live monitor → unified store → CommLog into Open Dental works in code today. *(Confirmed.)*
- **Open Dental booking tools exist as backend code** — `bookAppointment`, `findAlternativeTimeSlots`, `checkSchedulingConflicts`, `searchPatients`, `verifyPatientAppointments` (`backend/config/openDental.js:446-1043`). The gap is that these aren't registered as Retell function-call tools. The lift to expose them is M-effort, not L. *(Confirmed.)*
- **Scheduling rule taxonomy** in `Scheduling.tsx` reflects how dental offices actually work (new adult no-recall = doctor exam only no cleaning, hygienist vs doctor, emergency, ortho). The taxonomy is right. The persistence is missing.
- **Agent Builder UX** has the right shape: knowledge base sections for hours/locations/providers/services/insurance/policies, prompt templates, copy-prompt action. Wiring it to Retell is M-effort.
- **2-question scheduling script** in the default prompt template ("mornings or afternoons?" → "early week or later?" → offer two slots) is a practical, dental-friendly approach.
- **Call analyzer prompt** asks the right structured questions: caller name, reason, sentiment, is_emergency, appointment_requested, callback_needed.

---

## What I am NOT claiming (downgraded from the earlier draft)

To avoid overstating risk:
- I am **not** claiming the OpenAI BAA is missing — I have no evidence either way. Operations needs to confirm.
- I am **not** claiming "AI talks over patients" or "awkward endings" — I have no audio. Live QA is the way to surface those.
- I am **not** claiming "the AI has no tools" — the backend has real tools; the agent integration is what's missing.
- I am **not** claiming the droplet's disk is unencrypted — I can't see the droplet config.
- I am **not** claiming "MySQL has no pool" — it does (CF-corrected in file 11). The pool's `acquireTimeout` / `timeout` options are silently ignored, which is a smaller issue.

---

## The one-paragraph summary

**This is a working voice→transcript→Open Dental pipeline, fronted by a beautiful dashboard whose two most important configuration surfaces — the Agent Builder and the Scheduling Rules — don't persist anywhere that the AI can read.** The agent in production runs whatever prompt was set in Retell's own dashboard, and nothing the office does in this product changes that. There is no auth, the deployed key has leaked, and the new dashboard's PM2 startup is broken. None of these is a deep problem. They are concrete bugs with concrete fixes, and the P0 section in file 08 lists them all in roughly two engineer-weeks of work. The bones of a premium dental voice AI product are real; the gap to a defensible pilot is mostly closing the lies in the UI, putting an auth check on the backend, persisting two pieces of state, and adding a 911 directive to the agent prompt. After the P0 list, the product is safely demoable to a single trusted pilot office in shadow mode. After P1, it's sellable. The work between here and there is finite and known.
