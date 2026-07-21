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

// Remember which unmapped agent ids we've already warned about, so the fallback
// warning fires once per agent id per process instead of on every call.
const warnedUnmappedAgents = new Set();

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
 * Resolve the office a call belongs to. Unmapped agents (and agent-less calls)
 * fall back to Roland and warn once.
 * @param {{ handler_id?: string, agent_id?: string|number }} call
 * @returns {string} officeId
 */
const getOfficeForCall = (call) => {
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
  getAgentId,
  getOfficeForCall,
  getOfficeConfig,
  getAllOfficeConfigs,
  isAgentAllowedForOffice,
  filterAgentsForOffice,
  filterCallsForOffice,
};
