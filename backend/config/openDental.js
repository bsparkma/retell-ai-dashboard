const axios = require('axios');

class OpenDentalService {
  constructor() {
    this.apiUrl = process.env.OD_API_URL;
    this.apiKey = process.env.OD_API_KEY;
    
    if (!this.apiUrl || !this.apiKey) {
      console.warn('⚠️ Open Dental credentials not configured. OD integration disabled.');
      this.enabled = false;
      return;
    }
    
    this.enabled = true;
    this.client = axios.create({
      baseURL: this.apiUrl,
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
        console.error('Open Dental API Error:', error.response?.data || error.message);
        throw error;
      }
    );
  }

  // Check if Open Dental is available
  isEnabled() {
    return this.enabled;
  }

  // Get appointment slots with enhanced filtering
  async getSlots(params = {}) {
    if (!this.enabled) {
      throw new Error('Open Dental not configured');
    }

    try {
      const queryParams = {
        startDate: params.startDate || new Date().toISOString().split('T')[0],
        endDate: params.endDate,
        providerIds: params.providerIds,
        includeBooked: params.includeBooked || true,
        appointmentTypes: params.appointmentTypes,
        ...params
      };

      const response = await this.client.get('/appointments/slots', { 
        params: queryParams 
      });
      
      return response.data;
    } catch (error) {
      console.error('Failed to fetch appointment slots:', error.message);
      throw new Error(`Failed to fetch slots: ${error.message}`);
    }
  }

  // Get appointments for calendar view
  async getCalendarAppointments(startDate, endDate) {
    if (!this.enabled) {
      throw new Error('Open Dental not configured');
    }

    try {
      const response = await this.client.get('/appointments/calendar', {
        params: {
          startDate,
          endDate,
          includePatientInfo: true,
          includeProviderInfo: true
        }
      });
      
      return response.data;
    } catch (error) {
      console.error('Failed to fetch calendar appointments:', error.message);
      throw new Error(`Failed to fetch calendar appointments: ${error.message}`);
    }
  }

  // Book an appointment slot
  async bookSlot(patNum, slot, defNumApptType) {
    if (!this.enabled) {
      throw new Error('Open Dental not configured');
    }

    try {
      // First create a planned appointment
      const plannedResponse = await this.client.post('/appointments/planned', {
        PatNum: patNum,
        defNumApptType: defNumApptType
      });

      // Then schedule the planned appointment
      const appointmentData = {
        AptNum: plannedResponse.data.AptNum,
        AptDateTime: slot.DateTimeStart,
        ProvNum: slot.ProvNum,
        Op: slot.OpNum
      };

      const response = await this.client.post('/appointments/schedulePlanned', appointmentData);
      return response.data;
    } catch (error) {
      if (error.response?.status === 409) {
        throw new Error('Appointment slot already booked');
      }
      console.error('Failed to book appointment:', error.message);
      throw new Error(`Failed to book appointment: ${error.message}`);
    }
  }

  // Get patient information
  async getPatient(patNum) {
    if (!this.enabled) {
      throw new Error('Open Dental not configured');
    }

    try {
      const response = await this.client.get(`/patients/${patNum}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch patient:', error.message);
      throw new Error(`Failed to fetch patient: ${error.message}`);
    }
  }

  // Search for patients by phone number
  async searchPatientByPhone(phoneNumber) {
    if (!this.enabled) {
      throw new Error('Open Dental not configured');
    }

    try {
      const response = await this.client.get('/patients/search', {
        params: { phone: phoneNumber }
      });
      return response.data;
    } catch (error) {
      console.error('Failed to search patient:', error.message);
      throw new Error(`Failed to search patient: ${error.message}`);
    }
  }

  // Create a new patient
  async createPatient(patientData) {
    if (!this.enabled) {
      throw new Error('Open Dental not configured');
    }

    try {
      const response = await this.client.post('/patients', patientData);
      return response.data;
    } catch (error) {
      console.error('Failed to create patient:', error.message);
      throw new Error(`Failed to create patient: ${error.message}`);
    }
  }
}

module.exports = new OpenDentalService(); 