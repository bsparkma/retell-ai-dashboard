import axios from 'axios';
import config from '../config/env';

const api = axios.create({
  baseURL: config.apiUrl,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor for adding auth tokens if needed
api.interceptors.request.use(
  (config) => {
    // Add auth token here if implementing authentication
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error('API Error:', error.response?.data || error.message);
    return Promise.reject(error);
  }
);

export const callsApi = {
  // Get all calls
  getCalls: async (params = {}) => {
    const response = await api.get('/calls', { params });
    return response.data;
  },

  // Get specific call
  getCall: async (id) => {
    const response = await api.get(`/calls/${id}`);
    return response.data;
  },

  // Get call transcript
  getCallTranscript: async (id) => {
    const response = await api.get(`/calls/${id}/transcript`);
    return response.data;
  },

  // Get call recording
  getCallRecording: async (id) => {
    const response = await api.get(`/calls/${id}/recording`);
    return response.data;
  },

  // Search calls
  searchCalls: async (query, filters = {}) => {
    const response = await api.post('/calls/search', { query, filters });
    return response.data;
  },
};

export const agentsApi = {
  // Get all agents
  getAgents: async () => {
    const response = await api.get('/agents');
    return response.data;
  },

  // Get specific agent
  getAgent: async (id) => {
    const response = await api.get(`/agents/${id}`);
    return response.data;
  },

  // Update agent
  updateAgent: async (id, data) => {
    const response = await api.patch(`/agents/${id}`, data);
    return response.data;
  },

  // Get agent phone numbers
  getAgentPhoneNumbers: async (id) => {
    const response = await api.get(`/agents/${id}/phone-numbers`);
    return response.data;
  },
};

export const healthApi = {
  // Health check
  getHealth: async () => {
    const response = await api.get('/health');
    return response.data;
  },
};

export default api; 