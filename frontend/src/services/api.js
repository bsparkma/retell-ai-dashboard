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

export const openDentalApi = {
  // Check Open Dental health
  getHealth: async () => {
    const response = await api.get('/od/health');
    return response.data;
  },

  // Get calendar appointments
  getCalendarAppointments: async (startDate, endDate) => {
    const response = await api.get('/od/calendar', {
      params: { startDate, endDate }
    });
    return response.data;
  },

  // Get available appointment slots (enhanced)
  getSlots: async (params = {}) => {
    const response = await api.post('/od/slots', params);
    return response.data;
  },

  // Book an appointment
  bookAppointment: async (bookingData) => {
    const response = await api.post('/od/book', bookingData);
    return response.data;
  },

  // Smart booking from call data
  smartBook: async (callData) => {
    const response = await api.post('/od/smart-book', callData);
    return response.data;
  },

  // Search patient by phone
  searchPatient: async (phone) => {
    const response = await api.get('/od/patient/search', { params: { phone } });
    return response.data;
  },

  // Get patient details
  getPatient: async (patNum) => {
    const response = await api.get(`/od/patient/${patNum}`);
    return response.data;
  },

  // Create new patient
  createPatient: async (patientData) => {
    const response = await api.post('/od/patient', patientData);
    return response.data;
  },
};

// Helper function to check if Open Dental is available
export const isOpenDentalEnabled = async () => {
  try {
    const health = await openDentalApi.getHealth();
    return health.enabled;
  } catch (error) {
    console.warn('Open Dental health check failed:', error);
    return false;
  }
};

export default api; 