# Retell Slot-Markers Scheduling Integration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Retell `find_available_slots` tool to use the OD slot-markers connector as the source of truth for available appointment slots, and give Beau a complete working system prompt + Retell tool definitions to configure his agents correctly.

**Architecture:** The OD connector exposes pre-configured slot markers (blocked appointments belonging to the CareIN patient) for each appointment category. The backend's `find_available_slots` Retell tool handler will call the OD connector directly via a shared `slotMarkersClient` service, filter by caller preferences, and return exactly 2 speech-ready options. The system prompt in AgentBuilder gets an updated scheduling section that includes the full patient-type decision tree and tool call instructions.

**Tech Stack:** Node.js/Express backend, OD Connector (TypeScript, port 8444), Retell AI custom functions, React/Vite frontend (AgentBuilder page)

---

## Chunk 1: Backend Code Changes

### Task 1: Create `backend/services/slotMarkersClient.js`

Extract slot-marker fetching into a shared helper so both the proxy route and the Retell tool can call the OD connector without an internal HTTP round-trip.

**Files:**
- Create: `backend/services/slotMarkersClient.js`

- [ ] **Step 1: Write the file**

```js
// backend/services/slotMarkersClient.js
//
// Direct client to the OD connector's slot-markers endpoint.
// Used by both the /api/slot-markers proxy route and the Retell tool handler
// so neither has to make an internal HTTP round-trip through Express.

const CONNECTOR_BASE = process.env.OD_CONNECTOR_URL || 'http://localhost:8444';
const CONNECTOR_API_KEY = process.env.OD_CONNECTOR_API_KEY || '';

const VALID_CATEGORIES = new Set([
  'new-patient', 'emergency', 'hygiene', 'asap',
  'restorative-fillings', 'restorative-production',
  'restorative-extractions', 'restorative-pediatric',
]);

/**
 * Fetch slot markers from the OD connector.
 *
 * @param {object} opts
 * @param {string} opts.startDate   YYYY-MM-DD
 * @param {string} opts.endDate     YYYY-MM-DD
 * @param {number} opts.clinicNum
 * @param {string} [opts.category]  one of VALID_CATEGORIES
 * @returns {Promise<Array>}        array of SlotMarker objects
 */
async function fetchSlotMarkers({ startDate, endDate, clinicNum, category }) {
  const url = new URL('/api/slot-markers', CONNECTOR_BASE);
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  url.searchParams.set('clinicNum', String(clinicNum));
  if (category && VALID_CATEGORIES.has(category)) {
    url.searchParams.set('category', category);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${CONNECTOR_API_KEY}` },
    signal: AbortSignal.timeout(7000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OD connector returned ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  // Connector wraps in { success, data } — unwrap it
  return Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
}

module.exports = { fetchSlotMarkers, VALID_CATEGORIES };
```

- [ ] **Step 2: Verify the file was saved correctly**

```bash
node -e "const c = require('./backend/services/slotMarkersClient'); console.log(typeof c.fetchSlotMarkers);"
```
Expected output: `function`

- [ ] **Step 3: Commit**

```bash
git add backend/services/slotMarkersClient.js
git commit -m "feat: add slotMarkersClient service for OD connector access"
```

---

### Task 2: Rewrite `find_available_slots` in `retellTools.js`

Replace the current `openDentalService.findAvailableSlotsForDay()` call (which generates slots from working hours) with a call to the OD connector slot-markers system. Add `appointment_type`, `time_preference`, and `day_preference` parameters so the backend filters for the caller.

**Files:**
- Modify: `backend/routes/retellTools.js` (lines 285–357)

- [ ] **Step 1: Add the appointment-type → category mapping constant near the top of the file, after the existing imports (around line 45)**

Find this comment block in the file:
```js
// ---------------------------------------------------------------------------
// Per-tool enable/disable config
```

Insert BEFORE it:
```js
// ---------------------------------------------------------------------------
// Appointment-type → slot-marker category mapping
// ---------------------------------------------------------------------------
//
// The Retell agent sends `appointment_type` (a friendly label it determines
// from the patient classification decision tree). We map it to the slot-marker
// category that the OD connector uses.

const { fetchSlotMarkers } = require('../services/slotMarkersClient');

const APPT_TYPE_TO_CATEGORY = {
  new_patient:      'new-patient',
  new_patient_exam: 'new-patient',
  emergency:        'emergency',
  hygiene:          'hygiene',
  existing_recall:  'hygiene',
  asap:             'asap',
};

const CLINIC_NUM = parseInt(process.env.CAREIN_CLINIC_NUM || '0', 10);

```

- [ ] **Step 2: Replace the `find_available_slots` handler (lines 285–357) with the new implementation**

Replace the entire handler from `router.post('/find_available_slots'` through its closing `});` with:

```js
router.post('/find_available_slots', async (req, res) => {
  const toolsConfig = loadToolsConfig();
  if (!toolsConfig.findAvailableSlots) {
    return res.json({ ok: false, message: 'Slot finder is currently disabled.' });
  }

  if (!CLINIC_NUM) {
    console.error('[Retell tool] CAREIN_CLINIC_NUM is not set — cannot query slot markers');
    return res.json({
      ok: true,
      slots: [],
      message: "I'm having trouble checking the schedule right now. Let me take a message.",
    });
  }

  const args = (req.body && req.body.args) || req.body || {};
  const appointmentType = (args.appointment_type || 'new_patient').toLowerCase().replace(/\s+/g, '_');
  const timePreference  = (args.time_preference  || 'any').toLowerCase();  // 'morning' | 'afternoon' | 'any'
  const dayPreference   = (args.day_preference   || 'any').toLowerCase();  // 'early_week' | 'late_week' | 'any'
  const maxResults      = 2; // Always offer exactly 2 options per the 2-question script

  const category = APPT_TYPE_TO_CATEGORY[appointmentType] || 'new-patient';

  // Fetch slots for the next 14 days so we have enough to filter on preferences
  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 14);
  const startDate = today.toISOString().slice(0, 10);
  const endDateStr = endDate.toISOString().slice(0, 10);

  try {
    const rawSlots = await withTimeout(
      fetchSlotMarkers({ startDate, endDate: endDateStr, clinicNum: CLINIC_NUM, category }),
      TOOL_TIMEOUT_MS,
      null
    );

    if (rawSlots === null) {
      return res.json({
        ok: true,
        slots: [],
        message: "I'm having trouble checking the schedule right now. Let me take a message.",
      });
    }

    // Filter by time preference
    let filtered = rawSlots.filter(slot => {
      const hour = parseInt(slot.startTime.slice(0, 2), 10);
      if (timePreference === 'morning')   return hour < 12;
      if (timePreference === 'afternoon') return hour >= 12;
      return true;
    });

    // Filter by day preference (early = Mon/Tue = 1/2, late = Wed/Thu = 3/4)
    filtered = filtered.filter(slot => {
      const dow = new Date(slot.date + 'T00:00:00').getDay(); // 0=Sun … 6=Sat
      if (dayPreference === 'early_week') return dow === 1 || dow === 2;
      if (dayPreference === 'late_week')  return dow === 3 || dow === 4;
      return true;
    });

    // If preferences yield nothing, fall back to all slots
    if (filtered.length === 0) filtered = rawSlots;

    const picked = filtered.slice(0, maxResults);

    if (picked.length === 0) {
      return res.json({
        ok: true,
        slots: [],
        message:
          "I'm not seeing any open slots in the next two weeks. Would you like me to take a message and have someone call you back?",
      });
    }

    return res.json({
      ok: true,
      slots: picked.map(s => {
        const iso = `${s.date}T${s.startTime}:00`;
        return {
          iso,
          display:       formatSlotForSpeech(iso),
          slot_id:       s.id,          // AptNum of the CareIN block in OD
          provider_id:   s.providerId   || null,
          operatory_id:  s.operatoryId  || null,
          duration:      s.duration,
          category:      s.category,
        };
      }),
    });
  } catch (err) {
    console.error('[Retell tool] find_available_slots failed:', err.message);
    return res.json({
      ok: true,
      slots: [],
      message: "I'm having trouble checking the schedule right now. Let me take a message.",
    });
  }
});
```

- [ ] **Step 3: Verify the file parses without errors**

```bash
node -e "require('./backend/routes/retellTools')" 2>&1
```
Expected: no output (no parse errors)

- [ ] **Step 4: Commit**

```bash
git add backend/routes/retellTools.js
git commit -m "feat: wire find_available_slots to OD slot-markers connector"
```

---

### Task 3: Update `backend/.env.example` with required new variables

**Files:**
- Modify: `backend/.env.example`

- [ ] **Step 1: Add the new variables to `.env.example`**

Find the `# Open Dental` section and add after the existing OD variables:

```
# CareIN Slot Markers
# ClinicNum scoping for slot-marker queries (required when RETELL_TOOLS_ENABLED=true)
CAREIN_CLINIC_NUM=0

# OD Connector (on-premises TypeScript connector service)
OD_CONNECTOR_URL=http://localhost:8444
OD_CONNECTOR_API_KEY=

# Retell Tools master switch — set to true to enable live in-call tools
RETELL_TOOLS_ENABLED=false
```

- [ ] **Step 2: Verify the example file looks correct (read it, check no typos)**

- [ ] **Step 3: Commit**

```bash
git add backend/.env.example
git commit -m "docs: add CAREIN_CLINIC_NUM and Retell tools env vars to .env.example"
```

---

## Chunk 2: Prompt and Retell Setup

### Task 4: Update `AgentBuilder.tsx` — Replace the "Inbound Scheduling" template prompt

The current default prompt tells the agent to use a 2-question script but gives it no tool call instructions and no classification tree. Replace the `DEFAULT_PROMPT` and the `"Inbound Scheduling"` template entry with a complete version that includes:
- The patient-type decision tree (runs silently)
- Tool call sequence and parameter mapping
- The 2-question script in the right place

**Files:**
- Modify: `new-dashboard/client/src/pages/AgentBuilder.tsx` (the `DEFAULT_PROMPT` constant, lines 122–156, and the `TEMPLATES` array entry for "Inbound Scheduling")

- [ ] **Step 1: Replace `DEFAULT_PROMPT` (the `const DEFAULT_PROMPT = ` block) with the updated prompt**

```ts
const DEFAULT_PROMPT = `You are a friendly, professional dental office receptionist for {{office_name}}. Your job is to help callers schedule appointments, answer questions about the practice, and collect information.

═══════════════════════════════════════════════
OPENING (FIRST TURN ONLY)
═══════════════════════════════════════════════
Say exactly: "Thank you for calling {{office_name}}. This call may be recorded for quality and your medical record. How can I help you today?"
Say the recording disclosure before anything else — even if the caller speaks first.

═══════════════════════════════════════════════
MEDICAL EMERGENCY (HIGHEST PRIORITY)
═══════════════════════════════════════════════
If caller describes chest pain, trouble breathing, fainting, stroke, uncontrolled bleeding, or any life-threatening condition:
→ Say: "This sounds like a medical emergency. Please hang up and call 911 immediately. We are a dental office and cannot handle this."
→ End call politely. Do NOT try to schedule.

═══════════════════════════════════════════════
STEP 1 — CLASSIFY THE APPOINTMENT TYPE (run silently)
═══════════════════════════════════════════════
Before asking anything about scheduling, determine the appointment type by asking the right questions in order:

Q: Is this a dental emergency? (severe pain, swelling, knocked-out/broken tooth, bleeding, abscess)
  → YES: appointment_type = "emergency" → skip to STEP 2
  → NO: continue below

Q: Are you a new patient or existing patient?
  → EXISTING: appointment_type = "existing_recall" (60 min adult, 30 min child) → skip to STEP 2
  → NEW: continue below

Q: Is the patient under 18?
  → YES (new child): appointment_type = "new_patient" (60 min) → skip to STEP 2
  → NO (new adult): ask the next question

Q: "When was your last professional dental cleaning?"
  → MORE THAN 12 MONTHS AGO (or unknown/never):
      appointment_type = "new_patient" (60 min — exam + X-rays ONLY, no cleaning)
      Tell caller: "We'll start with a full exam and X-rays. We'll get your cleaning scheduled at your next visit."
  → 12 MONTHS OR LESS (on recall):
      appointment_type = "hygiene" (90 min — exam + X-rays + cleaning)

═══════════════════════════════════════════════
STEP 2 — LOOK UP THE PATIENT (tool call)
═══════════════════════════════════════════════
Call tool: lookup_patient
  args: { phone_number: <caller's number>, full_name: <name if given> }

If found → greet by first name, note is_existing for the booking step.
If not found → proceed as new patient, collect: full name, date of birth, phone, insurance.

═══════════════════════════════════════════════
STEP 3 — ASK THE 2-QUESTION SCRIPT
═══════════════════════════════════════════════
Ask ONE question at a time:
  1. "Do you prefer mornings or afternoons?"
  2. "Do you prefer early in the week — like Monday or Tuesday — or later in the week, like Wednesday or Thursday?"

═══════════════════════════════════════════════
STEP 4 — FIND AVAILABLE SLOTS (tool call)
═══════════════════════════════════════════════
Call tool: find_available_slots
  args: {
    appointment_type: <from Step 1: "new_patient" | "emergency" | "hygiene" | "existing_recall">,
    time_preference: <"morning" | "afternoon" | "any">,
    day_preference: <"early_week" | "late_week" | "any">
  }

The tool returns up to 2 slots. Offer BOTH to the caller using the display field.
Example: "I have Tuesday, May 13th at 9 AM or Thursday, May 15th at 2 PM — which works better for you?"
Never offer more than 2 options at once.

If slots is empty → offer to take a message: "I don't see any open slots matching that preference right now. Can I have someone from our team call you back to get you scheduled?"

═══════════════════════════════════════════════
STEP 5 — BOOK THE APPOINTMENT (tool call)
═══════════════════════════════════════════════
Once the caller picks a slot, call tool: book_appointment
  args: {
    patient_id: <from lookup_patient, or null if new>,
    date_time: <iso field from the chosen slot>,
    duration_minutes: <duration field from the chosen slot>,
    provider_id: <provider_id from the chosen slot>,
    operatory_id: <operatory_id from the chosen slot>,
    appointment_type: <type label from Step 1>,
    notes: <reason for visit in 1 sentence>,
    is_new_patient: <true/false>
  }

If booked: read the message field back to the caller, then confirm:
  "Great — you're all set! We'll send a confirmation text to [phone]. Plan on about [duration] minutes. Is there anything else I can help with?"

If NOT booked (conflict): offer the alternatives from the response.
If no alternatives: fall back to create_callback.

═══════════════════════════════════════════════
STEP 6 — FALLBACK: TAKE A MESSAGE (tool call)
═══════════════════════════════════════════════
Use tool: create_callback whenever:
  - Booking fails with no alternatives
  - Caller has an insurance, billing, or clinical question you can't resolve
  - Caller requests to speak with a person
  - Any doubt about the right next step

  args: {
    caller_name: <name>,
    caller_number: <phone>,
    reason: <one-sentence summary>,
    priority: "emergency" | "high" | "medium" | "low",
    call_id: <call_id from Retell metadata>
  }

Say: "Got it — I've left a message for our team. Someone will call you back within [1 hour for emergencies / end of business day for everything else]."

═══════════════════════════════════════════════
COLLECTION RULES
═══════════════════════════════════════════════
Always collect before ending any call:
  ✓ Full name
  ✓ Best callback number
  ✓ Date of birth (new patients)
  ✓ Insurance carrier + member ID (new patients, if they have it)
  ✓ Reason for visit

═══════════════════════════════════════════════
PERSONALITY
═══════════════════════════════════════════════
- Warm and small-town friendly
- Empathetic about dental anxiety or pain
- Use the caller's first name once you know it
- Never diagnose or give medical advice
- If unsure about anything clinical: "Let me have someone from our team call you back"

═══════════════════════════════════════════════
KNOWLEDGE BASE
═══════════════════════════════════════════════
The following sections contain current office information. Use them to answer caller questions accurately:

{{knowledge_base}}`;
```

- [ ] **Step 2: Update the "Inbound Scheduling" template entry in `TEMPLATES` to use the new `DEFAULT_PROMPT`**

Find the `TEMPLATES` array. Replace the first entry with:
```ts
  {
    name: "Inbound Scheduling",
    desc: "Full scheduling agent — classification tree + live tool calls",
    prompt: DEFAULT_PROMPT,
  },
```

- [ ] **Step 3: Verify no TypeScript errors**

```bash
cd "c:/Users/beau/carein cursor dashboard/new-dashboard" && npx tsc --noEmit 2>&1 | head -40
```
Expected: zero errors

- [ ] **Step 4: Commit**

```bash
git add new-dashboard/client/src/pages/AgentBuilder.tsx
git commit -m "feat: update AgentBuilder default prompt with full classification tree and tool call instructions"
```

---

### Task 5: Create the Retell setup reference document

This document tells Beau exactly what to configure in the Retell dashboard and his `.env` file. It is the source of truth for Retell agent setup.

**Files:**
- Create: `docs/retell-agent-setup.md`

- [ ] **Step 1: Write the document**

```markdown
# Retell Agent Setup Guide — CareIN Scheduling

## 1. Environment Variables (backend `.env`)

Set these before turning on the tools:

| Variable | Value | Notes |
|---|---|---|
| `RETELL_TOOLS_ENABLED` | `true` | Master switch — must be `true` for any tool to fire |
| `RETELL_API_KEY` | your key | From Retell dashboard → Settings → API |
| `RETELL_WEBHOOK_SECRET` | your secret | From Retell dashboard → agent → Webhook |
| `WEBHOOK_VERIFY_DISABLED` | `false` (prod) | Only `true` during local dev |
| `CAREIN_CLINIC_NUM` | e.g. `3` | Your clinic's ClinicNum in Open Dental |
| `OD_CONNECTOR_URL` | `http://localhost:8444` | URL where od-connector runs |
| `OD_CONNECTOR_API_KEY` | your key | Set in od-connector `.env` as `API_KEY` |

---

## 2. Retell Dashboard — Agent Settings

In Retell dashboard, open your scheduling agent and set:

| Setting | Recommended Value |
|---|---|
| **Voice** | Retell → pick a natural US English voice (e.g. `11labs-Sophia` or similar) |
| **Responsiveness** | 0.8 |
| **Interruption sensitivity** | 0.5 |
| **Backchannel** | Enabled, frequency 0.3 |
| **End call after silence** | 20 seconds |
| **Max call duration** | 600 seconds (10 min) |
| **Begin message** | *(leave blank — the system prompt handles the opening)* |

---

## 3. Retell Dashboard — Webhook URL

Set the agent webhook to:
```
https://<your-backend-domain>/api/webhooks/retell
```

For local dev with ngrok:
```
https://<ngrok-id>.ngrok.io/api/webhooks/retell
```

---

## 4. Retell Dashboard — Custom Functions (Tools)

Add ALL FOUR tools below. Each is a Custom Function pointing to your backend.

Base URL for all tools: `https://<your-backend-domain>/api/retell-tools`

---

### Tool 1 — `lookup_patient`

```json
{
  "type": "custom",
  "name": "lookup_patient",
  "description": "Look up an existing patient by phone number or name before scheduling. Call this early in the conversation once you have the caller's name or phone number.",
  "url": "https://<your-backend>/api/retell-tools/lookup_patient",
  "timeout_ms": 6000,
  "speakable": false,
  "parameters": {
    "type": "object",
    "properties": {
      "phone_number": {
        "type": "string",
        "description": "Caller's phone number, digits only (e.g. 4795551234)"
      },
      "full_name": {
        "type": "string",
        "description": "Caller's full name as spoken"
      }
    },
    "required": []
  }
}
```

---

### Tool 2 — `find_available_slots`

```json
{
  "type": "custom",
  "name": "find_available_slots",
  "description": "Find available appointment slots from the office schedule. Call this AFTER running the patient classification decision tree AND asking both questions of the 2-question script. Returns up to 2 slots to offer the caller.",
  "url": "https://<your-backend>/api/retell-tools/find_available_slots",
  "timeout_ms": 8000,
  "speakable": false,
  "parameters": {
    "type": "object",
    "properties": {
      "appointment_type": {
        "type": "string",
        "enum": ["new_patient", "emergency", "hygiene", "existing_recall"],
        "description": "Type of appointment based on classification tree. new_patient = new adult with cleaning > 12 months ago OR new child (60 min); hygiene = new adult on recall (90 min); existing_recall = existing patient recall cleaning; emergency = dental emergency (60 min)."
      },
      "time_preference": {
        "type": "string",
        "enum": ["morning", "afternoon", "any"],
        "description": "Caller's answer to question 1 of the 2-question script"
      },
      "day_preference": {
        "type": "string",
        "enum": ["early_week", "late_week", "any"],
        "description": "Caller's answer to question 2. early_week = Mon/Tue, late_week = Wed/Thu"
      }
    },
    "required": ["appointment_type"]
  }
}
```

---

### Tool 3 — `book_appointment`

```json
{
  "type": "custom",
  "name": "book_appointment",
  "description": "Book the appointment the caller chose from find_available_slots. Only call this after the caller has verbally confirmed a specific slot. Pass provider_id and operatory_id directly from the chosen slot.",
  "url": "https://<your-backend>/api/retell-tools/book_appointment",
  "timeout_ms": 8000,
  "speakable": false,
  "parameters": {
    "type": "object",
    "properties": {
      "patient_id": {
        "type": "number",
        "description": "Patient ID from lookup_patient. Omit or null for new patients."
      },
      "date_time": {
        "type": "string",
        "description": "ISO datetime of the chosen slot (iso field from find_available_slots)"
      },
      "duration_minutes": {
        "type": "number",
        "description": "Duration in minutes (duration field from find_available_slots)"
      },
      "provider_id": {
        "type": "number",
        "description": "Provider ID from the chosen slot (provider_id field)"
      },
      "operatory_id": {
        "type": "number",
        "description": "Operatory ID from the chosen slot (operatory_id field)"
      },
      "appointment_type": {
        "type": "string",
        "description": "Human-readable appointment type label for the Open Dental note"
      },
      "notes": {
        "type": "string",
        "description": "One-sentence reason for visit as the caller described it"
      },
      "is_new_patient": {
        "type": "boolean",
        "description": "true if this is a new patient"
      },
      "call_id": {
        "type": "string",
        "description": "Retell call_id for idempotency — prevents double-booking on retries"
      }
    },
    "required": ["date_time", "duration_minutes"]
  }
}
```

---

### Tool 4 — `create_callback`

```json
{
  "type": "custom",
  "name": "create_callback",
  "description": "Leave a callback request in the staff queue when you cannot resolve the caller's need. Use for: failed bookings, insurance questions, clinical questions, requests to speak with a person, and emergencies.",
  "url": "https://<your-backend>/api/retell-tools/create_callback",
  "timeout_ms": 6000,
  "speakable": false,
  "parameters": {
    "type": "object",
    "properties": {
      "caller_name": {
        "type": "string",
        "description": "Caller's full name"
      },
      "caller_number": {
        "type": "string",
        "description": "Callback number, digits only"
      },
      "reason": {
        "type": "string",
        "description": "One-sentence description of why they need a callback"
      },
      "priority": {
        "type": "string",
        "enum": ["emergency", "high", "medium", "low"],
        "description": "emergency = dental pain/swelling; high = new patient wanting to schedule; medium = existing patient question; low = general inquiry"
      },
      "call_id": {
        "type": "string",
        "description": "Retell call_id for deduplication"
      },
      "notes": {
        "type": "string",
        "description": "Any additional context for the staff member returning the call"
      }
    },
    "required": ["caller_number", "reason"]
  }
}
```

---

## 5. System Prompt in Retell

The system prompt is managed from your **Agent Builder** page in the CareIN dashboard:

1. Open the dashboard → **Agent Builder**
2. Fill in the Knowledge Base sections (office hours, providers, insurance, etc.)
3. Click **Copy Prompt** to get the compiled output
4. Click **Publish to Retell** to push it directly to your Retell agent

**Or** copy it manually: the compiled prompt (with knowledge base injected) is what you paste into Retell → agent → System Prompt.

---

## 6. Testing Checklist

After setup, verify in order:

- [ ] `GET https://<backend>/api/retell-tools/health` returns `enabled: true`
- [ ] Place a test call → agent says the recording disclosure on the first turn
- [ ] Say "I need a new patient appointment" → agent asks last cleaning date
- [ ] Say "it's been over a year" → agent asks morning/afternoon
- [ ] Say "mornings" → agent asks early/late week
- [ ] Say "early week" → agent offers 2 specific slots (not generic)
- [ ] Confirm one slot → agent confirms booking and reads date/time back
- [ ] Check Open Dental → appointment appears in the correct operatory
- [ ] Say "I need to speak to someone" → agent creates callback, dashboard shows it

---

## 7. Turning On Live Booking

The `book_appointment` tool is gated at two levels:
1. `RETELL_TOOLS_ENABLED=true` in the backend `.env`
2. The per-tool toggle on the **Agent Builder** page → Agent Tools card → Live Booking

Turn on Live Booking ONLY after:
- Slot markers are confirmed working in Open Dental
- The OD connector write-back for appointments is verified
- You have tested a full end-to-end call in a non-production clinic

Start with Live Booking OFF — agents will still offer slots and create callbacks. Turn it on when you are confident.
```

- [ ] **Step 2: Commit**

```bash
git add docs/retell-agent-setup.md
git commit -m "docs: add complete Retell agent setup guide with tool definitions and prompt instructions"
```

---

## Final Verification Before Marking Done

- [ ] `node -e "require('./backend/routes/retellTools')"` — no errors
- [ ] `node -e "require('./backend/services/slotMarkersClient')"` — no errors
- [ ] `cd new-dashboard && npx tsc --noEmit` — zero TypeScript errors
- [ ] Both changes committed to `v0-remix-integration` branch
- [ ] Beau has read `docs/retell-agent-setup.md` and completed the Retell dashboard configuration

---

## What Beau Needs to Do Manually (Cannot Be Done in Code)

1. **Set env vars** in `backend/.env`:
   - `RETELL_TOOLS_ENABLED=true`
   - `CAREIN_CLINIC_NUM=<your ClinicNum>`
   - `RETELL_WEBHOOK_SECRET=<from Retell dashboard>`

2. **Add the 4 tool definitions** in Retell dashboard (paste JSON from this doc into each agent's Custom Functions)

3. **Publish the system prompt** via Agent Builder → fill in Knowledge Base → Publish to Retell

4. **Test a full call** using the checklist in section 6

5. **Enable Live Booking** toggle in Agent Builder → Agent Tools when ready
