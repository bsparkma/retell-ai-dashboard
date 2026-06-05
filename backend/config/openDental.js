const mysql = require('mysql2/promise');
const EventEmitter = require('events');
const moment = require('moment');

class OpenDentalService extends EventEmitter {
  constructor() {
    super();
    // Support both database and API connections
    // Also support alternative variable names
    // Non-secret OD config (from .env/process.env in dev and prod alike).
    this.integrationMode = (process.env.OPENDENTAL_INTEGRATION_MODE || '').trim().toLowerCase();
    this.imagesPath = process.env.OPENDENTAL_IMAGES_PATH || '';
    this.dbUrl = process.env.OPENDENTAL_DB_URL;
    this.apiUrl = process.env.OD_API_URL || process.env.OPENDENTAL_API_BASE_URL;
    this.apiKey = process.env.OD_API_KEY;
    
    // Open Dental eConnector API uses developer key + customer key
    this.developerKey = process.env.OPENDENTAL_DEVELOPER_KEY;
    this.customerKey = process.env.OPENDENTAL_CUSTOMER_KEY;
    
    // Connection mode. CareIN runs in 'api' mode (HTTP REST), never direct
    // MySQL. The MySQL-parsing path (setupDatabaseConnection -> new URL(dbUrl))
    // only runs when a direct-DB mode is EXPLICITLY configured, so the API base
    // URL is never mistaken for a mysql:// connection string.
    const DIRECT_DB_MODES = ['db', 'database', 'mysql', 'direct'];
    if (this.integrationMode === 'api') {
      this.useDatabase = false;
    } else if (DIRECT_DB_MODES.includes(this.integrationMode)) {
      this.useDatabase = !!this.dbUrl;
    } else {
      // No explicit mode set: only use direct DB if a connection URL is present.
      this.useDatabase = !!this.dbUrl;
    }
    // Enabled when the active mode has what it needs: API mode needs a base URL
    // plus credentials; DB mode needs a connection URL.
    this.enabled = this.useDatabase
      ? !!this.dbUrl
      : !!(this.apiUrl && (this.apiKey || (this.developerKey && this.customerKey)));
    
    this.syncInterval = null;
    this.lastSyncTime = null;
    this.conflicts = new Map(); // Track scheduling conflicts
    this.bookingQueue = []; // Queue for booking operations
    this.pool = null;
    
    if (this.enabled) {
      if (this.useDatabase) {
        this.setupDatabaseConnection();
      } else {
        // Keep existing API setup as fallback
        const axios = require('axios');
        
        // Build headers based on available credentials
        const headers = {
          'Content-Type': 'application/json',
        };
        
        // Open Dental eConnector API uses: Authorization: ODFHIR {DeveloperKey}/{CustomerKey}
        if (this.developerKey && this.customerKey) {
          headers['Authorization'] = `ODFHIR ${this.developerKey}/${this.customerKey}`;
        } else if (this.apiKey) {
          // Single API key (legacy or custom setup)
          headers['Authorization'] = `Bearer ${this.apiKey}`;
        }
        
        console.log('[OD API] Initializing with URL:', this.apiUrl);
        console.log('[OD API] Using ODFHIR authentication:', !!(this.developerKey && this.customerKey));
        
        this.client = axios.create({
          baseURL: this.apiUrl,
          timeout: 30000,
          headers
        });
        this.setupInterceptors();
      }
      
      // Start real-time sync
      this.startRealTimeSync();
    }
  }

  setupDatabaseConnection() {
    try {
      // Parse the database URL
      const url = new URL(this.dbUrl);
      
      this.pool = mysql.createPool({
        host: url.hostname,
        port: url.port || 3306,
        user: url.username || 'root',
        password: url.password || '',
        database: url.pathname.slice(1), // Remove leading slash
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        acquireTimeout: 60000,
        timeout: 60000,
        reconnect: true
      });

      console.log('[OD DB] Database connection pool created');
    } catch (error) {
      console.error('[OD DB] Database connection failed:', error.message);
      this.enabled = false;
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
      if (this.allowMock()) return this.getMockCalendarData(params);
      throw new Error('Open Dental is not configured (set OPENDENTAL_ALLOW_MOCK=true for dev mock data)');
    }

    if (this.useDatabase) {
      return this.getCalendarAppointmentsFromDB(params);
    }

    try {
      const targetDate = params.date || moment().format('YYYY-MM-DD');
      // Single-day load via the real date filter params (yyyy-MM-dd). Provider filtering
      // is NOT a GET param on OD — only Op/ClinicNum are — so providers are filtered
      // client-side below. No fabricated include*/providerIds params. See OD_API_CONTRACT §2.
      const queryParams = { dateStart: targetDate, dateEnd: targetDate };
      if (params.operatoryIds?.length === 1) queryParams.Op = params.operatoryIds[0];
      if (params.clinicNum !== undefined) queryParams.ClinicNum = params.clinicNum;

      const response = await this.client.get('/appointments', { params: queryParams });
      const list = this.extractAppointmentList(response.data);
      let transformed = this.transformAppointmentData(list);

      // Belt-and-suspenders: keep only records actually on the target date.
      transformed = transformed.filter((apt) => {
        if (!apt.id || !apt.dateTime) return false;
        const dt = apt.dateTime;
        const aptDate = (typeof dt === 'string' ? dt : (dt.toISOString && dt.toISOString()))?.split('T')[0];
        return aptDate === targetDate;
      });

      // Client-side provider/operatory filtering (OD GET has no provider filter).
      if (params.providerIds?.length) {
        const want = new Set(params.providerIds.map(String));
        transformed = transformed.filter((apt) => want.has(String(apt.providerId)));
      }
      if (params.operatoryIds?.length) {
        const want = new Set(params.operatoryIds.map(String));
        transformed = transformed.filter((apt) => want.has(String(apt.operatoryId)));
      }

      return await this.enrichAppointmentPatients(transformed);
    } catch (error) {
      console.error('[OD API] Calendar fetch failed:', error.message);
      // In api mode against a real practice, surface the error — never phantom mock data.
      if (this.allowMock()) return this.getMockCalendarData(params);
      throw error;
    }
  }

  async getCalendarAppointmentsFromDB(params = {}) {
    try {
      const targetDate = params.date || new Date().toISOString().split('T')[0];
      console.log('[OD DB] Fetching appointments for date:', targetDate);
      
      // Check available columns in each table
      const [aptColumns] = await this.pool.execute("SHOW COLUMNS FROM appointment");
      const [patColumns] = await this.pool.execute("SHOW COLUMNS FROM patient");
      const [provColumns] = await this.pool.execute("SHOW COLUMNS FROM provider");
      const [opColumns] = await this.pool.execute("SHOW COLUMNS FROM operatory");
      
      const aptCols = aptColumns.map(col => col.Field);
      const patCols = patColumns.map(col => col.Field);
      const provCols = provColumns.map(col => col.Field);
      const opCols = opColumns.map(col => col.Field);
      
      // Build query with available columns
      let query = `SELECT a.AptNum`;
      if (aptCols.includes('AptDateTime')) query += `, a.AptDateTime`;
      if (aptCols.includes('Pattern')) query += `, a.Pattern`;
      if (aptCols.includes('AptStatus')) query += `, a.AptStatus`;
      if (aptCols.includes('ProcDescript')) query += `, a.ProcDescript`;
      if (aptCols.includes('Note')) query += `, a.Note`;
      if (aptCols.includes('Op')) query += `, a.Op`;
      if (aptCols.includes('ProvNum')) query += `, a.ProvNum`;
      if (aptCols.includes('PatNum')) query += `, a.PatNum`;
      if (aptCols.includes('Confirmed')) query += `, a.Confirmed`;
      if (aptCols.includes('IsNewPatient')) query += `, a.IsNewPatient`;
      
      // Patient columns
      if (patCols.includes('LName')) query += `, p.LName`;
      if (patCols.includes('FName')) query += `, p.FName`;
      if (patCols.includes('Preferred')) query += `, p.Preferred`;
      if (patCols.includes('HmPhone')) query += `, p.HmPhone`;
      if (patCols.includes('WkPhone')) query += `, p.WkPhone`;
      if (patCols.includes('Email')) query += `, p.Email`;
      
      // Provider columns
      if (provCols.includes('LName')) query += `, pr.LName as ProvLName`;
      if (provCols.includes('FName')) query += `, pr.FName as ProvFName`;
      if (provCols.includes('Abbr')) query += `, pr.Abbr as ProvAbbr`;
      
      // Operatory columns
      if (opCols.includes('OpName')) query += `, o.OpName`;
      
      query += ` FROM appointment a
        LEFT JOIN patient p ON a.PatNum = p.PatNum
        LEFT JOIN provider pr ON a.ProvNum = pr.ProvNum
        LEFT JOIN operatory o ON a.Op = o.OperatoryNum
        WHERE DATE(a.AptDateTime) = ?
        AND a.AptStatus NOT IN (8, 10)`;
      
      const queryParams = [targetDate];
      
      // Add provider filter if specified
      if (params.providerIds?.length) {
        query += ` AND a.ProvNum IN (${params.providerIds.map(() => '?').join(',')})`;
        queryParams.push(...params.providerIds);
      }
      
      // Add operatory filter if specified
      if (params.operatoryIds?.length) {
        query += ` AND a.Op IN (${params.operatoryIds.map(() => '?').join(',')})`;
        queryParams.push(...params.operatoryIds);
      }
      
      query += ' ORDER BY a.AptDateTime LIMIT 100';
      
      console.log('[OD DB] Executing query for appointments');
      const [rows] = await this.pool.execute(query, queryParams);
      console.log('[OD DB] Found', rows.length, 'appointments');
      
      return this.transformAppointmentDataFromDB(rows);
      
    } catch (error) {
      console.error('[OD DB] Calendar fetch failed:', error.message);
      return this.getMockCalendarData(params);
    }
  }

  async getAppointmentsForDateRange(startDate, endDate) {
    if (!this.enabled) {
      return [];
    }

    try {
      // Real OD filter params are dateStart/dateEnd (yyyy-MM-dd). The old startDate/
      // endDate were silently ignored → unfiltered (2012) data. See OD_API_CONTRACT §2.
      const response = await this.client.get('/appointments', {
        params: {
          dateStart: moment(startDate).format('YYYY-MM-DD'),
          dateEnd: moment(endDate).format('YYYY-MM-DD')
        }
      });

      const list = this.extractAppointmentList(response.data);
      return await this.enrichAppointmentPatients(this.transformAppointmentData(list));
    } catch (error) {
      console.error('[OD API] Date range fetch failed:', error.message);
      // Surface in api mode — a silent [] could hide an outage and let a double-book
      // through during a conflict check. Empty results are only OK in dev/mock.
      if (this.allowMock()) return [];
      throw error;
    }
  }

  // GET /appointments may return a bare array or a wrapped { value: { data: [...] } }
  // / { data: [...] } envelope. Only ever return appointment records.
  extractAppointmentList(raw) {
    if (Array.isArray(raw)) return raw;
    const list = raw?.value?.data ?? raw?.data ?? [];
    return Array.isArray(list) ? list : [];
  }

  // GET /appointments returns PatNum but not patient name fields (there is no
  // includePatientInfo param), so list payloads render "Unknown Patient". Resolve the
  // real names by batch-looking-up each unique PatNum (best-effort; a failed lookup
  // leaves that row as-is rather than failing the whole list). See OD_API_CONTRACT §2.
  async enrichAppointmentPatients(appointments) {
    if (!Array.isArray(appointments) || !appointments.length) return appointments;
    const needIds = [...new Set(
      appointments
        .filter(a => a && a.patientId && (!a.patient || a.patient === 'Unknown Patient'))
        .map(a => a.patientId)
    )];
    if (!needIds.length) return appointments;

    const byId = {};
    await Promise.all(needIds.map(async (id) => {
      try {
        const p = await this.getPatientDetails(id);
        if (p) byId[id] = p;
      } catch (_) { /* best-effort; leave row unenriched */ }
    }));

    return appointments.map((a) => {
      const p = a && byId[a.patientId];
      if (!p) return a;
      return {
        ...a,
        patient: p.fullName || a.patient,
        phone: a.phone || p.phone,
        email: a.email || p.email
      };
    });
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

  transformAppointmentDataFromDB(rows) {
    if (!rows || !Array.isArray(rows)) return [];

    return rows.map(apt => ({
      id: apt.AptNum,
      patient: this.formatPatientNameFromDB(apt),
      patientId: apt.PatNum,
      time: this.formatTime(apt.AptDateTime),
      dateTime: moment(apt.AptDateTime).format('YYYY-MM-DDTHH:mm:ss'),
      duration: apt.Pattern ? this.calculateDurationFromPattern(apt.Pattern) : 30,
      type: apt.ProcDescript || 'Appointment',
      status: this.mapAppointmentStatus(apt.AptStatus),
      providerId: apt.ProvNum,
      providerName: apt.ProvFName && apt.ProvLName ? `${apt.ProvFName} ${apt.ProvLName}` : apt.ProvAbbr,
      operatoryId: apt.Op,
      operatoryName: apt.OpName || apt.OpAbbr,
      notes: apt.Note || '',
      confirmed: !!apt.Confirmed,
      isNew: !!apt.IsNewPatient,
      phone: apt.HmPhone || apt.WkPhone || '',
      email: apt.Email || '',
      lastModified: apt.DateTStamp,
      conflicts: []
    }));
  }

  formatPatientNameFromDB(apt) {
    const first = apt.FName || '';
    const last = apt.LName || '';
    const preferred = apt.Preferred || '';
    
    if (preferred) return `${preferred} ${last}`.trim();
    return `${first} ${last}`.trim() || 'Unknown Patient';
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
    // Required by OD POST /appointments: PatNum, Op, AptDateTime. AptStatus is the
    // string enum ("Scheduled"), AptDateTime is "yyyy-MM-dd HH:mm:ss", and booleans
    // are sent as the strings "true"/"false". See OD_API_CONTRACT §3.
    const payload = {
      PatNum: appointmentData.patientId,
      AptDateTime: this.formatODDateTime(appointmentData.dateTime),
      Op: appointmentData.operatoryId,
      ProvNum: appointmentData.providerId,
      Pattern: this.generateTimePattern(appointmentData.duration),
      ProcDescript: appointmentData.type || appointmentData.appointmentType,
      Note: appointmentData.notes || '',
      AptStatus: this.mapStatusToOD(appointmentData.status || 'scheduled'),
      IsNewPatient: appointmentData.isNew ? 'true' : 'false'
    };

    // `Confirmed` is a practice-specific definition.DefNum (ApptConfirmed category),
    // NOT a boolean — and it differs per OD database (Roland vs Valley), so it must be
    // resolved per-connected-database, never hardcoded. Only send it when a real DefNum
    // is supplied; never send a boolean. See OD_API_CONTRACT §3 + the per-DB DefNum note.
    if (Number.isInteger(appointmentData.confirmedDefNum)) {
      payload.Confirmed = appointmentData.confirmedDefNum;
    }

    return payload;
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
    
    if (updateData.dateTime) odData.AptDateTime = this.formatODDateTime(updateData.dateTime);
    if (updateData.duration) odData.Pattern = this.generateTimePattern(updateData.duration);
    if (updateData.operatoryId) odData.Op = updateData.operatoryId;
    if (updateData.providerId) odData.ProvNum = updateData.providerId;
    if (updateData.notes !== undefined) odData.Note = updateData.notes;
    if (updateData.status !== undefined) odData.AptStatus = this.mapStatusToOD(updateData.status);
    // Confirmed is a definition.DefNum, not a boolean — only set it when a real DefNum
    // is supplied (per-database; see OD_API_CONTRACT §3). Never write a boolean.
    if (Number.isInteger(updateData.confirmedDefNum)) odData.Confirmed = updateData.confirmedDefNum;

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
      // Cancel = set AptStatus to the "Broken" string enum via PUT. This is a status
      // UPDATE, never a delete — OD has no "Cancelled" status and no API row-delete for
      // appointments. (A later slice may switch to PUT /appointments/{id}/Break to also
      // record D9986/D9987.) See OD_API_CONTRACT §1/§4.2.
      const response = await this.client.put(`/appointments/${appointmentId}`, {
        AptStatus: this.mapStatusToOD('cancelled'), // -> "Broken"
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
      if (this.allowMock()) return this.getMockPatients(query);
      throw new Error('Open Dental is not configured (set OPENDENTAL_ALLOW_MOCK=true for dev mock data)');
    }

    if (this.useDatabase) {
      return this.searchPatientsFromDB(query);
    }

    try {
      // Real OD patient search uses explicit field params (LName/FName/Phone/Birthdate)
      // on GET /patients — there is no generic `search`/`searchType`. Route the single
      // query string to the right field. See OD_API_CONTRACT §7.
      const params = this.buildPatientSearchParams(query);
      const response = await this.client.get('/patients', { params });
      const list = Array.isArray(response.data)
        ? response.data
        : (response.data?.value?.data ?? response.data?.data ?? []);
      const uniquePatients = this.removeDuplicatePatients(Array.isArray(list) ? list : []);
      return this.transformPatientData(uniquePatients);
    } catch (error) {
      console.error('[OD Search] Patient search failed:', error.message);
      // Surface in api mode — an empty/mock result would mask a broken search.
      if (this.allowMock()) return this.getMockPatients(query);
      throw error;
    }
  }

  // Route a single free-text query to OD patient-search field params:
  //   all digits / phone-shaped -> Phone; date-like -> Birthdate (yyyy-MM-dd);
  //   "Last, First" or "First Last" -> LName/FName; otherwise -> LName.
  buildPatientSearchParams(query) {
    const q = (query || '').trim();
    const digits = q.replace(/\D/g, '');

    // Date-like (MM/DD/YYYY, M-D-YY, or yyyy-MM-dd) -> Birthdate.
    const dateMatch = q.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (dateMatch) {
      let [, m, d, y] = dateMatch;
      if (y.length === 2) y = (parseInt(y, 10) > 30 ? '19' : '20') + y;
      const pad = (n) => String(n).padStart(2, '0');
      return { Birthdate: `${y}-${pad(m)}-${pad(d)}` };
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q)) return { Birthdate: q };

    // Phone-shaped (7+ digits and no letters) -> Phone.
    if (digits.length >= 7 && !/[a-zA-Z]/.test(q)) return { Phone: digits };

    // Name: "Last, First" or "First Last".
    if (q.includes(',')) {
      const [last, first] = q.split(',').map((s) => s.trim());
      const out = {};
      if (last) out.LName = last;
      if (first) out.FName = first;
      return out;
    }
    const parts = q.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return { FName: parts[0], LName: parts.slice(1).join(' ') };
    }
    return { LName: q };
  }

  async searchPatientsFromDB(query) {
    try {
      const searchTerm = `%${query}%`;
      
      let dbQuery = `
        SELECT 
          PatNum,
          LName,
          FName,
          Preferred,
          Birthdate,
          HmPhone,
          WkPhone,
          Email,
          Address,
          City,
          State,
          Zip,
          PatStatus,
          BalTotal
        FROM patient
        WHERE (
          CONCAT(FName, ' ', LName) LIKE ?
          OR CONCAT(LName, ', ', FName) LIKE ?
          OR Preferred LIKE ?
          OR HmPhone LIKE ?
          OR WkPhone LIKE ?
          OR Email LIKE ?
        )
        AND PatStatus = 0
        ORDER BY LName, FName
        LIMIT 20
      `;
      
      const queryParams = [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm];
      
      const [rows] = await this.pool.execute(dbQuery, queryParams);
      
      return this.transformPatientDataFromDB(rows);
      
    } catch (error) {
      console.error('[OD DB] Patient search failed:', error.message);
      return this.getMockPatients(query);
    }
  }

  transformPatientDataFromDB(rawPatients) {
    return rawPatients.map(patient => ({
      id: patient.PatNum,
      firstName: patient.FName,
      lastName: patient.LName,
      preferredName: patient.Preferred,
      fullName: this.formatPatientNameFromDB(patient),
      dateOfBirth: patient.Birthdate ? moment(patient.Birthdate).format('YYYY-MM-DD') : null,
      phone: patient.HmPhone || patient.WkPhone,
      email: patient.Email,
      address: {
        street: patient.Address,
        city: patient.City,
        state: patient.State,
        zip: patient.Zip
      },
      balance: patient.BalTotal || 0,
      isActive: patient.PatStatus === 0
    }));
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

      // Real OD filter params: PatNum + dateStart/dateEnd (yyyy-MM-dd). The old
      // patientId/startDate/endDate/status params were ignored → a 2012 appt showed as
      // "upcoming". Server-side date filtering now applies. See OD_API_CONTRACT §2.
      const upcomingResponse = await this.client.get('/appointments', {
        params: {
          PatNum: patientId,
          dateStart: moment(today).format('YYYY-MM-DD'),
          dateEnd: moment(futureDate).format('YYYY-MM-DD')
        }
      });

      let recentAppointments = [];
      if (includeHistory) {
        // Get recent past appointments
        const recentResponse = await this.client.get('/appointments', {
          params: {
            PatNum: patientId,
            dateStart: moment(pastDate).format('YYYY-MM-DD'),
            dateEnd: moment(today).format('YYYY-MM-DD')
          }
        });
        recentAppointments = await this.enrichAppointmentPatients(
          this.transformAppointmentData(this.extractAppointmentList(recentResponse.data))
        );
      }

      const upcomingAppointments = await this.enrichAppointmentPatients(
        this.transformAppointmentData(this.extractAppointmentList(upcomingResponse.data))
      );

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
      if (this.allowMock()) return this.getMockProviders();
      throw new Error('Open Dental is not configured (set OPENDENTAL_ALLOW_MOCK=true for dev mock data)');
    }

    if (this.useDatabase) {
      return this.getProvidersFromDB();
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
      if (this.allowMock()) return this.getMockProviders();
      throw error;
    }
  }

  async getProvidersFromDB() {
    try {
      // Check available columns first
      const [columns] = await this.pool.execute("SHOW COLUMNS FROM provider");
      const columnNames = columns.map(col => col.Field);
      
      console.log('[OD DB] Available provider columns:', columnNames);
      
      let query = `SELECT ProvNum`;
      if (columnNames.includes('FName')) query += `, FName`;
      if (columnNames.includes('LName')) query += `, LName`;
      if (columnNames.includes('Abbr')) query += `, Abbr`;
      if (columnNames.includes('IsHygienist')) query += `, IsHygienist`;
      if (columnNames.includes('IsHidden')) query += `, IsHidden`;
      if (columnNames.includes('EMailAddress')) query += `, EMailAddress`;
      
      query += ` FROM provider ORDER BY LName, FName LIMIT 20`;
      
      const [rows] = await this.pool.execute(query);
      
      return rows.map((provider, index) => ({
        id: provider.ProvNum,
        name: `${provider.FName || ''} ${provider.LName || ''}`.trim() || `Provider ${provider.ProvNum}`,
        abbr: provider.Abbr || provider.LName?.substring(0, 2) || `P${provider.ProvNum}`,
        color: this.getProviderColor(provider.ProvNum),
        isHygienist: !!provider.IsHygienist,
        isActive: provider.IsHidden !== undefined ? !provider.IsHidden : true,
        email: provider.EMailAddress || '',
        workingHours: this.getDefaultWorkingHours()
      }));
    } catch (error) {
      console.error('[OD DB] Provider fetch failed:', error.message);
      return this.getMockProviders();
    }
  }

  async getOperatories() {
    if (!this.enabled) {
      if (this.allowMock()) return this.getMockOperatories();
      throw new Error('Open Dental is not configured (set OPENDENTAL_ALLOW_MOCK=true for dev mock data)');
    }

    if (this.useDatabase) {
      return this.getOperatoriesFromDB();
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
      if (this.allowMock()) return this.getMockOperatories();
      throw error;
    }
  }

  async getOperatoriesFromDB() {
    try {
      // First try to get table structure to see what columns exist
      const [columns] = await this.pool.execute("SHOW COLUMNS FROM operatory");
      const columnNames = columns.map(col => col.Field);
      
      console.log('[OD DB] Available operatory columns:', columnNames);
      
      // Build query based on available columns
      let query = `SELECT OperatoryNum, OpName`;
      
      if (columnNames.includes('Abbr')) query += `, Abbr`;
      if (columnNames.includes('IsHidden')) query += `, IsHidden`;
      if (columnNames.includes('IsHygiene')) query += `, IsHygiene`;
      if (columnNames.includes('ProvDentist')) query += `, ProvDentist`;
      if (columnNames.includes('ProvHygienist')) query += `, ProvHygienist`;
      
      query += ` FROM operatory ORDER BY OpName LIMIT 20`;
      
      const [rows] = await this.pool.execute(query);
      
      return rows.map((op, index) => ({
        id: op.OperatoryNum,
        name: op.OpName || `Op ${op.OperatoryNum}`,
        abbr: op.Abbr || op.OpName?.substring(0, 2) || `O${op.OperatoryNum}`,
        color: this.getOperatoryColor(op.OperatoryNum),
        isActive: op.IsHidden !== undefined ? !op.IsHidden : true,
        isHygiene: !!op.IsHygiene,
        providerId: op.ProvDentist || null,
        providerHygId: op.ProvHygienist || null
      }));
    } catch (error) {
      console.error('[OD DB] Operatory fetch failed:', error.message);
      return this.getMockOperatories();
    }
  }

  async getProviderWorkingHours(providerId, date) {
    try {
      // Format the date locally (moment) so a UTC toISOString() can't roll it to the
      // previous/next day. NOTE: the /schedules param/field names (StartTime/StopTime/
      // IsHoliday) should be re-confirmed against live OD in STEP 2; this slice only
      // hardens the date param, not the field mapping. See OD_API_CONTRACT §9.
      const response = await this.client.get(`/schedules`, {
        params: {
          providerId,
          date: moment(date).format('YYYY-MM-DD')
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

  // Reads: map an OD AptStatus back to our internal vocabulary. The real OD cloud
  // API returns a STRING enum; direct-DB mode returns the legacy integer. Handle
  // strings first (API), then fall back to the integer map (DB) — see
  // docs/OD_API_CONTRACT.md §1/§5.
  // NOTE: OD has no distinct "Cancelled"/"NoShow" status — both cancellations and
  // no-shows read back as "Broken", so this mapping intentionally collapses them to
  // `cancelled`. Nothing downstream may assume a Broken row was a cancel vs a missed
  // appointment; that distinction only exists via the /Break endpoint (out of scope,
  // a later slice). Reverse-mapping is therefore lossy by design.
  mapAppointmentStatus(odStatus) {
    if (typeof odStatus === 'string') {
      const stringMap = {
        Scheduled: 'scheduled',
        Complete: 'completed',
        UnschedList: 'unscheduled',
        ASAP: 'scheduled',
        Broken: 'cancelled',
        Planned: 'scheduled',
        PtNote: 'scheduled',
        PtNoteCompleted: 'completed'
      };
      if (stringMap[odStatus]) return stringMap[odStatus];
    }

    // Legacy direct-DB integer AptStatus (unchanged — DB-mode paths are not retargeted).
    const intMap = {
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
    return intMap[odStatus] || 'scheduled';
  }

  // Writes: map our internal vocabulary to the real OD API string AptStatus enum.
  // OD has NO Confirmed/Arrived/NoShow status — confirmation is a Confirmed DefNum,
  // arrival is DateTimeArrived, and cancel/no-show both become "Broken" (a status
  // UPDATE, never a delete). This is the single source of int->string truth; no
  // raw integer AptStatus literals should exist anywhere else. See OD_API_CONTRACT §5.
  mapStatusToOD(status) {
    const statusMap = {
      scheduled: 'Scheduled',
      confirmed: 'Scheduled',   // confirmation tracked via Confirmed DefNum, not AptStatus
      arrived: 'Scheduled',     // arrival tracked via DateTimeArrived, not AptStatus
      completed: 'Complete',
      cancelled: 'Broken',      // OD has no "Cancelled"; cancel = Broken status update
      no_show: 'Broken',        // OD can't distinguish no-show from cancel on read
      broken: 'Broken',
      unscheduled: 'UnschedList',
      asap: 'ASAP',
      planned: 'Planned'
    };
    return statusMap[status] || 'Scheduled';
  }

  // Format a datetime for OD writes: "yyyy-MM-dd HH:mm:ss" (no 'T'/'Z'). OD treats the
  // value as practice-local wall-clock, so we preserve the wall-clock portion of an ISO
  // string verbatim rather than shifting it through UTC. See OD_API_CONTRACT §3.
  formatODDateTime(value) {
    if (!value) return value;
    if (typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return value;
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return `${value}:00`;
      const iso = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
      if (iso) return `${iso[1]} ${iso[2]}`;
    }
    return moment(value).format('YYYY-MM-DD HH:mm:ss');
  }

  // Mock data is permissible ONLY when OD is not configured or an explicit dev flag is
  // set — never as a silent fallback on an API error in api mode against a real practice
  // (that would show phantom providers/appointments/patients). See OD_API_CONTRACT §8.
  allowMock() {
    return process.env.OPENDENTAL_ALLOW_MOCK === 'true' && process.env.NODE_ENV !== 'production';
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
      // OD has no `updatedSince` param (it 400s). The changed-since mechanism is the
      // DateTStamp filter ("yyyy-MM-dd HH:mm:ss") on GET /patients/Simple, paired with
      // the serverDateTime cursor returned by OD. See OD_API_CONTRACT §6/§7.
      const since = moment(this.lastSyncTime || Date.now() - 24 * 60 * 60 * 1000)
        .format('YYYY-MM-DD HH:mm:ss');
      const response = await this.client.get('/patients/Simple', {
        params: { DateTStamp: since }
      });

      const list = Array.isArray(response.data)
        ? response.data
        : (response.data?.value?.data ?? response.data?.data ?? []);
      return this.transformPatientData(Array.isArray(list) ? list : []);
    } catch (error) {
      // Background sync read — log and degrade to empty (no longer a guaranteed 400),
      // rather than aborting the whole sync cycle.
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

  async testConnection() {
    if (!this.enabled) {
      return { success: false, message: 'Service not enabled' };
    }

    if (this.useDatabase) {
      try {
        const [rows] = await this.pool.execute('SELECT COUNT(*) as count FROM patient LIMIT 1');
        return { 
          success: true, 
          message: 'Database connection successful',
          connectionType: 'database',
          patientCount: rows[0]?.count || 0
        };
      } catch (error) {
        return { 
          success: false, 
          message: `Database connection failed: ${error.message}`,
          connectionType: 'database'
        };
      }
    } else {
      try {
        // Test with /providers endpoint which we know exists
        const response = await this.client.get('/providers');
        return { 
          success: response.status === 200, 
          message: `API connection successful - found ${response.data?.length || 0} providers`,
          connectionType: 'api',
          providerCount: response.data?.length || 0
        };
      } catch (error) {
        return { 
          success: false, 
          message: `API connection failed: ${error.message}`,
          connectionType: 'api'
        };
      }
    }
  }

  async shutdown() {
    this.stopRealTimeSync();
    
    if (this.pool) {
      try {
        await this.pool.end();
        console.log('[OD DB] Database pool closed');
      } catch (error) {
        console.error('[OD DB] Error closing database pool:', error.message);
      }
    }
    
    this.removeAllListeners();
    console.log('[OD Service] Shutdown complete');
  }
}

// Export the singleton (app uses this) and the class (unit tests construct fresh,
// disabled instances and stub `this.client` to assert param/enum construction).
const openDentalServiceSingleton = new OpenDentalService();
openDentalServiceSingleton.OpenDentalService = OpenDentalService;
module.exports = openDentalServiceSingleton;
module.exports.OpenDentalService = OpenDentalService; 