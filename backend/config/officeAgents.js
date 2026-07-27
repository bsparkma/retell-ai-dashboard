// Office ↔ agent configuration (REAL mapping — not demo config).
//
// Every inbound call is routed to exactly one office by looking up the Retell
// agent that handled it. On stored unified calls the agent id lives in
// `handler_id` (a.k.a. `agent_id` on some raw shapes), so we key on both.
//
// Current reality is single-office: everything belongs to **Roland**. Valley
// Fort Smith is defined but has NO agents mapped yet and NO OD connection — it
// must render as an empty worklist with the "OD not connected for this office
// yet" state, NOT a copy of Roland's calls. When Valley goes live, adding it is
// literally ONE line: map its agent id to 'valley' in AGENT_OFFICE below.
//
// Agent ids below were discovered from the live call store (data/unified_calls.json,
// 1,333 calls) on 2026-07-20. Any agent id NOT listed here — and any call with no
// agent id at all — falls back to FALLBACK_OFFICE (Roland) and is logged once as a
// warning, so a genuinely new/Valley agent surfacing gets noticed.

/**
 * @typedef {Object} OfficeConfig
 * @property {string}  officeId     stable id used in the office_id query param
 * @property {string}  officeName   display name for the office selector
 * @property {boolean} odConnected  false → UI shows "OD not connected for this office yet"
 */

// Internal office KEYS (roland / valley / unknown) are FROZEN identifiers used in
// the office_id query param, the line map, and stored calls — never rename them.
// Display LABELS (officeName) are separate and may change freely. Note: internal
// key 'valley' IS the Fort Smith "Riley" office (historical name); the key stays
// frozen even though the office is branded/known as Riley.
/** @type {Record<string, OfficeConfig>} */
const OFFICES = {
  roland: { officeId: 'roland', officeName: 'Roland', odConnected: true },
  valley: { officeId: 'valley', officeName: 'Valley Fort Smith', odConnected: false },
  // Bucket for Mango calls whose called line isn't in MANGO_LINE_OFFICE yet. These
  // still ingest and stay triageable; the UI surfaces the raw line so an admin can
  // see which number to add. odConnected:false → no OD write path.
  unknown: { officeId: 'unknown', officeName: 'Unmapped', odConnected: false },
};

// The office any unmapped Retell agent (or a call with no agent id) belongs to today.
// NOTE: this is the RETELL fallback only. Unmapped Mango LINES go to UNMAPPED_OFFICE
// ('unknown'), NOT here — an unknown DID must never be silently attributed to Roland.
const FALLBACK_OFFICE = 'roland';

// Where an unmapped Mango line lands. Honest 'unknown' instead of a silent Roland.
const UNMAPPED_OFFICE = 'unknown';

/**
 * Retell agent_id → officeId. Add a Valley agent later = ONE entry here.
 * Comment on each line is the agent's display name at discovery time.
 * @type {Record<string, string>}
 */
const AGENT_OFFICE = {
  agent_3a7042b50e7c4775cd350f02b4: 'roland', // Phone attendant
  agent_d1f762efc57db01475ad0579e8: 'roland', // After Hours Demo (revised 4.29.26) / (copy)
  agent_063d7e3077f6dc708c54a19d20: 'roland', // After Hours Demo
  agent_89e8a68788e925aa506475393e: 'roland', // Charlie Jo (copy)
  agent_3007741dd93381f51675417edb: 'roland', // Charlie Jo
  agent_fab86b38f60a3561b16831bea8: 'roland', // Valley Family Dental by Ameer — see NOTE below
  agent_4a553eece68d214e364e85d4d4: 'roland', // Single-Prompt Agent
  agent_ace28f92effcafe7254c004713: 'roland', // Multi-State Agent
  agent_8494abf7556bfd9a4cf231a1a1: 'roland', // IV Outbound Agent (Bridge-it)
  // NOTE: "Valley Family Dental by Ameer" is a Valley-branded test agent but is
  // mapped to Roland for now per the single-office reality. When Valley's OD
  // connection lands (per-location slice), change its mapping to 'valley'.
};

// ── Mango (staff) line → office ──────────────────────────────────────────────
// Mango staff calls carry NO Retell agent id, so they can't be attributed by
// AGENT_OFFICE. Instead they're attributed by the office phone LINE that was
// called — the Mango `called_number` (DID), later also `pbx_uuid`. Keyed on the
// E.164-normalized number so formatting differences ((479) 555-0000 vs
// +14795550000) don't matter.
//
// Real office DIDs supplied by Beau. Keys are E.164-normalized. This is the single
// source of truth for line→office attribution — structured as DATA (an E.164→officeId
// table) precisely so a future office-management admin UI can edit the SAME object.
// Valley/Riley is mapped for ATTRIBUTION only — OFFICES.valley is odConnected:false, so
// its calls are attributed but have no OD write path until the per-location slice.
// Any called_number NOT here → UNMAPPED_OFFICE ('unknown') + warn-once (never Roland).
/** @type {Record<string, string>} E.164 DID → officeId (frozen internal key) */
const MANGO_LINE_OFFICE = {
  // Roland Family Dental
  '+19189134595': 'roland', // 918-913-4595
  '+19185036262': 'roland', // 918-503-6262 (main line)
  '+19183930353': 'roland', // 918-393-0353
  // Valley Family Dental — the Fort Smith "Riley" office (internal key 'valley' frozen)
  '+14797854390': 'valley', // 479-785-4390
  '+14793166111': 'valley', // 479-316-6111
  '+14797851419': 'valley', // 479-785-1419
  '+14792263500': 'valley', // 479-226-3500
  '+14797633344': 'valley', // 479-763-3344
};

/**
 * Normalize a phone number to canonical E.164 (+1XXXXXXXXXX for NANP). Best-effort:
 * 10 digits → +1XXXXXXXXXX; 11 digits starting with 1 → +1XXXXXXXXXX; already-+ →
 * digits re-wrapped. Returns null when there aren't enough digits to be a real line.
 * @param {string|number|null|undefined} number
 * @returns {string|null}
 */
const normalizeE164 = (number) => {
  if (number == null) return null;
  const digits = String(number).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 11) return `+${digits}`; // already includes a country code
  return null; // too short to be a usable line
};

// Remember which unmapped agent ids / Mango lines we've already warned about, so the
// fallback warning fires once per id per process instead of on every call.
const warnedUnmappedAgents = new Set();
const warnedUnmappedLines = new Set();

/**
 * Read the handling agent id off a call, tolerating both stored (`handler_id`)
 * and raw (`agent_id`) shapes.
 * @param {{ handler_id?: string, agent_id?: string|number }} call
 * @returns {string|null}
 */
const getAgentId = (call) => {
  const raw = call && (call.handler_id ?? call.agent_id);
  return raw != null && raw !== '' ? String(raw) : null;
};

/**
 * Resolve the office a call belongs to.
 *   - Mango (staff) calls: attributed by the office LINE that was called
 *     (E.164-normalized `called_number` → MANGO_LINE_OFFICE). Unmapped line →
 *     fallback office + warn once.
 *   - Retell (AI) calls: attributed by the handling agent (AGENT_OFFICE).
 *     Unmapped agent / agent-less → fallback office + warn once.
 * @param {{ source?: string, called_number?: string, handler_id?: string, agent_id?: string|number }} call
 * @returns {string} officeId
 */
const getOfficeForCall = (call) => {
  // Mango staff calls have no Retell agent id — attribute by the called line.
  if (call && call.source === 'mango') {
    const line = normalizeE164(call.called_number);
    if (line && MANGO_LINE_OFFICE[line]) {
      return MANGO_LINE_OFFICE[line];
    }
    // Unmapped line → honest 'unknown' (NOT Roland). The call still ingests and is
    // triageable; the worklist surfaces the raw line so Beau can see which DID to add.
    const warnKey = line || '(no-line)';
    if (!warnedUnmappedLines.has(warnKey)) {
      warnedUnmappedLines.add(warnKey);
      console.warn(
        `[officeAgents] Unmapped Mango line '${warnKey}' — attributing to '${UNMAPPED_OFFICE}' ` +
        `(NOT Roland). Add its DID to MANGO_LINE_OFFICE to assign it to an office.`
      );
    }
    return UNMAPPED_OFFICE;
  }

  const agentId = getAgentId(call);
  if (agentId && AGENT_OFFICE[agentId]) {
    return AGENT_OFFICE[agentId];
  }
  if (agentId && !warnedUnmappedAgents.has(agentId)) {
    warnedUnmappedAgents.add(agentId);
    console.warn(
      `[officeAgents] Unmapped agent '${agentId}' — routing to fallback office ` +
      `'${FALLBACK_OFFICE}'. Add it to AGENT_OFFICE to assign it explicitly.`
    );
  }
  return FALLBACK_OFFICE;
};

/**
 * Get configuration for a specific office. Unknown/absent/"all"/"default"
 * office ids return null (caller treats null as "no office scoping").
 * @param {string} [officeId]
 * @returns {OfficeConfig|null}
 */
const getOfficeConfig = (officeId) => {
  if (!officeId || officeId === 'default' || officeId === 'all') return null;
  return OFFICES[officeId] || null;
};

/**
 * Real offices for the worklist office selector, in display order. Excludes the
 * 'unknown' system bucket — unmapped-line calls surface in the "All calls" view
 * with an "Unmapped line" affordance rather than as a permanent empty office tab.
 * @returns {OfficeConfig[]}
 */
const getAllOfficeConfigs = () =>
  Object.values(OFFICES).filter((o) => o.officeId !== UNMAPPED_OFFICE);

/**
 * Whether an agent is allowed for an office. Empty/"all"/"default" → allowed.
 * @param {string|number} agentId
 * @param {string} [officeId]
 * @returns {boolean}
 */
const isAgentAllowedForOffice = (agentId, officeId) => {
  if (!officeId || officeId === 'default' || officeId === 'all') return true;
  const id = agentId != null ? String(agentId) : null;
  if (!id) return officeId === FALLBACK_OFFICE; // agent-less → fallback office only
  return (AGENT_OFFICE[id] || FALLBACK_OFFICE) === officeId;
};

/**
 * Filter an agents list down to a single office.
 * @param {Array<{agent_id?: string, id?: string}>} agents
 * @param {string} [officeId]
 */
const filterAgentsForOffice = (agents, officeId) => {
  if (!officeId || officeId === 'default' || officeId === 'all') return agents;
  return agents.filter((agent) =>
    isAgentAllowedForOffice(agent.agent_id ?? agent.id, officeId)
  );
};

/**
 * Filter a calls list down to a single office by resolving each call's agent.
 * Empty/"all"/"default" → returns all calls unchanged. An office with no mapped
 * agents (e.g. Valley today) correctly returns [].
 * @param {Array<{handler_id?: string, agent_id?: string|number}>} calls
 * @param {string} [officeId]
 */
const filterCallsForOffice = (calls, officeId) => {
  if (!officeId || officeId === 'default' || officeId === 'all') return calls;
  return calls.filter((call) => getOfficeForCall(call) === officeId);
};

module.exports = {
  OFFICES,
  FALLBACK_OFFICE,
  UNMAPPED_OFFICE,
  AGENT_OFFICE,
  MANGO_LINE_OFFICE,
  normalizeE164,
  getAgentId,
  getOfficeForCall,
  getOfficeConfig,
  getAllOfficeConfigs,
  isAgentAllowedForOffice,
  filterAgentsForOffice,
  filterCallsForOffice,
};
