const axios = require('axios');

// POST /v3/list-calls accepts a limit of 1-1000 and defaults to 50.
const MAX_LIST_CALLS_LIMIT = 1000;
const DEFAULT_LIST_CALLS_LIMIT = 50;

class RetellService {
  constructor() {
    this.apiKey = process.env.RETELL_API_KEY;
    if (!this.apiKey) {
      console.error('❌ RETELL_API_KEY environment variable is not set');
    }
    this.baseURL = 'https://api.retellai.com';
    
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        console.error('Retell API Error:', error.response?.data || error.message);
        throw error;
      }
    );
  }

  // Build the POST /v3/list-calls request body.
  // Only defined keys are sent — v3 rejects unknown/undefined values rather than ignoring
  // them, so building the object incrementally is deliberate.
  buildListCallsBody(params = {}) {
    const body = {};

    // v3 caps limit at 1000. Clamping here (rather than letting the API 400) keeps a
    // caller that asks for more from failing the whole sync.
    const parsedLimit = parseInt(params.limit, 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIST_CALLS_LIMIT;
    body.limit = Math.min(limit, MAX_LIST_CALLS_LIMIT);

    body.sort_order = params.sort_order || 'descending';

    // `pagination_key` and `skip` are mutually exclusive in v3 — sending both is a 400.
    // The cursor wins when present, which is what the paging loop in syncScheduler uses.
    if (params.pagination_key !== undefined && params.pagination_key !== null) {
      body.pagination_key = params.pagination_key;
    } else {
      // v3 renamed the legacy v2 `offset` to `skip`; accept either so existing callers
      // keep working unchanged.
      const parsedSkip = parseInt(params.skip ?? params.offset, 10);
      body.skip = Number.isFinite(parsedSkip) && parsedSkip > 0 ? parsedSkip : 0;
    }

    if (params.filter_criteria !== undefined && params.filter_criteria !== null) {
      body.filter_criteria = params.filter_criteria;
    }

    return body;
  }

  /**
   * Fetch one page of calls (uses POST /v3/list-calls).
   *
   * Returns the raw v3 envelope — { items, pagination_key, has_more } — so
   * pagination-aware callers can walk the cursor. Prefer this over getCalls() for
   * anything that needs more than the first page.
   */
  async getCallsPage(params = {}) {
    try {
      const response = await this.client.post('/v3/list-calls', this.buildListCallsBody(params));
      return response.data;
    } catch (error) {
      console.error('Failed to fetch calls:', error.message);
      throw new Error(`Failed to fetch calls: ${error.message}`);
    }
  }

  /**
   * Get calls as a plain array (uses POST /v3/list-calls).
   *
   * Retell removed the legacy POST /v2/list-calls on 2026-06-15. v3 answers with an
   * object envelope instead of a bare array, so this unwraps `.items` to keep the
   * array contract every existing caller already depends on.
   *
   * NOTE: v3 list responses deliberately omit `transcript`, `transcript_object`, and
   * `transcript_with_tool_calls` (they are the bulk of a call payload). `call_analysis`
   * and `disconnection_reason` are still included. Hydrate a transcript per call via
   * getCall()/getCallTranscript(), which still use the non-deprecated GET /v2/get-call.
   */
  async getCalls(params = {}) {
    const data = await this.getCallsPage(params);

    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
      // Loud rather than silent: if Retell changes the envelope again, we want a log
      // line, not an empty dashboard that looks like a quiet day at the office.
      console.warn(
        '⚠️ Retell POST /v3/list-calls returned an unexpected shape (expected { items: [...] }) — treating as empty'
      );
      return [];
    }

    return data.items;
  }

  // Get individual call details (uses GET /v2/get-call/{call_id})
  async getCall(callId) {
    try {
      const response = await this.client.get(`/v2/get-call/${callId}`);
      return response.data;
    } catch (error) {
      console.error(`Failed to fetch call ${callId}:`, error.message);
      throw new Error(`Failed to fetch call ${callId}: ${error.message}`);
    }
  }

  // Get call recording URL (individual call details contain recording_url)
  async getCallRecording(callId) {
    try {
      const call = await this.getCall(callId);
      return { recording_url: call.recording_url };
    } catch (error) {
      console.error(`Failed to fetch recording for call ${callId}:`, error.message);
      throw new Error(`Failed to fetch recording for call ${callId}: ${error.message}`);
    }
  }

  // Get call transcript (individual call details contain transcript)
  async getCallTranscript(callId) {
    try {
      const call = await this.getCall(callId);
      return { 
        transcript: call.transcript,
        transcript_object: call.transcript_object || []
      };
    } catch (error) {
      console.error(`Failed to fetch transcript for call ${callId}:`, error.message);
      throw new Error(`Failed to fetch transcript for call ${callId}: ${error.message}`);
    }
  }

  // Get all agents (uses GET /list-agents - no v2 prefix)
  async getAgents() {
    try {
      const response = await this.client.get('/list-agents');
      return response.data;
    } catch (error) {
      console.error('Failed to fetch agents:', error.message);
      throw new Error(`Failed to fetch agents: ${error.message}`);
    }
  }

  // Get individual agent details (uses GET /get-agent/{agent_id})
  async getAgent(agentId) {
    try {
      const response = await this.client.get(`/get-agent/${agentId}`);
      return response.data;
    } catch (error) {
      console.error(`Failed to fetch agent ${agentId}:`, error.message);
      throw new Error(`Failed to fetch agent ${agentId}: ${error.message}`);
    }
  }

  // Create a new agent (uses POST /create-agent)
  async createAgent(agentData) {
    try {
      const response = await this.client.post('/create-agent', agentData);
      return response.data;
    } catch (error) {
      console.error('Failed to create agent:', error.message);
      throw new Error(`Failed to create agent: ${error.message}`);
    }
  }

  // Update an agent (uses PATCH /update-agent/{agent_id})
  async updateAgent(agentId, agentData) {
    try {
      const response = await this.client.patch(`/update-agent/${agentId}`, agentData);
      return response.data;
    } catch (error) {
      console.error(`Failed to update agent ${agentId}:`, error.message);
      throw new Error(`Failed to update agent ${agentId}: ${error.message}`);
    }
  }

  /**
   * Get phone numbers (uses GET /v2/list-phone-numbers).
   *
   * The unversioned GET /list-phone-numbers was removed on 2026-06-15. v2 answers with
   * an { items, pagination_key, has_more } envelope, so unwrap `.items` — callers such
   * as routes/agents.js call .filter() straight on this result, and an unwrapped object
   * would throw a TypeError that silently falls through to the mock-number branch.
   */
  async getPhoneNumbers() {
    try {
      const response = await this.client.get('/v2/list-phone-numbers');
      const data = response.data;

      if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
        console.warn(
          '⚠️ Retell GET /v2/list-phone-numbers returned an unexpected shape (expected { items: [...] }) — treating as empty'
        );
        return [];
      }

      return data.items;
    } catch (error) {
      throw new Error(`Failed to fetch phone numbers: ${error.message}`);
    }
  }
}

module.exports = new RetellService(); 