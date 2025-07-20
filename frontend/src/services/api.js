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
  // Health and sync status
  getHealth: async () => {
    const response = await api.get('/od/health');
    return response.data;
  },

  getSyncStatus: async () => {
    const response = await api.get('/od/sync/status');
    return response.data;
  },

  triggerSync: async () => {
    const response = await api.post('/od/sync/trigger');
    return response.data;
  },

  // Calendar and appointments
  getCalendar: async (params = {}) => {
    const response = await api.get('/od/calendar', { params });
    return response.data;
  },

  getCalendarAppointments: async (startDate, endDate) => {
    const response = await api.get('/od/calendar', {
      params: { startDate, endDate }
    });
    return response.data;
  },

  getAppointmentRange: async (params = {}) => {
    const response = await api.get('/od/appointments/range', { params });
    return response.data;
  },

  getAppointmentDetails: async (appointmentId) => {
    const response = await api.get(`/od/appointments/${appointmentId}`);
    return response.data;
  },

  // Conflict detection and smart scheduling
  checkConflicts: async (appointmentData) => {
    const response = await api.post('/od/appointments/check-conflicts', appointmentData);
    return response.data;
  },

  findSlots: async (searchCriteria) => {
    const response = await api.post('/od/appointments/find-slots', searchCriteria);
    return response.data;
  },

  getSlots: async (params = {}) => {
    const response = await api.post('/od/slots', params);
    return response.data;
  },

  // Appointment booking and management
  bookAppointment: async (appointmentData) => {
    const response = await api.post('/od/appointments', appointmentData);
    return response.data;
  },

  updateAppointment: async (appointmentId, updateData) => {
    const response = await api.put(`/od/appointments/${appointmentId}`, updateData);
    return response.data;
  },

  updateAppointmentStatus: async (appointmentId, status, notes = '') => {
    const response = await api.patch(`/od/appointments/${appointmentId}/status`, { status, notes });
    return response.data;
  },

  cancelAppointment: async (appointmentId, reason = '') => {
    const response = await api.delete(`/od/appointments/${appointmentId}`, { data: { reason } });
    return response.data;
  },

  // Patient management
  searchPatients: async (query) => {
    const response = await api.get('/od/patients/search', { params: { q: query } });
    return response.data;
  },

  searchPatient: async (phone) => {
    const response = await api.get('/od/patient/search', { params: { phone } });
    return response.data;
  },

  getPatientDetails: async (patientId) => {
    const response = await api.get(`/od/patients/${patientId}`);
    return response.data;
  },

  getPatient: async (patNum) => {
    const response = await api.get(`/od/patient/${patNum}`);
    return response.data;
  },

  verifyPatientAppointments: async (patientId, includeHistory = true) => {
    const response = await api.get(`/od/patients/${patientId}/appointments`, {
      params: { includeHistory }
    });
    return response.data;
  },

  createPatient: async (patientData) => {
    const response = await api.post('/od/patient', patientData);
    return response.data;
  },

  // Providers and operatories
  getProviders: async () => {
    const response = await api.get('/od/providers');
    return response.data;
  },

  getOperatories: async () => {
    const response = await api.get('/od/operatories');
    return response.data;
  },

  getProviderSchedule: async (providerId, date) => {
    const response = await api.get(`/od/providers/${providerId}/schedule`, {
      params: { date }
    });
    return response.data;
  },

  // Legacy methods for backward compatibility
  smartBook: async (callData) => {
    const response = await api.post('/od/smart-book', callData);
    return response.data;
  },

  // AI Agent specific endpoints
  ai: {
    smartBook: async (bookingRequest) => {
      const response = await api.post('/od/ai/smart-book', bookingRequest);
      return response.data;
    },

    verifyAppointment: async (searchParams) => {
      const response = await api.get('/od/ai/verify-appointment', { params: searchParams });
      return response.data;
    },

    getScheduleOverview: async (date, providerId = null) => {
      const response = await api.get('/od/ai/schedule-overview', {
        params: { date, providerId }
      });
      return response.data;
    }
  }
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