# Retell Custom Function (Tool) Surface

This document describes the four endpoints CareIN exposes to Retell and how
to wire them up in the Retell agent dashboard. Without this wiring, the
endpoints exist but the AI does not know about them — calls continue to be
handled by transcription + post-call analysis only.

> **Status (pilot launch):** disabled by default. Backend serves a 503 from
> `/api/retell-tools/*` until `RETELL_TOOLS_ENABLED=true` is set.
> The intent is to ship the pilot with these tools off, validate the
> Likely-issue findings (LK-01, LK-02), and only then enable live booking.

---

## 1. Endpoints

All endpoints are HTTPS POST, JSON in / JSON out, mounted under
`/api/retell-tools/*` and authenticated with the existing Retell HMAC
signature (same scheme as webhooks). Replay window is 5 minutes.

| Endpoint | Purpose | Returns |
| --- | --- | --- |
| `POST /lookup_patient` | Find a patient by phone or name | `{ found, patient? }` |
| `POST /find_available_slots` | Get next N open slots | `{ slots: [...] }` |
| `POST /book_appointment` | Create an appointment in Open Dental | `{ booked, appointment_id? }` |
| `POST /create_callback` | Drop a message in the staff callback queue | `{ created, callback_id? }` |
| `GET  /health` | Unsigned probe; reports whether tools are enabled | `{ enabled, tools }` |

Each handler enforces a **5-second hard timeout** against Open Dental and
falls back to a speech-friendly "let me take a message" response on
timeout. This keeps the live call from hanging when the practice
management system is slow.

---

## 2. Tool definitions to paste into Retell

In the Retell dashboard, open your agent → **Functions** → **Add Function**
and create one entry per tool below. Use **Custom Function** type and
point each to `https://<your-backend>/api/retell-tools/<endpoint>`.

### 2.1 lookup_patient

```json
{
  "name": "lookup_patient",
  "description": "Find an existing patient in our practice management system by phone number or full name. Use this near the start of the call once you have either piece of info. Do not read the patient's record number back to the caller.",
  "parameters": {
    "type": "object",
    "properties": {
      "phone_number": { "type": "string", "description": "Caller's phone number, any format." },
      "full_name":    { "type": "string", "description": "Caller's full name as they say it." },
      "date_of_birth":{ "type": "string", "description": "Optional DOB (YYYY-MM-DD) to disambiguate." }
    }
  }
}
```

### 2.2 find_available_slots

```json
{
  "name": "find_available_slots",
  "description": "Find up to N open appointment slots within the next 7 days. Default duration 30 minutes. Use after confirming what kind of visit the patient needs.",
  "parameters": {
    "type": "object",
    "required": [],
    "properties": {
      "duration_minutes": { "type": "integer", "description": "Visit length. Hygiene = 60, exam = 30, emergency = 30." },
      "provider_id":      { "type": "integer", "description": "Restrict to one provider (optional)." },
      "operatory_id":     { "type": "integer", "description": "Restrict to one operatory (optional)." },
      "start_date":       { "type": "string",  "description": "YYYY-MM-DD; defaults to today." },
      "max_results":      { "type": "integer", "description": "Default 5, max 10." }
    }
  }
}
```

### 2.3 book_appointment

```json
{
  "name": "book_appointment",
  "description": "Book the appointment in Open Dental. Only call after the patient has CONFIRMED both the time and the visit type out loud.",
  "parameters": {
    "type": "object",
    "required": ["patient_id", "date_time", "duration_minutes"],
    "properties": {
      "patient_id":        { "type": "integer", "description": "From lookup_patient." },
      "date_time":         { "type": "string",  "description": "ISO 8601 from find_available_slots.iso." },
      "duration_minutes":  { "type": "integer" },
      "provider_id":       { "type": "integer" },
      "operatory_id":      { "type": "integer" },
      "appointment_type":  { "type": "string",  "description": "Hygiene, Exam, Emergency, etc." },
      "notes":             { "type": "string" },
      "is_new_patient":    { "type": "boolean" }
    }
  }
}
```

### 2.4 create_callback

```json
{
  "name": "create_callback",
  "description": "Use this when you cannot or should not book live: emergencies, insurance questions, complex reschedules, or when the booking system is unreachable. Always read the success message back to the caller verbatim so they know staff will follow up.",
  "parameters": {
    "type": "object",
    "required": ["caller_number", "reason"],
    "properties": {
      "caller_name":   { "type": "string" },
      "caller_number": { "type": "string" },
      "reason":        { "type": "string", "description": "One short sentence." },
      "priority":      { "type": "string", "enum": ["emergency", "high", "medium", "low"] },
      "call_id":       { "type": "string", "description": "Pass through the Retell call_id if you have it." },
      "notes":         { "type": "string" }
    }
  }
}
```

---

## 3. Suggested system-prompt addendum

Paste this into the agent's system prompt after the existing instructions:

```
TOOL USAGE
- Always call lookup_patient as soon as you have either a phone number or a full name.
- For scheduling: call find_available_slots, read 2–3 options to the caller, get an explicit yes, then call book_appointment with the patient_id from lookup_patient and the iso from the chosen slot.
- Never make up appointment times. If find_available_slots returns no slots, call create_callback.
- Never read patient.id, appointment_id, or any internal numbers back to the caller.
- If any tool returns ok:false or its message starts with "I couldn't" / "I'm having trouble", do not retry — call create_callback so staff can follow up.
```

---

## 4. Enabling the tools

1. Set `RETELL_TOOLS_ENABLED=true` in `backend/.env` (and confirm `RETELL_API_KEY` and `RETELL_WEBHOOK_SECRET` are set).
2. `pm2 restart carein-backend`.
3. Smoke test the unsigned health probe:
   ```bash
   curl https://<backend-host>/api/retell-tools/health
   # → { "ok": true, "enabled": true, "tools": [...] }
   ```
4. In the Retell dashboard, attach the four functions above to the agent.
5. Place a test call and watch `pm2 logs carein-backend` for `[Retell tool]` lines.

---

## 5. Rollback

If anything misbehaves on a live call, set `RETELL_TOOLS_ENABLED=false`
and restart. The endpoints will return 503 and Retell will skip them; the
agent will continue to handle calls in conversation-only mode and staff
will pick up follow-up via the existing callback queue.

---

## 6. Known limitations (pilot)

- **`provider_id` is required by Open Dental's working-hours lookup.** When
  the agent doesn't pick one, `find_available_slots` defaults to provider
  `1` / operatory `1`. For the first office this is fine because there is
  only one doctor; for a multi-provider office, expand the tool to query
  all providers and merge the results.
- **No reschedule / cancel tool.** Intentional — those flows have higher
  blast radius and should ship after the initial pilot.
- **No insurance verification.** Out of scope for v1.
- **No guardrail against double-booking from concurrent calls.**
  `bookAppointment` re-runs `checkSchedulingConflicts` server-side so two
  agents can't both succeed for the same slot, but the loser will get a
  conflict response and the agent will need to offer alternatives —
  document this in the QA pass.
