import axios from 'axios';
import config from '../config/env';

const api = axios.create({
  baseURL: config.apiUrl,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor: attach DASHBOARD_API_TOKEN as a Bearer header so the
// backend's auth middleware (added in B-P0-08) accepts our requests.
api.interceptors.request.use(
  (req) => {
    if (config.dashboardApiToken) {
      req.headers = req.headers || {};
      req.headers['Authorization'] = `Bearer ${config.dashboardApiToken}`;
    }
    return req;
  },
  (error) => Promise.reject(error)
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
  // Get all calls (legacy endpoint)
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

// Unified Calls API - combines Retell AI + Mango Voice calls
export const unifiedCallsApi = {
  // Get all calls from all sources with unified filtering
  getCalls: async (params = {}) => {
    const response = await api.get('/unified-calls', { params });
    return response.data;
  },

  // Get call statistics
  getStats: async () => {
    const response = await api.get('/unified-calls/stats');
    return response.data;
  },

  // Get specific call by ID
  getCall: async (id) => {
    const response = await api.get(`/unified-calls/${id}`);
    return response.data;
  },

  // Get calls by phone number
  getCallsByPhone: async (phoneNumber) => {
    const response = await api.get(`/unified-calls/phone/${encodeURIComponent(phoneNumber)}`);
    return response.data;
  },

  // Sync calls from Retell API
  syncRetell: async (options = {}) => {
    const response = await api.post('/unified-calls/sync-retell', options);
    return response.data;
  },

  // Update a call (for manual corrections)
  updateCall: async (id, updates) => {
    const response = await api.patch(`/unified-calls/${id}`, updates);
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

export const mangoApi = {
  // On-demand: fetch Mango recording + transcript for a Mango call ID
  fetchRecordingAndTranscript: async (mangoCallId) => {
    const response = await api.post(`/mango/fetch/${encodeURIComponent(mangoCallId)}`);
    return response.data;
  },
};

export const openDentalApi = {
  // Health and sync status
  getHealth: async () => {
    const response = await api.get('/opendental/health');
    return response.data;
  },

  getSyncStatus: async () => {
    const response = await api.get('/opendental/sync/status');
    return response.data;
  },

  triggerSync: async () => {
    const response = await api.post('/opendental/sync/trigger');
    return response.data;
  },

  // Calendar and appointments
  getCalendar: async (params = {}) => {
    const response = await api.get('/opendental/calendar', { params });
    return response.data;
  },

  getCalendarAppointments: async (startDate, endDate) => {
    const response = await api.get('/opendental/calendar', {
      params: { startDate, endDate }
    });
    return response.data;
  },

  getAppointmentRange: async (params = {}) => {
    const response = await api.get('/opendental/appointments/range', { params });
    return response.data;
  },

  getAppointmentDetails: async (appointmentId) => {
    const response = await api.get(`/opendental/appointments/${appointmentId}`);
    return response.data;
  },

  // Conflict detection and smart scheduling
  checkConflicts: async (appointmentData) => {
    const response = await api.post('/opendental/appointments/check-conflicts', appointmentData);
    return response.data;
  },

  findSlots: async (searchCriteria) => {
    const response = await api.post('/opendental/appointments/find-slots', searchCriteria);
    return response.data;
  },

  getSlots: async (params = {}) => {
    const response = await api.post('/opendental/slots', params);
    return response.data;
  },

  // Appointment booking and management
  bookAppointment: async (appointmentData) => {
    const response = await api.post('/opendental/appointments', appointmentData);
    return response.data;
  },

  updateAppointment: async (appointmentId, updateData) => {
    const response = await api.put(`/opendental/appointments/${appointmentId}`, updateData);
    return response.data;
  },

  updateAppointmentStatus: async (appointmentId, status, notes = '') => {
    const response = await api.patch(`/opendental/appointments/${appointmentId}/status`, { status, notes });
    return response.data;
  },

  cancelAppointment: async (appointmentId, reason = '') => {
    const response = await api.delete(`/opendental/appointments/${appointmentId}`, { data: { reason } });
    return response.data;
  },

  // Patient management
  searchPatients: async (query) => {
    const response = await api.get('/opendental/patients/search', { params: { q: query } });
    return response.data;
  },

  searchPatient: async (phone) => {
    const response = await api.get('/opendental/patient/search', { params: { phone } });
    return response.data;
  },

  getPatientDetails: async (patientId) => {
    const response = await api.get(`/opendental/patients/${patientId}`);
    return response.data;
  },

  getPatient: async (patNum) => {
    const response = await api.get(`/opendental/patient/${patNum}`);
    return response.data;
  },

  verifyPatientAppointments: async (patientId, includeHistory = true) => {
    const response = await api.get(`/opendental/patients/${patientId}/appointments`, {
      params: { includeHistory }
    });
    return response.data;
  },

  createPatient: async (patientData) => {
    const response = await api.post('/opendental/patient', patientData);
    return response.data;
  },

  // Providers and operatories
  getProviders: async () => {
    const response = await api.get('/opendental/providers');
    return response.data;
  },

  getOperatories: async () => {
    const response = await api.get('/opendental/operatories');
    return response.data;
  },

  getProviderSchedule: async (providerId, date) => {
    const response = await api.get(`/opendental/providers/${providerId}/schedule`, {
      params: { date }
    });
    return response.data;
  },

  // Legacy methods for backward compatibility
  smartBook: async (callData) => {
    const response = await api.post('/opendental/smart-book', callData);
    return response.data;
  },

  // AI Agent specific endpoints
  ai: {
    smartBook: async (bookingRequest) => {
      const response = await api.post('/opendental/ai/smart-book', bookingRequest);
      return response.data;
    },

    verifyAppointment: async (searchParams) => {
      const response = await api.get('/opendental/ai/verify-appointment', { params: searchParams });
      return response.data;
    },

    getScheduleOverview: async (date, providerId = null) => {
      const response = await api.get('/opendental/ai/schedule-overview', {
        params: { date, providerId }
      });
      return response.data;
    }
  }
};

// Open Dental Sync API - for syncing calls to patient records
export const openDentalSyncApi = {
  // Get sync status overview
  getStatus: async () => {
    const response = await api.get('/opendental-sync/status');
    return response.data;
  },

  // Get calls that need manual patient linking
  getPendingLinks: async (limit = 50) => {
    const response = await api.get('/opendental-sync/pending-links', { params: { limit } });
    return response.data;
  },

  // Sync a specific call to CommLog
  syncCall: async (callId, options = {}) => {
    const response = await api.post(`/opendental-sync/calls/${callId}/sync`, options);
    return response.data;
  },

  // Get sync status for a specific call
  getCallSyncStatus: async (callId) => {
    const response = await api.get(`/opendental-sync/calls/${callId}/status`);
    return response.data;
  },

  // Link a call to a patient
  linkCallToPatient: async (callId, patientId, options = {}) => {
    const response = await api.post(`/opendental-sync/calls/${callId}/link`, {
      patientId,
      ...options
    });
    return response.data;
  },

  // Unlink a call from a patient
  unlinkCallFromPatient: async (callId) => {
    const response = await api.delete(`/opendental-sync/calls/${callId}/link`);
    return response.data;
  },

  // Search patients for linking
  searchPatients: async (query) => {
    const response = await api.get('/opendental-sync/patients/search', { params: { q: query } });
    return response.data;
  },

  // Get all calls for a patient
  getPatientCalls: async (patientId, limit = 50) => {
    const response = await api.get(`/opendental-sync/patients/${patientId}/calls`, { params: { limit } });
    return response.data;
  },

  // Find potential calls for a patient (suggestions)
  getPotentialCalls: async (patientId) => {
    const response = await api.get(`/opendental-sync/patients/${patientId}/potential-calls`);
    return response.data;
  },

  // Sync all pending calls
  syncAll: async (options = {}) => {
    const response = await api.post('/opendental-sync/sync-all', options);
    return response.data;
  },

  // Match all unmatched calls to patients
  matchAll: async (options = {}) => {
    const response = await api.post('/opendental-sync/match-all', options);
    return response.data;
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