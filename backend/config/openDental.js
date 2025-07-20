const axios = require('axios');
const EventEmitter = require('events');

class OpenDentalService extends EventEmitter {
  constructor() {
    super();
    this.apiUrl = process.env.OD_API_URL;
    this.apiKey = process.env.OD_API_KEY;
    this.enabled = !!(this.apiUrl && this.apiKey);
    this.syncInterval = null;
    this.lastSyncTime = null;
    this.conflicts = new Map(); // Track scheduling conflicts
    this.bookingQueue = []; // Queue for booking operations
    
    if (this.enabled) {
      this.client = axios.create({
        baseURL: this.apiUrl,
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      // Setup request/response interceptors
      this.setupInterceptors();
      
      // Start real-time sync
      this.startRealTimeSync();
    }
  }

  setupInterceptors() {
    // Request interceptor
    this.client.interceptors.request.use(
      (config) => {
        console.log(`[OD API] ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        console.error('[OD API] Request Error:', error.message);
        return Promise.reject(error);
      }
    );

    // Response interceptor  
    this.client.interceptors.response.use(
      (response) => {
        console.log(`[OD API] Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        console.error('[OD API] Response Error:', error.response?.data || error.message);
        this.handleApiError(error);
        return Promise.reject(error);
      }
    );
  }

  handleApiError(error) {
    const errorInfo = {
      status: error.response?.status,
      message: error.response?.data?.message || error.message,
      endpoint: error.config?.url,
      timestamp: new Date().toISOString()
    };
    
    // Emit error event for monitoring
    this.emit('apiError', errorInfo);
    
    // Handle specific error types
    if (error.response?.status === 401) {
      this.emit('authError', errorInfo);
    } else if (error.response?.status === 409) {
      this.emit('conflictError', errorInfo);
    }
  }

  // ============================================================================
  // REAL-TIME SYNC FUNCTIONALITY
  // ============================================================================

  startRealTimeSync(intervalMinutes = 3) {
    if (!this.enabled) return;
    
    console.log(`[OD Sync] Starting real-time sync every ${intervalMinutes} minutes`);
    
    // Initial sync
    this.performSync();
    
    // Set up interval
    this.syncInterval = setInterval(() => {
      this.performSync();
    }, intervalMinutes * 60 * 1000);
  }

  stopRealTimeSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log('[OD Sync] Real-time sync stopped');
    }
  }

  async performSync() {
    try {
      console.log('[OD Sync] Starting sync operation...');
      
      const syncData = await this.getSyncData();
      
      // Update last sync time
      this.lastSyncTime = new Date().toISOString();
      
      // Emit sync event with data
      this.emit('syncComplete', {
        timestamp: this.lastSyncTime,
        data: syncData
      });
      
      console.log('[OD Sync] Sync completed successfully');
      
    } catch (error) {
      console.error('[OD Sync] Sync failed:', error.message);
      this.emit('syncError', {
        timestamp: new Date().toISOString(),
        error: error.message
      });
    }
  }

  async getSyncData() {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const [appointments, providers, operatories, patients] = await Promise.all([
      this.getAppointmentsForDateRange(today, tomorrow),
      this.getProviders(),
      this.getOperatories(),
      this.getRecentPatientUpdates()
    ]);

    return {
      appointments,
      providers,
      operatories,
      patients,
      lastSync: this.lastSyncTime
    };
  }

  // ============================================================================
  // ENHANCED CALENDAR DATA RETRIEVAL
  // ============================================================================

  async getCalendarAppointments(params = {}) {
    if (!this.enabled) {
      return this.getMockCalendarData(params);
    }

    try {
      const queryParams = {
        date: params.date || new Date().toISOString().split('T')[0],
        includePatientInfo: true,
        includeProviderInfo: true,
        includeOperatoryInfo: true
      };

      if (params.providerIds?.length) {
        queryParams.providerIds = params.providerIds.join(',');
      }

      if (params.operatoryIds?.length) {
        queryParams.operatoryIds = params.operatoryIds.join(',');
      }

      const response = await this.client.get('/appointments', { params: queryParams });
      
      return this.transformAppointmentData(response.data);

    } catch (error) {
      console.error('[OD API] Calendar fetch failed:', error.message);
      return this.getMockCalendarData(params);
    }
  }

  async getAppointmentsForDateRange(startDate, endDate) {
    if (!this.enabled) {
      return [];
    }

    try {
      const response = await this.client.get('/appointments', {
        params: {
          startDate: startDate.toISOString().split('T')[0],
          endDate: endDate.toISOString().split('T')[0],
          includePatientInfo: true,
          includeProviderInfo: true
        }
      });

      return this.transformAppointmentData(response.data);
    } catch (error) {
      console.error('[OD API] Date range fetch failed:', error.message);
      return [];
    }
  }

  transformAppointmentData(rawData) {
    if (!rawData || !Array.isArray(rawData)) return [];

    return rawData.map(apt => ({
      id: apt.AptNum || apt.id,
      patient: this.formatPatientName(apt),
      patientId: apt.PatNum || apt.patientId,
      time: this.formatTime(apt.AptDateTime || apt.dateTime),
      dateTime: apt.AptDateTime || apt.dateTime,
      duration: apt.Pattern ? this.calculateDurationFromPattern(apt.Pattern) : (apt.duration || 30),
      type: apt.ProcDescript || apt.appointmentType || 'Appointment',
      status: this.mapAppointmentStatus(apt.AptStatus || apt.status),
      providerId: apt.ProvNum || apt.providerId,
      providerName: apt.ProviderName || apt.providerName,
      operatoryId: apt.Op || apt.operatoryId,
      operatoryName: apt.OperatoryName || apt.operatoryName,
      notes: apt.Note || apt.notes || '',
      confirmed: apt.Confirmed || false,
      isNew: apt.IsNewPatient || false,
      phone: apt.HmPhone || apt.WkPhone || apt.phone,
      email: apt.Email || apt.email,
      lastModified: apt.DateTStamp || apt.lastModified,
      conflicts: this.checkForConflicts(apt)
    }));
  }

  formatPatientName(apt) {
    const first = apt.FName || apt.firstName || '';
    const last = apt.LName || apt.lastName || '';
    const preferred = apt.Preferred || apt.preferredName || '';
    
    if (preferred) return `${preferred} ${last}`.trim();
    return `${first} ${last}`.trim() || 'Unknown Patient';
  }

  calculateDurationFromPattern(pattern) {
    // Open Dental uses patterns like "/X/X/X/" where X = 10-15 minute increments
    if (!pattern) return 30;
    const xCount = (pattern.match(/X/g) || []).length;
    const increment = 15; // Default 15-minute increments
    return xCount * increment;
  }

  // ============================================================================
  // CONFLICT DETECTION AND SMART SCHEDULING
  // ============================================================================

  async checkSchedulingConflicts(appointmentData) {
    const conflicts = [];
    
    try {
      // Get existing appointments for the requested time slot
      const existingAppts = await this.getAppointmentsForTimeSlot(
        appointmentData.dateTime,
        appointmentData.duration,
        appointmentData.providerId,
        appointmentData.operatoryId
      );

      // Check for provider conflicts
      const providerConflicts = existingAppts.filter(apt => 
        apt.providerId === appointmentData.providerId &&
        this.hasTimeOverlap(apt, appointmentData)
      );

      if (providerConflicts.length > 0) {
        conflicts.push({
          type: 'provider',
          message: 'Provider already has an appointment at this time',
          conflictingAppointments: providerConflicts
        });
      }

      // Check for operatory conflicts
      const operatoryConflicts = existingAppts.filter(apt => 
        apt.operatoryId === appointmentData.operatoryId &&
        this.hasTimeOverlap(apt, appointmentData)
      );

      if (operatoryConflicts.length > 0) {
        conflicts.push({
          type: 'operatory',
          message: 'Operatory is already booked at this time',
          conflictingAppointments: operatoryConflicts
        });
      }

      // Check for patient conflicts (double-booking same patient)
      const patientConflicts = existingAppts.filter(apt => 
        apt.patientId === appointmentData.patientId &&
        this.hasTimeOverlap(apt, appointmentData)
      );

      if (patientConflicts.length > 0) {
        conflicts.push({
          type: 'patient',
          message: 'Patient already has an appointment at this time',
          conflictingAppointments: patientConflicts
        });
      }

      // Check office scheduling rules
      const ruleViolations = await this.checkSchedulingRules(appointmentData);
      conflicts.push(...ruleViolations);

      return conflicts;

    } catch (error) {
      console.error('[OD Conflict] Conflict check failed:', error.message);
      return [{
        type: 'system',
        message: 'Unable to verify conflicts - proceed with caution',
        error: error.message
      }];
    }
  }

  async getAppointmentsForTimeSlot(dateTime, duration, providerId, operatoryId) {
    const requestDate = new Date(dateTime);
    const startOfDay = new Date(requestDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(requestDate);
    endOfDay.setHours(23, 59, 59, 999);

    return await this.getAppointmentsForDateRange(startOfDay, endOfDay);
  }

  hasTimeOverlap(existingApt, newApt) {
    const existing = {
      start: new Date(existingApt.dateTime),
      end: new Date(new Date(existingApt.dateTime).getTime() + existingApt.duration * 60000)
    };

    const newAppt = {
      start: new Date(newApt.dateTime),
      end: new Date(new Date(newApt.dateTime).getTime() + newApt.duration * 60000)
    };

    return existing.start < newAppt.end && existing.end > newAppt.start;
  }

  async checkSchedulingRules(appointmentData) {
    const violations = [];

    try {
      // Get office scheduling preferences
      const scheduleRules = await this.getSchedulingRules();
      
      // Check appointment duration limits
      if (scheduleRules.maxAppointmentDuration && appointmentData.duration > scheduleRules.maxAppointmentDuration) {
        violations.push({
          type: 'duration',
          message: `Appointment exceeds maximum duration of ${scheduleRules.maxAppointmentDuration} minutes`
        });
      }

      // Check provider working hours
      const workingHours = await this.getProviderWorkingHours(appointmentData.providerId, appointmentData.dateTime);
      if (!this.isWithinWorkingHours(appointmentData.dateTime, appointmentData.duration, workingHours)) {
        violations.push({
          type: 'hours',
          message: 'Appointment is outside provider working hours'
        });
      }

      // Check buffer time requirements
      if (scheduleRules.bufferMinutes) {
        const hasBuffer = await this.checkBufferTime(appointmentData, scheduleRules.bufferMinutes);
        if (!hasBuffer) {
          violations.push({
            type: 'buffer',
            message: `Insufficient buffer time (${scheduleRules.bufferMinutes} minutes required)`
          });
        }
      }

      return violations;

    } catch (error) {
      console.error('[OD Rules] Rule check failed:', error.message);
      return [];
    }
  }

  async findAlternativeTimeSlots(appointmentData, conflicts) {
    const alternatives = [];
    const requestedDate = new Date(appointmentData.dateTime);
    
    try {
      // Search for alternatives in the same day
      const sameDayAlternatives = await this.findSameDayAlternatives(appointmentData, requestedDate);
      alternatives.push(...sameDayAlternatives);

      // If no same-day alternatives, search next few days
      if (alternatives.length === 0) {
        for (let i = 1; i <= 7; i++) {
          const searchDate = new Date(requestedDate);
          searchDate.setDate(searchDate.getDate() + i);
          
          const dayAlternatives = await this.findAvailableSlotsForDay(appointmentData, searchDate);
          alternatives.push(...dayAlternatives);
          
          if (alternatives.length >= 5) break; // Limit to 5 alternatives
        }
      }

      return alternatives.slice(0, 5); // Return top 5 alternatives

    } catch (error) {
      console.error('[OD Alternatives] Failed to find alternatives:', error.message);
      return [];
    }
  }

  async findSameDayAlternatives(appointmentData, targetDate) {
    const alternatives = [];
    const workingHours = await this.getProviderWorkingHours(appointmentData.providerId, targetDate);
    
    if (!workingHours) return alternatives;

    // Generate 30-minute slots throughout the day
    const startTime = new Date(targetDate);
    startTime.setHours(workingHours.startHour || 8, 0, 0, 0);
    
    const endTime = new Date(targetDate);
    endTime.setHours(workingHours.endHour || 17, 0, 0, 0);

    for (let time = new Date(startTime); time < endTime; time.setMinutes(time.getMinutes() + 30)) {
      const slotData = {
        ...appointmentData,
        dateTime: time.toISOString()
      };

      const conflicts = await this.checkSchedulingConflicts(slotData);
      
      if (conflicts.length === 0) {
        alternatives.push({
          dateTime: time.toISOString(),
          time: this.formatTime(time.toISOString()),
          providerId: appointmentData.providerId,
          operatoryId: appointmentData.operatoryId,
          available: true
        });
      }
    }

    return alternatives;
  }

  // ============================================================================
  // APPOINTMENT BOOKING AND MANAGEMENT
  // ============================================================================

  async bookAppointment(appointmentData) {
    if (!this.enabled) {
      return {
        success: false,
        message: 'Open Dental integration not configured',
        mockId: Math.floor(Math.random() * 10000)
      };
    }

    try {
      // Pre-booking validation
      const conflicts = await this.checkSchedulingConflicts(appointmentData);
      
      if (conflicts.length > 0) {
        const alternatives = await this.findAlternativeTimeSlots(appointmentData, conflicts);
        
        return {
          success: false,
          message: 'Scheduling conflicts detected',
          conflicts,
          alternatives
        };
      }

      // Prepare appointment data for Open Dental API
      const odAppointmentData = this.prepareAppointmentForOD(appointmentData);
      
      // Create the appointment
      const response = await this.client.post('/appointments', odAppointmentData);
      
      const appointmentId = response.data.AptNum || response.data.id;
      
      // Log the booking
      console.log(`[OD Booking] Appointment ${appointmentId} booked successfully`);
      
      // Emit booking event
      this.emit('appointmentBooked', {
        appointmentId,
        data: appointmentData,
        timestamp: new Date().toISOString()
      });

      // Trigger immediate sync
      setTimeout(() => this.performSync(), 1000);

      return {
        success: true,
        appointmentId,
        message: 'Appointment booked successfully',
        appointment: response.data
      };

    } catch (error) {
      console.error('[OD Booking] Booking failed:', error.message);
      
      return {
        success: false,
        message: 'Failed to book appointment',
        error: error.message,
        code: error.response?.status
      };
    }
  }

  prepareAppointmentForOD(appointmentData) {
    return {
      PatNum: appointmentData.patientId,
      AptDateTime: appointmentData.dateTime,
      Op: appointmentData.operatoryId,
      ProvNum: appointmentData.providerId,
      Pattern: this.generateTimePattern(appointmentData.duration),
      ProcDescript: appointmentData.type || appointmentData.appointmentType,
      Note: appointmentData.notes || '',
      AptStatus: 1, // Scheduled
      IsNewPatient: appointmentData.isNew || false,
      Confirmed: appointmentData.confirmed || false
    };
  }

  generateTimePattern(duration) {
    // Generate Open Dental time pattern (X = 15-minute block, / = break)
    const blocks = Math.ceil(duration / 15);
    return '/' + 'X/'.repeat(blocks);
  }

  async updateAppointment(appointmentId, updateData) {
    if (!this.enabled) {
      return {
        success: false,
        message: 'Open Dental integration not configured'
      };
    }

    try {
      // Check for conflicts with the update
      if (updateData.dateTime || updateData.duration || updateData.providerId || updateData.operatoryId) {
        const currentApt = await this.getAppointmentDetails(appointmentId);
        const mergedData = { ...currentApt, ...updateData };
        
        const conflicts = await this.checkSchedulingConflicts(mergedData);
        if (conflicts.length > 0) {
          return {
            success: false,
            message: 'Update would create scheduling conflicts',
            conflicts
          };
        }
      }

      // Prepare update data for Open Dental
      const odUpdateData = this.prepareUpdateForOD(updateData);
      
      const response = await this.client.put(`/appointments/${appointmentId}`, odUpdateData);
      
      console.log(`[OD Update] Appointment ${appointmentId} updated successfully`);
      
      // Emit update event
      this.emit('appointmentUpdated', {
        appointmentId,
        updateData,
        timestamp: new Date().toISOString()
      });

      // Trigger immediate sync
      setTimeout(() => this.performSync(), 1000);

      return {
        success: true,
        message: 'Appointment updated successfully',
        appointment: response.data
      };

    } catch (error) {
      console.error('[OD Update] Update failed:', error.message);
      
      return {
        success: false,
        message: 'Failed to update appointment',
        error: error.message
      };
    }
  }

  prepareUpdateForOD(updateData) {
    const odData = {};
    
    if (updateData.dateTime) odData.AptDateTime = updateData.dateTime;
    if (updateData.duration) odData.Pattern = this.generateTimePattern(updateData.duration);
    if (updateData.operatoryId) odData.Op = updateData.operatoryId;
    if (updateData.providerId) odData.ProvNum = updateData.providerId;
    if (updateData.notes !== undefined) odData.Note = updateData.notes;
    if (updateData.status !== undefined) odData.AptStatus = this.mapStatusToOD(updateData.status);
    if (updateData.confirmed !== undefined) odData.Confirmed = updateData.confirmed;
    
    return odData;
  }

  async cancelAppointment(appointmentId, reason = '') {
    if (!this.enabled) {
      return {
        success: false,
        message: 'Open Dental integration not configured'
      };
    }

    try {
      // Set appointment status to cancelled
      const response = await this.client.put(`/appointments/${appointmentId}`, {
        AptStatus: 8, // Cancelled status in Open Dental
        Note: reason ? `Cancelled: ${reason}` : 'Cancelled'
      });

      console.log(`[OD Cancel] Appointment ${appointmentId} cancelled`);
      
      // Emit cancellation event
      this.emit('appointmentCancelled', {
        appointmentId,
        reason,
        timestamp: new Date().toISOString()
      });

      // Trigger immediate sync
      setTimeout(() => this.performSync(), 1000);

      return {
        success: true,
        message: 'Appointment cancelled successfully'
      };

    } catch (error) {
      console.error('[OD Cancel] Cancellation failed:', error.message);
      
      return {
        success: false,
        message: 'Failed to cancel appointment',
        error: error.message
      };
    }
  }

  // ============================================================================
  // PATIENT VERIFICATION AND SEARCH
  // ============================================================================

  async searchPatients(query) {
    if (!this.enabled) {
      return this.getMockPatients(query);
    }

    try {
      // Try multiple search methods
      const searchPromises = [];
      
      // Search by name
      if (query.length >= 2) {
        searchPromises.push(
          this.client.get('/patients', {
            params: { search: query, searchType: 'name' }
          })
        );
      }

      // Search by phone (if query looks like a phone number)
      const phonePattern = /\d{3}[\-.\s]?\d{3}[\-.\s]?\d{4}/;
      if (phonePattern.test(query)) {
        const cleanPhone = query.replace(/\D/g, '');
        searchPromises.push(
          this.client.get('/patients', {
            params: { phone: cleanPhone }
          })
        );
      }

      // Search by DOB (if query looks like a date)
      const datePattern = /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/;
      if (datePattern.test(query)) {
        searchPromises.push(
          this.client.get('/patients', {
            params: { birthdate: query }
          })
        );
      }

      const results = await Promise.allSettled(searchPromises);
      const patients = [];
      
      results.forEach(result => {
        if (result.status === 'fulfilled' && result.value.data) {
          patients.push(...result.value.data);
        }
      });

      // Remove duplicates and transform data
      const uniquePatients = this.removeDuplicatePatients(patients);
      return this.transformPatientData(uniquePatients);

    } catch (error) {
      console.error('[OD Search] Patient search failed:', error.message);
      return this.getMockPatients(query);
    }
  }

  async verifyPatientAppointments(patientId, includeHistory = true) {
    if (!this.enabled) {
      return {
        hasUpcoming: false,
        upcomingAppointments: [],
        recentAppointments: []
      };
    }

    try {
      const today = new Date();
      const futureDate = new Date();
      futureDate.setMonth(futureDate.getMonth() + 6); // 6 months ahead
      
      const pastDate = new Date();
      pastDate.setMonth(pastDate.getMonth() - 3); // 3 months back

      // Get upcoming appointments
      const upcomingResponse = await this.client.get('/appointments', {
        params: {
          patientId,
          startDate: today.toISOString().split('T')[0],
          endDate: futureDate.toISOString().split('T')[0],
          status: 'active'
        }
      });

      let recentAppointments = [];
      if (includeHistory) {
        // Get recent past appointments
        const recentResponse = await this.client.get('/appointments', {
          params: {
            patientId,
            startDate: pastDate.toISOString().split('T')[0],
            endDate: today.toISOString().split('T')[0]
          }
        });
        recentAppointments = this.transformAppointmentData(recentResponse.data || []);
      }

      const upcomingAppointments = this.transformAppointmentData(upcomingResponse.data || []);

      return {
        hasUpcoming: upcomingAppointments.length > 0,
        upcomingAppointments,
        recentAppointments,
        patientId
      };

    } catch (error) {
      console.error('[OD Verify] Patient verification failed:', error.message);
      return {
        hasUpcoming: false,
        upcomingAppointments: [],
        recentAppointments: [],
        error: error.message
      };
    }
  }

  async getPatientDetails(patientId) {
    if (!this.enabled) {
      return null;
    }

    try {
      const response = await this.client.get(`/patients/${patientId}`);
      return this.transformPatientData([response.data])[0];
    } catch (error) {
      console.error('[OD Patient] Patient details failed:', error.message);
      return null;
    }
  }

  transformPatientData(rawPatients) {
    return rawPatients.map(patient => ({
      id: patient.PatNum || patient.id,
      firstName: patient.FName || patient.firstName,
      lastName: patient.LName || patient.lastName,
      preferredName: patient.Preferred || patient.preferredName,
      fullName: this.formatPatientName(patient),
      dateOfBirth: patient.Birthdate || patient.dateOfBirth,
      phone: patient.HmPhone || patient.WkPhone || patient.phone,
      email: patient.Email || patient.email,
      address: {
        street: patient.Address || patient.address,
        city: patient.City || patient.city,
        state: patient.State || patient.state,
        zip: patient.Zip || patient.zip
      },
      insurance: {
        primary: patient.PriIns || patient.primaryInsurance,
        secondary: patient.SecIns || patient.secondaryInsurance
      },
      lastVisit: patient.DateLastVisit || patient.lastVisit,
      balance: patient.BalTotal || patient.balance || 0,
      isActive: patient.PatStatus === 0 || patient.isActive !== false
    }));
  }

  removeDuplicatePatients(patients) {
    const seen = new Set();
    return patients.filter(patient => {
      const id = patient.PatNum || patient.id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  // ============================================================================
  // PROVIDER AND OPERATORY MANAGEMENT
  // ============================================================================

  async getProviders() {
    if (!this.enabled) {
      return this.getMockProviders();
    }

    try {
      const response = await this.client.get('/providers');
      
      return response.data?.map((provider, index) => ({
        id: provider.ProvNum || provider.id || index + 1,
        name: `${provider.FName || provider.firstName || ''} ${provider.LName || provider.lastName || ''}`.trim() || `Provider ${index + 1}`,
        abbr: provider.Abbr || provider.abbreviation,
        color: this.getProviderColor(provider.ProvNum || provider.id || index),
        isHygienist: provider.IsHygienist || false,
        isActive: provider.IsHidden !== true,
        email: provider.EMailAddress || provider.email,
        workingHours: provider.WorkingHours || this.getDefaultWorkingHours()
      }));
    } catch (error) {
      console.error('[OD Providers] Provider fetch failed:', error.message);
      return this.getMockProviders();
    }
  }

  async getOperatories() {
    if (!this.enabled) {
      return this.getMockOperatories();
    }

    try {
      const response = await this.client.get('/operatories');
      
      return response.data?.map((op, index) => ({
        id: op.OperatoryNum || op.id || index + 1,
        name: op.OpName || op.name || `Op ${index + 1}`,
        abbr: op.Abbr || op.abbreviation,
        color: this.getOperatoryColor(op.OperatoryNum || op.id || index),
        isActive: !op.IsHidden,
        isHygiene: op.IsHygiene || false,
        providerId: op.ProvDentist || op.providerId,
        providerHygId: op.ProvHygienist || op.hygienistId
      }));
    } catch (error) {
      console.error('[OD Operatories] Operatory fetch failed:', error.message);
      return this.getMockOperatories();
    }
  }

  async getProviderWorkingHours(providerId, date) {
    try {
      const response = await this.client.get(`/schedules`, {
        params: {
          providerId,
          date: new Date(date).toISOString().split('T')[0]
        }
      });

      if (response.data && response.data.length > 0) {
        const schedule = response.data[0];
        return {
          startHour: this.timeToHour(schedule.StartTime),
          endHour: this.timeToHour(schedule.StopTime),
          isWorking: !schedule.IsHoliday && !schedule.IsClosed
        };
      }

      return this.getDefaultWorkingHours();
    } catch (error) {
      console.error('[OD Schedule] Working hours fetch failed:', error.message);
      return this.getDefaultWorkingHours();
    }
  }

  getDefaultWorkingHours() {
    return {
      startHour: 8,
      endHour: 17,
      isWorking: true
    };
  }

  timeToHour(timeString) {
    if (!timeString) return 8;
    const [hours] = timeString.split(':');
    return parseInt(hours, 10);
  }

  isWithinWorkingHours(dateTime, duration, workingHours) {
    if (!workingHours.isWorking) return false;

    const aptTime = new Date(dateTime);
    const aptEndTime = new Date(aptTime.getTime() + duration * 60000);
    
    const startHour = workingHours.startHour;
    const endHour = workingHours.endHour;
    
    return aptTime.getHours() >= startHour && aptEndTime.getHours() <= endHour;
  }

  // ============================================================================
  // UTILITY AND HELPER METHODS
  // ============================================================================

  isEnabled() {
    return this.enabled;
  }

  formatTime(dateTime) {
    if (!dateTime) return '00:00';
    
    try {
      const date = new Date(dateTime);
      return date.toTimeString().slice(0, 5); // HH:MM format
    } catch (error) {
      return '00:00';
    }
  }

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
      9: 'no_show',
      10: 'broken'
    };
    
    return statusMap[odStatus] || 'scheduled';
  }

  mapStatusToOD(status) {
    const statusMap = {
      'scheduled': 1,
      'confirmed': 5,
      'arrived': 6,
      'completed': 7,
      'cancelled': 8,
      'no_show': 9,
      'broken': 10
    };
    
    return statusMap[status] || 1;
  }

  getProviderColor(providerId) {
    const colors = [
      '#1976d2', '#388e3c', '#f57c00', '#7b1fa2', 
      '#c2185b', '#00796b', '#5d4037', '#455a64',
      '#e91e63', '#9c27b0', '#673ab7', '#3f51b5'
    ];
    
    return colors[providerId % colors.length];
  }

  getOperatoryColor(operatoryId) {
    const colors = [
      '#c2185b', '#00796b', '#5d4037', '#455a64',
      '#e91e63', '#9c27b0', '#673ab7', '#3f51b5',
      '#1976d2', '#388e3c', '#f57c00', '#7b1fa2'
    ];
    
    return colors[operatoryId % colors.length];
  }

  checkForConflicts(appointment) {
    // Basic conflict detection placeholder
    return [];
  }

  // ============================================================================
  // MOCK DATA FOR TESTING/DEVELOPMENT
  // ============================================================================

  getMockCalendarData(params) {
    const mockProviders = this.getMockProviders();
    const mockOperatories = this.getMockOperatories();
    const mockAppointments = this.getMockAppointments();

    return mockAppointments;
  }

  getMockProviders() {
    return [
      { id: 1, name: 'Dr. Brian Albert', color: '#1976d2', abbr: 'BA', isActive: true },
      { id: 2, name: 'Dr. Sarah Lexington', color: '#388e3c', abbr: 'SL', isActive: true },
      { id: 3, name: 'Dr. Michael Chen', color: '#f57c00', abbr: 'MC', isActive: true },
      { id: 4, name: 'Dr. Emily Rodriguez', color: '#7b1fa2', abbr: 'ER', isActive: true }
    ];
  }

  getMockOperatories() {
    return [
      { id: 1, name: 'Op 1', color: '#c2185b', abbr: 'O1', isActive: true },
      { id: 2, name: 'Op 2', color: '#00796b', abbr: 'O2', isActive: true },
      { id: 3, name: 'Op 3', color: '#5d4037', abbr: 'O3', isActive: true },
      { id: 4, name: 'Hygiene 1', color: '#455a64', abbr: 'H1', isActive: true }
    ];
  }

  getMockAppointments() {
    return [
      {
        id: 1,
        patient: 'John Smith',
        patientId: 101,
        time: '09:00',
        dateTime: new Date().toISOString().replace(/T.*/, 'T09:00:00'),
        duration: 60,
        type: 'Cleaning',
        status: 'confirmed',
        providerId: 1,
        operatoryId: 1,
        notes: 'Regular checkup and cleaning',
        phone: '555-0101',
        email: 'john.smith@email.com'
      },
      {
        id: 2,
        patient: 'Mary Johnson',
        patientId: 102,
        time: '10:30',
        dateTime: new Date().toISOString().replace(/T.*/, 'T10:30:00'),
        duration: 30,
        type: 'Consultation',
        status: 'scheduled',
        providerId: 2,
        operatoryId: 2,
        notes: 'New patient consultation',
        phone: '555-0102',
        email: 'mary.johnson@email.com'
      }
    ];
  }

  getMockPatients(query) {
    const mockPatients = [
      {
        id: 101,
        firstName: 'John',
        lastName: 'Smith',
        fullName: 'John Smith',
        phone: '555-0101',
        email: 'john.smith@email.com',
        dateOfBirth: '1985-03-15'
      },
      {
        id: 102,
        firstName: 'Mary',
        lastName: 'Johnson',
        fullName: 'Mary Johnson',
        phone: '555-0102',
        email: 'mary.johnson@email.com',
        dateOfBirth: '1990-07-22'
      }
    ];

    return mockPatients.filter(patient => 
      patient.fullName.toLowerCase().includes(query.toLowerCase()) ||
      patient.phone.includes(query) ||
      patient.email.toLowerCase().includes(query.toLowerCase())
    );
  }

  // ============================================================================
  // MISSING HELPER METHODS
  // ============================================================================

  async getRecentPatientUpdates() {
    // Get patients updated in the last sync period
    if (!this.enabled) return [];
    
    try {
      const since = this.lastSyncTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const response = await this.client.get('/patients', {
        params: { 
          updatedSince: since,
          limit: 100
        }
      });
      
      return this.transformPatientData(response.data || []);
    } catch (error) {
      console.error('[OD Patients] Recent patient updates failed:', error.message);
      return [];
    }
  }

  async getSchedulingRules() {
    // Get office scheduling preferences and rules
    if (!this.enabled) {
      return {
        maxAppointmentDuration: 240, // 4 hours
        bufferMinutes: 0,
        allowDoubleBooking: false
      };
    }
    
    try {
      const response = await this.client.get('/preferences', {
        params: { category: 'scheduling' }
      });
      
      return {
        maxAppointmentDuration: response.data.maxAppointmentDuration || 240,
        bufferMinutes: response.data.bufferMinutes || 0,
        allowDoubleBooking: response.data.allowDoubleBooking || false,
        minAdvanceBooking: response.data.minAdvanceBooking || 0
      };
    } catch (error) {
      console.error('[OD Rules] Failed to get scheduling rules:', error.message);
      return {
        maxAppointmentDuration: 240,
        bufferMinutes: 0,
        allowDoubleBooking: false
      };
    }
  }

  async checkBufferTime(appointmentData, bufferMinutes) {
    // Check if there's sufficient buffer time before/after the appointment
    try {
      const appointmentStart = new Date(appointmentData.dateTime);
      const appointmentEnd = new Date(appointmentStart.getTime() + appointmentData.duration * 60000);
      
      const bufferStart = new Date(appointmentStart.getTime() - bufferMinutes * 60000);
      const bufferEnd = new Date(appointmentEnd.getTime() + bufferMinutes * 60000);
      
      // Get appointments for the buffer period
      const existingAppts = await this.getAppointmentsForTimeSlot(
        bufferStart.toISOString(),
        (bufferEnd.getTime() - bufferStart.getTime()) / 60000,
        appointmentData.providerId,
        appointmentData.operatoryId
      );
      
      // Check if any appointments overlap with buffer time
      const hasConflict = existingAppts.some(apt => {
        const aptStart = new Date(apt.dateTime);
        const aptEnd = new Date(aptStart.getTime() + apt.duration * 60000);
        
        return (aptStart < bufferEnd && aptEnd > bufferStart);
      });
      
      return !hasConflict;
    } catch (error) {
      console.error('[OD Buffer] Buffer check failed:', error.message);
      return true; // Default to allowing if check fails
    }
  }

  async findAvailableSlotsForDay(appointmentData, targetDate) {
    // Find all available slots for a specific day
    const alternatives = [];
    const workingHours = await this.getProviderWorkingHours(appointmentData.providerId, targetDate);
    
    if (!workingHours || !workingHours.isWorking) return alternatives;

    // Generate slots throughout the day
    const startTime = new Date(targetDate);
    startTime.setHours(workingHours.startHour || 8, 0, 0, 0);
    
    const endTime = new Date(targetDate);
    endTime.setHours(workingHours.endHour || 17, 0, 0, 0);

    for (let time = new Date(startTime); time < endTime; time.setMinutes(time.getMinutes() + 30)) {
      const slotData = {
        ...appointmentData,
        dateTime: time.toISOString()
      };

      const conflicts = await this.checkSchedulingConflicts(slotData);
      
      if (conflicts.length === 0) {
        alternatives.push({
          dateTime: time.toISOString(),
          time: this.formatTime(time.toISOString()),
          date: targetDate.toISOString().split('T')[0],
          providerId: appointmentData.providerId,
          operatoryId: appointmentData.operatoryId,
          available: true
        });
      }
    }

    return alternatives;
  }

  async getAppointmentDetails(appointmentId) {
    // Get detailed information about a specific appointment
    if (!this.enabled) {
      return null;
    }

    try {
      const response = await this.client.get(`/appointments/${appointmentId}`);
      const apt = response.data;

      return {
        id: apt.AptNum || apt.id,
        patient: this.formatPatientName(apt),
        patientId: apt.PatNum || apt.patientId,
        time: this.formatTime(apt.AptDateTime || apt.dateTime),
        dateTime: apt.AptDateTime || apt.dateTime,
        duration: apt.Pattern ? this.calculateDurationFromPattern(apt.Pattern) : (apt.duration || 30),
        type: apt.ProcDescript || apt.appointmentType || 'Appointment',
        status: this.mapAppointmentStatus(apt.AptStatus || apt.status),
        providerId: apt.ProvNum || apt.providerId,
        operatoryId: apt.Op || apt.operatoryId,
        notes: apt.Note || apt.notes || '',
        confirmed: apt.Confirmed || false,
        isNew: apt.IsNewPatient || false
      };
    } catch (error) {
      console.error('[OD Details] Get appointment details failed:', error.message);
      return null;
    }
  }

  // ============================================================================
  // CLEANUP AND SHUTDOWN
  // ============================================================================

  shutdown() {
    this.stopRealTimeSync();
    this.removeAllListeners();
    console.log('[OD Service] Shutdown complete');
  }
}

module.exports = new OpenDentalService(); 