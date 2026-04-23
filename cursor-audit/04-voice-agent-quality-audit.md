# 04 — Voice Agent Quality Audit

How the AI voice agent is likely to behave on real dental calls.

> **Read this with [`11-evidence-and-confidence.md`](./11-evidence-and-confidence.md).** Important caveats:
> - **The deployed Retell agent prompt is not in this repo.** Most claims about the agent's *behavior* (recording disclosure, 911 escalation, hallucinated hours, awkward endings, talking over patients) are **Likely** or **Possible** — they need a runtime check against the actual deployed agent + listening to recordings. They are not Confirmed.
> - The starter prompt in `AgentBuilder.tsx` is real evidence of what the operator might paste into Retell. If that's the deployed prompt, several of the concerns below are Confirmed; if not, they're Likely.
> - The `liveCallManager.js:262-269` keyword list is Confirmed — chest pain and difficulty breathing are flagged as bookable dental urgencies, which is the wrong response.
>
> The "concrete fixes" in this file align with the P0-06 (911 directive) and P0-07 (recording disclosure) items in file 08.

---

## The most important fact about this audit

**The voice agent is not actually configured by this codebase.** The agent prompt, voice settings, behaviors, fallbacks, and tools all live inside the Retell dashboard. This product:
- Provides a UI to design a prompt (that doesn't push to Retell).
- Receives webhook callbacks from Retell.
- Stores transcripts and analysis.

So an audit of "voice agent quality" is really an audit of:
1. The starter prompts in [`AgentBuilder.tsx`](../new-dashboard/client/src/pages/AgentBuilder.tsx) — the prompts the team would presumably copy into Retell.
2. The webhook handling that drives live monitoring and post-call actions.
3. The integration shape (what tools the agent has access to).

The actual Retell agent runtime — voice, ASR, latency, interruption handling, function-calling — is opaque to me from the codebase. Statements about those are inferences from defaults and documented behavior.

---

## A. Audit of the starter prompts

There are four templates in [`AgentBuilder.tsx:110-189`](../new-dashboard/client/src/pages/AgentBuilder.tsx). I read them as if they were running in Retell.

### Template 1: "Inbound Scheduling" (default)
```
You are a friendly, professional dental office receptionist for {{office_name}}.
...
SCHEDULING FLOW:
For non-emergency callers, use the 2-question script:
1. "Do you prefer mornings or afternoons?"
2. "Do you prefer early in the week or later in the week?"
Then offer two specific time slots matching their preference.

For emergencies: offer the next available slot today or tomorrow.

RULES:
- Never diagnose or give medical advice
- If unsure, say "Let me have someone from our team call you back about that"
- Always confirm the appointment details before ending the call
- Collect: full name, phone number, date of birth, insurance (if any), reason for visit
```

**What's good:**
- Clear personality and pace direction.
- Explicit "never diagnose" rule.
- Explicit fallback ("let me have someone call you back").
- The 2-question script is a smart, dental-tested scheduling pattern.
- Empathy directive about dental anxiety/pain.

**What's weak or dangerous:**
1. **"Then offer two specific time slots matching their preference"** — there is no tool definition in the prompt that tells the AI *how to find* available slots. With no calendar function call, the AI will hallucinate slots that don't exist. Or it will say "I'll need someone to confirm" — defeating the purpose.
2. **"Always confirm the appointment details before ending the call"** — good, but with no tool to actually book the appointment, the "confirmation" is verbal only. The patient hangs up believing they have an appointment that may or may not exist.
3. **Collect DOB and insurance** during a phone call — fine for a returning patient, but for a new patient, the script is asking for sensitive info without acknowledging it. No "is now a good time, or would you like us to text you a form?"
4. **No instruction on what to say at end of call** ("we'll send a confirmation text", "you'll get an email").
5. **No script for "I just want to know your hours"** — the most common call. The AI will read the knowledge base and answer, hopefully.
6. **No script for "is Dr. X in today?"** — needs schedule integration that doesn't exist.
7. **No instruction on what voice quality to aim for** (energy, smile-in-voice, slowness for older callers).
8. **No instruction on what to do if the caller speaks Spanish** or another language.
9. **No script for handling background noise** (kids, other patients, traffic) — Retell will just transcribe garbled audio.
10. **The {{office_name}} placeholder** appears 1× in the prompt and is never substituted by code. If the office leaves it as `{{office_name}}` (and the placeholder never gets replaced), the AI will literally say "Welcome to {{office_name}}".
11. **No instruction on what to do if the caller is profane or abusive.**
12. **No instruction on what to do if the caller asks "are you a real person?"** This is happening more and more. Premium AI voice products have an explicit script for this.

### Template 2: "Emergency Triage"

```
EMERGENCY CRITERIA (route to immediate care):
- Severe, uncontrolled pain
- Swelling in face, jaw, or neck
- Knocked-out or broken tooth (within 1 hour)
- Uncontrolled bleeding
- Suspected jaw fracture
- Abscess with fever
```

**What's good:**
- The criteria list is dental-literate.
- Clear distinction between emergency and non-emergency.

**What's weak or dangerous:**
1. **"Route to immediate care"** is undefined. There is no tool, no transfer number, no instruction on what "immediate care" means in practice. The AI says it. Nothing happens.
2. **"Knocked-out or broken tooth (within 1 hour)"** is a hard time window — but the prompt doesn't tell the AI to *ask* "how long ago did this happen?". The AI may schedule a 12-hour-old avulsion as routine.
3. **Pain in the upper teeth + sweating + jaw radiating** can be cardiac, not dental. The prompt has no "if you suspect this could be a heart attack, instruct the caller to call 911" guard. **This is the single highest-stakes missing instruction in the entire product.** A dental office's worst-case is a caller dying because they were told to wait until tomorrow.
4. **No instruction to call 911 in any circumstance.** Severe oral bleeding can cause shock; jaw fracture can compromise airway; abscess with fever and difficulty breathing is potentially life-threatening. The product should explicitly instruct the AI: "if you hear any of [trouble breathing, fainting, chest pain, severe bleeding, signs of stroke, anaphylaxis], stop and tell the caller to hang up and call 911."
5. **Dental abscess with fever can become Ludwig's angina** in hours. Routing them to "next available emergency slot" without 911 guidance is a real risk.
6. **No callback path for "I'll get back to you in 5 minutes."** If the AI says "let me check with the doctor and call you back" — there is no mechanism to actually do that.
7. **No instruction on what to do for pediatric emergencies** specifically (parents call about a kid; the rules differ).

### Template 3: "New Patient Welcome"

**What's good:**
- Warm greeting with personalization.
- Collects the right info naturally.
- Different appointment durations for new vs new-on-recall.

**What's weak:**
1. **"How they heard about us" as a required collected field** during a first call may feel intrusive when the patient just wants to book. Soft-ask only.
2. **"We'll send you our new patient forms by email"** — there is no integration that actually sends forms. The patient is being promised a thing that doesn't happen.
3. **No instruction about HIPAA/privacy** ("this call is being recorded for training" — required in many states).
4. **No script for "I'm not ready to give my insurance info"** — common pushback.

### Template 4: "Recall Reminder" (outbound)

**What's good:**
- Warm, non-pushy tone direction.
- Explicit "if they decline" graceful out.

**What's weak:**
1. **There is no outbound calling code path in this product.** The template is for outbound calls but the entire architecture is inbound-webhook-driven. So this template is for a feature that doesn't exist yet — a separate Retell outbound agent + dialer integration.
2. **TCPA compliance is not addressed** anywhere. Outbound recall calls to patients require either explicit consent or careful exemption.
3. **No script for voicemails** — outbound calls land on voicemail more often than not.
4. **No way to know if the patient actually scheduled** — the loop back to the calendar is missing.

---

## B. Audit of the live call handling

The webhook flow ([`backend/routes/webhooks.js`](../backend/routes/webhooks.js)) is what receives Retell events. Let's audit how it would behave on real calls.

### Likely failure modes during a live call

1. **Webhook signature verification is bypassed in dev** and likely broken in prod (uses `JSON.stringify(req.body)` which is non-canonical). Either:
   - In dev, anyone can fake webhook events and pollute the call log.
   - In prod, real Retell webhooks may fail signature verification and be rejected. **The product may silently drop real call events** and the office never sees the call in the dashboard.
2. **Live transcript stream is fire-and-forget**. If the Socket.IO connection drops mid-call, the live monitor on the dashboard freezes silently. No reconnect, no "stale" indicator.
3. **`liveCallManager` is in-memory.** A backend restart mid-call wipes the active call. The dashboard shows nothing; the call continues; on `call_ended`, the unified store gets the record but the live experience was broken.
4. **No dedupe logic** on webhook IDs. If Retell retries a webhook (which it does on 5xx), the call may be inserted twice into the unified store.
5. **The unified store write is non-atomic** (`fs.writeFileSync` after `JSON.stringify` of the whole array). Concurrent writes from the Retell sync interval, the Mango cron, and the webhook can corrupt the file. **A bad race during a live call can lose the entire call log.**
6. **Open Dental commlog is fire-and-forget** after the call ends. If OD is down at that moment, the commlog is lost — there's no retry queue.
7. **The transcript object** is whatever Retell sends. If Retell changes its event schema, this product silently breaks. There's no schema validation.

### Likely failure modes around the call

1. **No "call took longer than expected" alert.** A 15-minute AI call probably means the AI is stuck in a loop. Nothing flags this.
2. **No "transcript looks empty" alert.** A call that produced 2 lines of transcript is suspect. Nothing flags this.
3. **No "many short calls in succession from same number" detection.** A patient calling back repeatedly because the AI hung up may go unnoticed.
4. **No "AI made up data" check.** If the AI claims to have booked a 3pm appointment but no OD calendar event was created, the dashboard happily shows "appointment requested = true" with no further action.
5. **No "patient asked for a transfer and the AI couldn't"** flag.

---

## C. Hallucination and trust risks

The product gives the AI rich context (knowledge base + prompt) and then trusts it to use that context correctly. Specific risks:

1. **Hours hallucination.** If the office leaves Office Hours blank in the knowledge base, the AI will make hours up. Default placeholder is "Mon-Thu: 8:00 AM - 5:00 PM" — and the AI may use the placeholder if the office leaves the placeholder text in (the UI does not distinguish unfilled from "filled with placeholder").
2. **Insurance hallucination.** "Do you take MetLife?" — if the office hasn't filled in insurance, the AI will guess.
3. **Provider hallucination.** "Is Dr. Smith available Tuesday?" — the AI doesn't have schedule access. It will likely make up an answer.
4. **Pricing hallucination.** "How much does a cleaning cost?" — no pricing in knowledge base by default. The AI will either decline or invent a price. Either is bad.
5. **Address hallucination.** If multi-location office leaves Locations blank, the AI may say "we're at 123 Main Street" when there is no such address.
6. **Treatment hallucination.** A new template doesn't include "do not advise on dosages, do not interpret images, do not predict outcomes" — the "Never diagnose" rule is one line and easy for an LLM to drift past.

The fix for all of these is the same: the Knowledge Base must be filled, the prompt must explicitly say "if a fact is not in the knowledge base, say 'let me have someone call you back about that'", and there must be an evaluation suite that tests for hallucination on common queries.

---

## D. Patient experience risks

These are scenarios where a real patient could have a bad experience that damages adoption.

1. **AI doesn't catch the caller's name and asks 3+ times.** The default prompt says "use the caller's name once you learn it" — fine. But what if the AI hears it wrong? Need explicit instruction: "if you mishear, ask once more, then move on."
2. **AI mispronounces patient name.** No phonetic guidance. Patient with a non-anglo name may feel disrespected.
3. **AI talks over the patient.** Default Retell `interruption_sensitivity` settings determine this; the codebase defaults this to 0.5 ([`backend/routes/agents.js`](../backend/routes/agents.js)). For a dental office, where patients are often anxious and slow, this should be lower.
4. **AI can't handle "let me ask my husband, hold on a sec."** No explicit instruction on holds.
5. **AI ends the call awkwardly.** No explicit "say goodbye warmly, mention next steps, encourage them to call back if anything changes" instruction.
6. **AI fails to confirm the time of day.** "Let's get you in Tuesday at 10" — AM or PM? Patient assumes AM, AI meant PM.
7. **AI doesn't offer accommodations.** Wheelchair access, sign language, sedation requirements — none of these are in the standard intake.
8. **AI handles a hostile caller poorly.** "I need to speak to a real person right now!" — the prompt has no script for this. Premium products have a clear "I understand. Let me get someone for you. Can I confirm your callback number?" flow.
9. **AI handles a billing dispute.** No script. Caller frustration grows.
10. **AI handles a "you charged my card twice" call.** No script. Caller assumes incompetence.

---

## E. Edge cases the product is unprepared for

1. **Caller ID is blocked or shows as private.** Patient matching fails; no caller-name lookup possible. The prompt doesn't acknowledge this case.
2. **Robocaller / spam call.** No detection. Wastes Deepgram + OpenAI minutes on every spam call.
3. **Test calls from staff.** Polluting the call log with internal tests. No "test mode" tag.
4. **Wrong-number calls.** The AI cheerfully tries to schedule them.
5. **Calls from kids/minors.** No script. Could schedule a minor without parental verification.
6. **Calls from third parties** ("calling on behalf of my mom"). HIPAA implications — no script.
7. **Existing patient with arrears.** Nothing checks balance before scheduling.
8. **Cancellation calls.** "I need to cancel my appointment for tomorrow" — the AI cannot actually cancel. It needs to say so and create a callback.
9. **Reschedule calls.** Same issue.
10. **Walk-in calls** ("can I come in right now?") — the AI cannot check actual availability.
11. **Calls during a power outage** at the office where the OD bridge is unreachable — the AI will fail silently, sounding broken.

---

## F. Confidence handling

The current architecture has zero "I'm not sure, let me get a human" handling beyond the prompt directive. There's no:
- Confidence scoring on what the AI heard.
- Threshold-based escalation (low ASR confidence → "let me make sure I have this right").
- Pattern-detection for "the AI has asked the same question 3 times in this call."
- Auto-transfer or auto-callback creation when the call is going badly.

A premium product would have a "confidence engine" running in parallel that watches for confusion signals and intervenes.

---

## G. Tools the agent should have but doesn't

For the AI to actually book appointments, check availability, and verify identity, it needs callable functions exposed via Retell tools. From the codebase, I see:
- A `POST /api/openDental/...` route surface that could *theoretically* be called.
- No tool registration anywhere — no place that says "Retell can call these endpoints."
- No documented "tool spec" sent to Retell.

So the AI is operating without:
- `find_available_slots(provider_type, date_range, duration)`
- `book_appointment(patient_id, slot_id, type)`
- `look_up_patient(name, dob, phone)`
- `get_office_status_today()` (any closures, lunch break, after-hours)
- `transfer_to_human(department)`
- `send_intake_forms(patient_email)`
- `create_callback(reason, priority)`

Without these, the AI is talking, not doing. A real dental SaaS lives or dies on whether the AI can actually *complete the task*.

---

## H. Concrete fixes, in priority order

### Tier 1 — Safety
1. **Add explicit 911 instructions to the Emergency Triage prompt.** "If the caller mentions difficulty breathing, chest pain, fainting, severe uncontrolled bleeding, or signs of stroke, immediately tell them to hang up and call 911."
2. **Add a "do not diagnose, do not advise on medication" hard rule** with examples.
3. **Add an "if not in knowledge base, do not guess" rule.**
4. **Add a "this call may be recorded" disclaimer** that plays at call start (if state requires).

### Tier 2 — Truth
5. **Make the Agent Builder actually push prompts to Retell** so the office's intent matches the AI's behavior.
6. **Substitute `{{office_name}}` and `{{knowledge_base}}` server-side** before pushing to Retell.
7. **Validate Knowledge Base sections** — refuse to push a config with the placeholder text still in it.

### Tier 3 — Capability
8. **Define and register Retell tools** (`find_slots`, `book`, `lookup_patient`, `transfer`, `create_callback`).
9. **Wire the booking tool into Open Dental for real appointment creation** (with confirmation guard).
10. **Implement a real human-transfer path** (Mango or Twilio).

### Tier 4 — Reliability
11. **Add webhook retry/dedupe** based on event ID.
12. **Persist `liveCallManager`** state to disk so a restart doesn't drop active calls.
13. **Add a transcript-quality check** post-call (length, turns, words-per-minute) and flag suspicious calls for review.

### Tier 5 — Quality
14. **Build a transcript-based regression suite** — golden transcripts of common scenarios with expected behaviors.
15. **Add a "test the agent" sandbox** in the Agent Builder.
16. **Add per-call quality scores** in the post-call analysis.
17. **Add a "this call had an issue" thumbs-down button** for staff feedback that retrains the prompt.

---

## Bottom line

The voice agent's behavior is mostly inferred from prompts that aren't actually applied to the live agent through this product. The starter prompts have good bones — the 2-question scheduling script, the empathy directive, the "let me have someone call you back" fallback — but they have several dangerous omissions (911, hold, transfer, language, "are you a real person?") and they assume capabilities (booking, transfer, lookup) that the product hasn't given the AI.

The single biggest improvement to call quality is not a prompt change — it's wiring the product to Retell so the office's configuration becomes the AI's behavior, and giving the AI tools so it can actually *do* the things its prompt promises.
