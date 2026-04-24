/**
 * Retell Custom Function endpoints (a.k.a. "tools").
 *
 * What this is
 * ------------
 * During a live call the Retell agent can call these endpoints to look up
 * patients, find open appointment slots, book an appointment, or drop a
 * callback request. Each endpoint takes a small JSON payload and returns
 * a small JSON response that Retell incorporates into the agent's
 * speech.
 *
 * Reference: https://docs.retellai.com/build/custom-function
 *
 * Authentication
 * --------------
 * Retell signs custom-function calls with the same X-Retell-Signature
 * header it uses on regular webhooks, so we re-use the existing
 * verifier. This router is mounted under /api/retell-tools/* and is
 * exempted from the dashboard bearer-token auth in server.js (Retell
 * does not know about that token).
 *
 * Latency budget
 * --------------
 * Retell's docs strongly recommend tool responses < 2 seconds. Each
 * handler below imposes a 5-second hard timeout against Open Dental
 * and degrades gracefully (returns "I couldn't reach our scheduling
 * system, let me have someone call you back") instead of hanging.
 *
 * Pilot scope
 * -----------
 * For the first office these tools are shipped behind a feature flag
 * (RETELL_TOOLS_ENABLED). Until ops flips it on and pastes the matching
 * tool definitions into the Retell agent dashboard (see
 * docs/retell-tools.md), the agent will continue to take callbacks via
 * staff follow-up and these endpoints are simply unused.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const openDentalService = require('../config/openDental');
const openDentalSyncService = require('../services/openDentalSync');

// ---------------------------------------------------------------------------
// Per-tool enable/disable config
// ---------------------------------------------------------------------------
//
// Read at every handler invocation (file is small, ops can edit it without a
// restart). The global `RETELL_TOOLS_ENABLED` env var still gates ALL tools
// via the router-level middleware below — this per-tool flag only matters
// when that master switch is `true`.

const TOOLS_CONFIG_FILE = path.join(__dirname, '..', '..', 'data', 'retell-tools-config.json');

const TOOLS_CONFIG_DEFAULTS = {
  lookupPatient: true,
  findAvailableSlots: true,
  bookAppointment: false,
  createCallback: true,
};

function loadToolsConfig() {
  try {
    const raw = fs.readFileSync(TOOLS_CONFIG_FILE, 'utf8');
    return { ...TOOLS_CONFIG_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...TOOLS_CONFIG_DEFAULTS };
  }
}

// ---------------------------------------------------------------------------
// Booking idempotency cache
// ---------------------------------------------------------------------------
//
// Retell may retry a tool call if the first response is slow. Cache booking
// results by call_id for 30 minutes so retries return the same outcome
// without hitting Open Dental again.

const _bookingCache = new Map(); // callId → { result, expiresAt }
const BOOKING_CACHE_TTL_MS = 30 * 60 * 1000;

function getBookingCache(callId) {
  const entry = _bookingCache.get(callId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _bookingCache.delete(callId); return null; }
  return entry.result;
}

function setBookingCache(callId, result) {
  _bookingCache.set(callId, { result, expiresAt: Date.now() + BOOKING_CACHE_TTL_MS });
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _bookingCache) {
    if (now > entry.expiresAt) _bookingCache.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Signature verification (mirrors backend/routes/webhooks.js)
// ---------------------------------------------------------------------------

const SIGNATURE_PATTERN = /^v=(\d+),d=([0-9a-f]+)$/i;
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function verifyRetellSignature(req) {
  if (process.env.WEBHOOK_VERIFY_DISABLED === 'true') {
    console.warn(
      '⚠️ WEBHOOK_VERIFY_DISABLED=true — Retell tool signature NOT verified.'
    );
    return true;
  }

  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    console.error('❌ RETELL_API_KEY not set; cannot verify Retell tool call.');
    return false;
  }

  const header = req.headers['x-retell-signature'];
  if (!header) return false;

  const match = SIGNATURE_PATTERN.exec(header.trim());
  if (!match) return false;

  const timestamp = match[1];
  const providedHex = match[2];
  if (Math.abs(Date.now() - Number(timestamp)) > REPLAY_WINDOW_MS) return false;

  const rawBody = req.rawBody;
  if (typeof rawBody !== 'string') return false;

  const expectedHex = crypto
    .createHmac('sha256', apiKey)
    .update(rawBody + timestamp, 'utf8')
    .digest('hex');

  const a = Buffer.from(providedHex, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Common middleware
// ---------------------------------------------------------------------------

router.use((req, res, next) => {
  if (process.env.RETELL_TOOLS_ENABLED !== 'true') {
    return res.status(503).json({
      ok: false,
      message:
        'Tools are disabled. Set RETELL_TOOLS_ENABLED=true on the backend ' +
        'and register the tool definitions in the Retell dashboard.',
    });
  }
  if (!verifyRetellSignature(req)) {
    return res.status(401).json({ ok: false, message: 'invalid signature' });
  }
  next();
});

/**
 * Race a promise against a hard timeout. Returns either the resolved value
 * or the timeout-fallback value — never rejects.
 */
function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const TOOL_TIMEOUT_MS = 5000;

function digitsOnly(s) {
  return String(s || '').replace(/\D+/g, '');
}

// ---------------------------------------------------------------------------
// Tool 1 — lookup_patient
// ---------------------------------------------------------------------------

/**
 * POST /api/retell-tools/lookup_patient
 *
 * Body (from Retell):
 *   { args: { phone_number?: string, full_name?: string, date_of_birth?: string } }
 *
 * Response:
 *   { ok: true, found: boolean, patient?: {...}, alternatives?: [...] }
 *
 * The agent reads `found` and `patient.first_name` etc. It should NEVER
 * read patient.id back to the caller — that's an internal Open Dental key.
 */
router.post('/lookup_patient', async (req, res) => {
  const toolsConfig = loadToolsConfig();
  if (!toolsConfig.lookupPatient) {
    return res.json({ ok: false, message: 'Patient lookup is currently disabled.' });
  }

  const args = (req.body && req.body.args) || req.body || {};
  const phone = args.phone_number;
  const name = args.full_name;

  if (!phone && !name) {
    return res.json({
      ok: true,
      found: false,
      message: 'Need a phone number or a name to look up the patient.',
    });
  }

  try {
    const match = await withTimeout(
      openDentalSyncService.matchCallToPatient({
        caller_number: phone,
        caller_name: name,
      }),
      TOOL_TIMEOUT_MS,
      { patient: null, confidence: 0, method: 'timeout' }
    );

    if (!match.patient) {
      return res.json({
        ok: true,
        found: false,
        method: match.method,
        message:
          match.method === 'timeout'
            ? "I couldn't reach our scheduling system. Let me take a message."
            : "I couldn't find a matching patient record.",
      });
    }

    const p = match.patient;
    return res.json({
      ok: true,
      found: true,
      method: match.method,
      confidence: match.confidence,
      patient: {
        id: p.id,
        first_name: p.firstName,
        last_name: p.lastName,
        preferred_name: p.preferredName || null,
        date_of_birth: p.dateOfBirth || null,
        phone: p.phone || null,
      },
    });
  } catch (err) {
    console.error('[Retell tool] lookup_patient failed:', err.message);
    return res.json({
      ok: true,
      found: false,
      message: "I couldn't reach our scheduling system. Let me take a message.",
    });
  }
});

// ---------------------------------------------------------------------------
// Tool 2 — find_available_slots
// ---------------------------------------------------------------------------

/**
 * POST /api/retell-tools/find_available_slots
 *
 * Body args:
 *   {
 *     duration_minutes?: number,    // default 30
 *     provider_id?: number,          // optional, restricts to one provider
 *     operatory_id?: number,         // optional
 *     start_date?: string,           // YYYY-MM-DD; default today
 *     max_results?: number           // default 5
 *   }
 *
 * Returns up to N available slots in human-friendly form, e.g.
 *   { ok: true, slots: [{ display: "Tuesday, May 12 at 10:30 AM", iso: "...", ... }] }
 */
router.post('/find_available_slots', async (req, res) => {
  const toolsConfig = loadToolsConfig();
  if (!toolsConfig.findAvailableSlots) {
    return res.json({ ok: false, message: 'Slot finder is currently disabled.' });
  }

  const args = (req.body && req.body.args) || req.body || {};
  const duration = Number(args.duration_minutes) || 30;
  const providerId = args.provider_id ? Number(args.provider_id) : null;
  const operatoryId = args.operatory_id ? Number(args.operatory_id) : null;
  const maxResults = Math.min(Number(args.max_results) || 5, 10);

  const startDate = args.start_date ? new Date(args.start_date) : new Date();
  if (Number.isNaN(startDate.getTime())) {
    return res.json({
      ok: true,
      slots: [],
      message: "I didn't understand that date.",
    });
  }

  try {
    const baseAppt = {
      duration,
      providerId: providerId || 1, // openDentalService requires *some* provider for its working-hours lookup
      operatoryId: operatoryId || 1,
    };

    const slots = await withTimeout(
      (async () => {
        const out = [];
        for (let i = 0; i < 7 && out.length < maxResults; i++) {
          const day = new Date(startDate);
          day.setDate(day.getDate() + i);
          const daySlots = await openDentalService.findAvailableSlotsForDay(
            baseAppt,
            day
          );
          out.push(...daySlots);
        }
        return out.slice(0, maxResults);
      })(),
      TOOL_TIMEOUT_MS,
      []
    );

    if (slots.length === 0) {
      return res.json({
        ok: true,
        slots: [],
        message:
          "I'm not seeing any open slots in the next week with those constraints. Want me to take a message and have someone call you back?",
      });
    }

    return res.json({
      ok: true,
      slots: slots.map(s => ({
        iso: s.dateTime,
        display: formatSlotForSpeech(s.dateTime),
        provider_id: s.providerId,
        operatory_id: s.operatoryId,
      })),
    });
  } catch (err) {
    console.error('[Retell tool] find_available_slots failed:', err.message);
    return res.json({
      ok: true,
      slots: [],
      message: "I'm having trouble checking the schedule right now.",
    });
  }
});

function formatSlotForSpeech(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Tool 3 — book_appointment
// ---------------------------------------------------------------------------

/**
 * POST /api/retell-tools/book_appointment
 *
 * Body args:
 *   {
 *     patient_id: number,         // from lookup_patient
 *     date_time: string,          // ISO; from find_available_slots
 *     duration_minutes: number,
 *     provider_id?: number,
 *     operatory_id?: number,
 *     appointment_type?: string,
 *     notes?: string,
 *     is_new_patient?: boolean
 *   }
 *
 * Returns:
 *   - { ok: true, booked: true, appointment_id, message }
 *   - { ok: true, booked: false, conflicts, alternatives, message }
 *
 * The agent should always read `message` to the caller — it is phrased
 * for speech.
 */
router.post('/book_appointment', async (req, res) => {
  const toolsConfig = loadToolsConfig();
  if (!toolsConfig.bookAppointment) {
    return res.json({
      ok: true,
      booked: false,
      message: 'Live booking is currently disabled. I will take a message instead.',
    });
  }

  const args = (req.body && req.body.args) || req.body || {};
  const required = ['patient_id', 'date_time', 'duration_minutes'];
  for (const k of required) {
    if (args[k] === undefined || args[k] === null || args[k] === '') {
      return res.json({
        ok: true,
        booked: false,
        message: `I'm missing the ${k.replace(/_/g, ' ')}. Let me take a message.`,
      });
    }
  }

  // Idempotency: return cached result if Retell is retrying this call
  const bookCallId = args.call_id || null;
  if (bookCallId) {
    const cached = getBookingCache(bookCallId);
    if (cached) return res.json(cached);
  }

  const appointmentData = {
    patientId: Number(args.patient_id),
    dateTime: args.date_time,
    duration: Number(args.duration_minutes),
    providerId: args.provider_id ? Number(args.provider_id) : null,
    operatoryId: args.operatory_id ? Number(args.operatory_id) : null,
    type: args.appointment_type || 'Appointment',
    notes: args.notes || 'Booked via CareIN AI agent',
    isNew: !!args.is_new_patient,
  };

  try {
    const result = await withTimeout(
      openDentalService.bookAppointment(appointmentData),
      TOOL_TIMEOUT_MS,
      { success: false, message: 'timeout' }
    );

    if (result.success) {
      const payload = {
        ok: true,
        booked: true,
        appointment_id: result.appointmentId,
        message: `Great — you're booked for ${formatSlotForSpeech(args.date_time)}.`,
      };
      if (bookCallId) setBookingCache(bookCallId, payload);
      return res.json(payload);
    }

    const failPayload = {
      ok: true,
      booked: false,
      conflicts: result.conflicts || [],
      alternatives: (result.alternatives || []).slice(0, 3).map(a => ({
        iso: a.dateTime,
        display: formatSlotForSpeech(a.dateTime),
      })),
      message:
        result.message === 'timeout'
          ? "I couldn't confirm that booking with our scheduling system. Let me take a message and have someone call you back."
          : "That time isn't available. Would any of these work instead?",
    };
    if (bookCallId) setBookingCache(bookCallId, failPayload);
    return res.json(failPayload);
  } catch (err) {
    console.error('[Retell tool] book_appointment failed:', err.message);
    return res.json({
      ok: true,
      booked: false,
      message:
        "I couldn't complete the booking. Let me take a message and have someone call you back.",
    });
  }
});

// ---------------------------------------------------------------------------
// Tool 4 — create_callback
// ---------------------------------------------------------------------------

/**
 * POST /api/retell-tools/create_callback
 *
 * The fallback when the AI can't (or shouldn't) book live — emergencies,
 * insurance questions, complex reschedules, whatever. Drops an entry into
 * the same callback queue staff is already working from.
 *
 * Body args:
 *   {
 *     caller_name: string,
 *     caller_number: string,
 *     reason: string,
 *     priority?: 'emergency' | 'high' | 'medium' | 'low',
 *     call_id?: string,
 *     notes?: string
 *   }
 */
router.post('/create_callback', async (req, res) => {
  const toolsConfig = loadToolsConfig();
  if (!toolsConfig.createCallback) {
    return res.json({ ok: true, created: false, message: 'Callback logging is currently disabled.' });
  }

  const args = (req.body && req.body.args) || req.body || {};
  if (!args.reason || !args.caller_number) {
    return res.json({
      ok: true,
      created: false,
      message:
        "I need a phone number and a reason to take a message. Could you say those again?",
    });
  }

  try {
    const callbackPayload = {
      call_id: args.call_id || null,
      caller_name: args.caller_name || 'Unknown',
      caller_number: args.caller_number,
      reason: args.reason,
      priority: ['emergency', 'high', 'medium', 'low'].includes(args.priority)
        ? args.priority
        : 'medium',
      notes: args.notes || null,
    };

    // We deliberately persist inline here (atomic write to the same
    // data/callbacks.json that backend/routes/callbacks.js manages) rather
    // than firing an internal HTTP request. The callbacks router does not
    // export its persistence helpers, and a real round-trip would also
    // need to satisfy the dashboard bearer-token gate.
    const fs = require('fs').promises;
    const path = require('path');
    const dataDir = path.join(__dirname, '..', '..', 'data');
    await fs.mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, 'callbacks.json');
    let store = { callbacks: [], idCounter: 1 };
    try {
      const raw = await fs.readFile(file, 'utf8');
      store = JSON.parse(raw);
      if (!Array.isArray(store.callbacks)) store.callbacks = [];
      if (!Number.isInteger(store.idCounter)) store.idCounter = store.callbacks.length + 1;
    } catch (_) {
      /* file may not exist on first call */
    }

    // Deduplicate: if Retell retries this call, return the first callback created
    if (callbackPayload.call_id) {
      const existing = store.callbacks.find(cb => cb.call_id === callbackPayload.call_id);
      if (existing) {
        return res.json({
          ok: true,
          created: false,
          callback_id: existing.id,
          message: 'Got it. Someone from the office will call you back soon.',
        });
      }
    }

    const callback = {
      id: `cb_${store.idCounter++}`,
      ...callbackPayload,
      caller_number: digitsOnly(callbackPayload.caller_number),
      status: 'pending',
      due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: 'retell_agent',
    };
    store.callbacks.push(callback);

    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(store, null, 2));
    await fs.rename(tmp, file);

    try {
      const liveCallManager = require('../services/liveCallManager');
      if (liveCallManager.io) {
        liveCallManager.io.emit('callback:created', callback);
      }
    } catch (e) {
      /* socket emit is best-effort */
    }

    return res.json({
      ok: true,
      created: true,
      callback_id: callback.id,
      message: 'Got it. Someone from the office will call you back soon.',
    });
  } catch (err) {
    console.error('[Retell tool] create_callback failed:', err.message);
    return res.json({
      ok: true,
      created: false,
      message: "I had trouble saving that. Please try calling back in a few minutes.",
    });
  }
});

// ---------------------------------------------------------------------------
// Health probe (unsigned — useful for ops smoke testing).
// Intentionally returns the *enabled* flag and nothing else.
// ---------------------------------------------------------------------------

router.get('/health', (_req, res) => {
  const toolsConfig = loadToolsConfig();
  res.json({
    ok: true,
    enabled: process.env.RETELL_TOOLS_ENABLED === 'true',
    tools: {
      lookup_patient: toolsConfig.lookupPatient,
      find_available_slots: toolsConfig.findAvailableSlots,
      book_appointment: toolsConfig.bookAppointment,
      create_callback: toolsConfig.createCallback,
    },
  });
});

module.exports = router;
