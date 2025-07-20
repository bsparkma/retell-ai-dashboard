const axios = require('axios');

class OpenDentalService {
  constructor() {
    this.apiUrl = process.env.OD_API_URL;
    this.apiKey = process.env.OD_API_KEY;
    this.enabled = !!(this.apiUrl && this.apiKey);
    
    if (this.enabled) {
      this.client = axios.create({
        baseURL: this.apiUrl,
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        }
      });
    }
  }

  isEnabled() {
    return this.enabled;
  }

  // Get calendar appointments for a specific date with view support
  async getCalendarAppointments(params = {}) {
    if (!this.enabled) {
      throw new Error('Open Dental service not configured');
    }

    try {
      const response = await this.client.get('/appointments/calendar', {
        params: {
          date: params.date,
          view: params.view || 'provider',
          providerIds: params.providerIds?.join(','),
          operatoryIds: params.operatoryIds?.join(',')
        }
      });

      // Transform the data to match our expected format
      return response.data.appointments?.map(apt => ({
        id: apt.AptNum || apt.id,
        patient: `${apt.PatientName || apt.FName || ''} ${apt.LName || ''}`.trim(),
        time: this.formatTime(apt.AptDateTime || apt.dateTime),
        duration: apt.AptLength || apt.duration || 30,
        type: apt.ProcDescript || apt.appointmentType || 'Appointment',
        status: this.mapAppointmentStatus(apt.AptStatus || apt.status),
        providerId: apt.ProvNum || apt.providerId,
        operatoryId: apt.Op || apt.operatoryId,
        notes: apt.Note || apt.notes || '',
        patientId: apt.PatNum || apt.patientId
      }));
    } catch (error) {
      console.error('Open Dental API error:', error.message);
      return null; // Return null to trigger mock data fallback
    }
  }

  // Get list of providers
  async getProviders() {
    if (!this.enabled) {
      throw new Error('Open Dental service not configured');
    }

    try {
      const response = await this.client.get('/providers');
      
      return response.data.providers?.map((provider, index) => ({
        id: provider.ProvNum || provider.id || index + 1,
        name: `${provider.FName || provider.firstName || ''} ${provider.LName || provider.lastName || ''}`.trim() || `Provider ${index + 1}`,
        color: this.getProviderColor(provider.ProvNum || provider.id || index)
      }));
    } catch (error) {
      console.error('Open Dental providers API error:', error.message);
      return null;
    }
  }

  // Get list of operatories
  async getOperatories() {
    if (!this.enabled) {
      throw new Error('Open Dental service not configured');
    }

    try {
      const response = await this.client.get('/operatories');
      
      return response.data.operatories?.map((op, index) => ({
        id: op.OperatoryNum || op.id || index + 1,
        name: op.OpName || op.name || `Op ${index + 1}`,
        color: this.getOperatoryColor(op.OperatoryNum || op.id || index)
      }));
    } catch (error) {
      console.error('Open Dental operatories API error:', error.message);
      return null;
    }
  }

  // Get available appointment slots
  async getAvailableSlots(params = {}) {
    if (!this.enabled) {
      throw new Error('Open Dental service not configured');
    }

    try {
      const response = await this.client.get('/appointments/slots', {
        params: {
          startDate: params.startDate,
          endDate: params.endDate,
          providerId: params.providerId,
          operatoryId: params.operatoryId,
          appointmentType: params.appointmentType,
          duration: params.duration
        }
      });

      return response.data.slots?.map(slot => ({
        id: slot.id,
        dateTime: slot.dateTime,
        duration: slot.duration,
        providerId: slot.providerId,
        operatoryId: slot.operatoryId,
        available: slot.available !== false
      }));
    } catch (error) {
      console.error('Open Dental slots API error:', error.message);
      throw error;
    }
  }

  // Book an appointment
  async bookAppointment(appointmentData) {
    if (!this.enabled) {
      throw new Error('Open Dental service not configured');
    }

    try {
      const response = await this.client.post('/appointments', {
        PatNum: appointmentData.patientId,
        ProvNum: appointmentData.providerId,
        Op: appointmentData.operatoryId,
        AptDateTime: appointmentData.dateTime,
        AptLength: appointmentData.duration,
        ProcDescript: appointmentData.appointmentType,
        Note: appointmentData.notes || '',
        AptStatus: 1 // Scheduled
      });

      return {
        id: response.data.AptNum,
        success: true,
        message: 'Appointment booked successfully'
      };
    } catch (error) {
      console.error('Open Dental booking API error:', error.message);
      throw error;
    }
  }

  // Update appointment status
  async updateAppointmentStatus(appointmentId, status) {
    if (!this.enabled) {
      throw new Error('Open Dental service not configured');
    }

    try {
      const response = await this.client.patch(`/appointments/${appointmentId}`, {
        AptStatus: this.mapStatusToOD(status)
      });

      return response.data;
    } catch (error) {
      console.error('Open Dental update status API error:', error.message);
      throw error;
    }
  }

  // Cancel appointment
  async cancelAppointment(appointmentId, reason = '') {
    if (!this.enabled) {
      throw new Error('Open Dental service not configured');
    }

    try {
      const response = await this.client.delete(`/appointments/${appointmentId}`, {
        data: { reason }
      });

      return response.data;
    } catch (error) {
      console.error('Open Dental cancel appointment API error:', error.message);
      throw error;
    }
  }

  // Search patients
  async searchPatients(query) {
    if (!this.enabled) {
      throw new Error('Open Dental service not configured');
    }

    try {
      const response = await this.client.get('/patients/search', {
        params: { q: query }
      });

      return response.data.patients?.map(patient => ({
        id: patient.PatNum || patient.id,
        firstName: patient.FName || patient.firstName,
        lastName: patient.LName || patient.lastName,
        phone: patient.HmPhone || patient.phone,
        email: patient.Email || patient.email,
        dateOfBirth: patient.Birthdate || patient.dateOfBirth
      }));
    } catch (error) {
      console.error('Open Dental patient search API error:', error.message);
      throw error;
    }
  }

  // Create new patient
  async createPatient(patientData) {
    if (!this.enabled) {
      throw new Error('Open Dental service not configured');
    }

    try {
      const response = await this.client.post('/patients', {
        FName: patientData.firstName,
        LName: patientData.lastName,
        Birthdate: patientData.dateOfBirth,
        HmPhone: patientData.phone || '',
        Email: patientData.email || '',
        Address: patientData.address || '',
        City: patientData.city || '',
        State: patientData.state || '',
        Zip: patientData.zip || ''
      });

      return {
        id: response.data.PatNum,
        firstName: response.data.FName,
        lastName: response.data.LName,
        success: true
      };
    } catch (error) {
      console.error('Open Dental create patient API error:', error.message);
      throw error;
    }
  }

  // Get appointment details
  async getAppointmentDetails(appointmentId) {
    if (!this.enabled) {
      throw new Error('Open Dental service not configured');
    }

    try {
      const response = await this.client.get(`/appointments/${appointmentId}`);
      const apt = response.data;

      return {
        id: apt.AptNum,
        patient: `${apt.PatientName || apt.FName || ''} ${apt.LName || ''}`.trim(),
        time: this.formatTime(apt.AptDateTime),
        duration: apt.AptLength,
        type: apt.ProcDescript,
        status: this.mapAppointmentStatus(apt.AptStatus),
        providerId: apt.ProvNum,
        operatoryId: apt.Op,
        notes: apt.Note,
        patientId: apt.PatNum
      };
    } catch (error) {
      console.error('Open Dental get appointment API error:', error.message);
      throw error;
    }
  }

  // Helper method to format time from datetime
  formatTime(dateTime) {
    if (!dateTime) return '00:00';
    
    try {
      const date = new Date(dateTime);
      return date.toTimeString().slice(0, 5); // HH:MM format
    } catch (error) {
      return '00:00';
    }
  }

  // Helper method to map Open Dental appointment status to our status
  mapAppointmentStatus(odStatus) {
    const statusMap = {
      1: 'scheduled',
      2: 'scheduled',
      3: 'scheduled',
      4: 'scheduled',
      5: 'confirmed',
      6: 'arrived',
      7: 'completed',
      8: 'cancelled',
      9: 'no_show'
    };
    
    return statusMap[odStatus] || 'scheduled';
  }

  // Helper method to map our status to Open Dental status
  mapStatusToOD(status) {
    const statusMap = {
      'scheduled': 1,
      'confirmed': 5,
      'arrived': 6,
      'completed': 7,
      'cancelled': 8,
      'no_show': 9
    };
    
    return statusMap[status] || 1;
  }

  // Helper method to get consistent provider colors
  getProviderColor(providerId) {
    const colors = [
      '#1976d2', '#388e3c', '#f57c00', '#7b1fa2', 
      '#c2185b', '#00796b', '#5d4037', '#455a64',
      '#e91e63', '#9c27b0', '#673ab7', '#3f51b5'
    ];
    
    return colors[providerId % colors.length];
  }

  // Helper method to get consistent operatory colors
  getOperatoryColor(operatoryId) {
    const colors = [
      '#c2185b', '#00796b', '#5d4037', '#455a64',
      '#e91e63', '#9c27b0', '#673ab7', '#3f51b5',
      '#1976d2', '#388e3c', '#f57c00', '#7b1fa2'
    ];
    
    return colors[operatoryId % colors.length];
  }

  // Legacy methods for backward compatibility
  async getSlots(params) {
    return this.getAvailableSlots(params);
  }

  async bookSlot(patNum, slot, defNumApptType) {
    return this.bookAppointment({
      patientId: patNum,
      dateTime: slot.dateTime,
      duration: slot.duration,
      appointmentType: defNumApptType,
      providerId: slot.providerId,
      operatoryId: slot.operatoryId
    });
  }

  async searchPatientByPhone(phone) {
    const patients = await this.searchPatients(phone);
    return patients || [];
  }

  async getPatient(patNum) {
    try {
      const response = await this.client.get(`/patients/${patNum}`);
      return response.data;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = new OpenDentalService(); 