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

/** @type {Record<string, OfficeConfig>} */
const OFFICES = {
  roland: { officeId: 'roland', officeName: 'Roland', odConnected: true },
  valley: { officeId: 'valley', officeName: 'Valley Fort Smith', odConnected: false },
};

// The office any unmapped agent (or a call with no agent id) belongs to today.
const FALLBACK_OFFICE = 'roland';

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
// Real office DIDs supplied by Beau (2026-07-21). Keys are E.164-normalized. Valley is
// mapped for ATTRIBUTION only — OFFICES.valley is odConnected:false, so its calls are
// attributed to Valley but have no OD write path until the per-location slice (mirrors
// the existing office-config pattern). Any called_number not here → fallback + warn-once.
/** @type {Record<string, string>} E.164 DID → officeId */
const MANGO_LINE_OFFICE = {
  '+19185036262': 'roland', // Roland Family Dental main line (918-503-6262)
  '+14792263500': 'valley', // Valley Family Dental (479-226-3500) — attribution only (odConnected:false)
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
    const warnKey = line || '(no-line)';
    if (!warnedUnmappedLines.has(warnKey)) {
      warnedUnmappedLines.add(warnKey);
      console.warn(
        `[officeAgents] Unmapped Mango line '${warnKey}' — routing to fallback office ` +
        `'${FALLBACK_OFFICE}'. Add its DID to MANGO_LINE_OFFICE to assign it explicitly.`
      );
    }
    return FALLBACK_OFFICE;
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
 * All real offices, for the worklist office selector. Order is display order.
 * @returns {OfficeConfig[]}
 */
const getAllOfficeConfigs = () => Object.values(OFFICES);

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
