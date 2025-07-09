const axios = require('axios');

class RetellService {
  constructor() {
    this.apiKey = process.env.RETELL_API_KEY || 'key_5286e8b619b00ed6815991eba586';
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

  // Get all calls with optional filtering (uses POST /v2/list-calls)
  async getCalls(params = {}) {
    try {
      const response = await this.client.post('/v2/list-calls', {
        limit: parseInt(params.limit) || 50,
        offset: parseInt(params.offset) || 0,
        sort_order: params.sort_order || 'descending'
      });
      return response.data;
    } catch (error) {
      console.error('Failed to fetch calls:', error.message);
      throw new Error(`Failed to fetch calls: ${error.message}`);
    }
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

  // Get phone numbers
  async getPhoneNumbers() {
    try {
      const response = await this.client.get('/list-phone-numbers');
      return response.data;
    } catch (error) {
      throw new Error(`Failed to fetch phone numbers: ${error.message}`);
    }
  }
}

module.exports = new RetellService(); 