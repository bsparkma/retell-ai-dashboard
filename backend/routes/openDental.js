const express = require('express');
const router = express.Router();
const openDentalService = require('../config/openDental');

// ============================================================================
// HEALTH AND STATUS ENDPOINTS
// ============================================================================

// Health check for Open Dental integration
router.get('/health', (req, res) => {
  res.json({
    enabled: openDentalService.isEnabled(),
    status: openDentalService.isEnabled() ? 'connected' : 'disabled',
    lastSync: openDentalService.lastSyncTime,
    lastCheck: new Date().toISOString()
  });
});

// Get sync status and data
router.get('/sync/status', (req, res) => {
  res.json({
    enabled: openDentalService.isEnabled(),
    lastSync: openDentalService.lastSyncTime,
    isActive: !!openDentalService.syncInterval,
    conflicts: Array.from(openDentalService.conflicts.entries()),
    timestamp: new Date().toISOString()
  });
});

// Force immediate sync
router.post('/sync/trigger', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({
        success: false,
        message: 'Open Dental integration not configured'
      });
    }

    await openDentalService.performSync();
    
    res.json({
      success: true,
      message: 'Sync triggered successfully',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Manual sync error:', error);
    res.status(500).json({
      success: false,
      message: 'Sync failed',
      error: error.message
    });
  }
});

// ============================================================================
// CALENDAR AND APPOINTMENT RETRIEVAL
// ============================================================================

// Get calendar data with provider/operatory view support
router.get('/calendar', async (req, res) => {
  try {
    const { date, view, providerIds, operatoryIds } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];
    const viewMode = view || 'provider';

    // Get appointments for the specified date
    const appointments = await openDentalService.getCalendarAppointments({
      date: targetDate,
      view: viewMode,
      providerIds: providerIds ? providerIds.split(',').map(id => parseInt(id)) : undefined,
      operatoryIds: operatoryIds ? operatoryIds.split(',').map(id => parseInt(id)) : undefined
    });

    // Get providers and operatories
    const [providers, operatories] = await Promise.all([
      openDentalService.getProviders(),
      openDentalService.getOperatories()
    ]);

    res.json({
      success: true,
      date: targetDate,
      view: viewMode,
      appointments: appointments || [],
      providers: providers || [],
      operatories: operatories || [],
      totalAppointments: appointments ? appointments.length : 0,
      lastSync: openDentalService.lastSyncTime
    });

  } catch (error) {
    console.error('Calendar API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch calendar data',
      message: error.message
    });
  }
});

// Get appointments for a date range
router.get('/appointments/range', async (req, res) => {
  try {
    const { startDate, endDate, providerId, operatoryId, patientId } = req.query;

    if (!startDate) {
      return res.status(400).json({
        success: false,
        message: 'startDate is required'
      });
    }

    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : new Date(start.getTime() + 24 * 60 * 60 * 1000);

    const appointments = await openDentalService.getAppointmentsForDateRange(start, end);

    // Filter by provider, operatory, or patient if specified
    let filteredAppointments = appointments;
    if (providerId) {
      filteredAppointments = filteredAppointments.filter(apt => apt.providerId == providerId);
    }
    if (operatoryId) {
      filteredAppointments = filteredAppointments.filter(apt => apt.operatoryId == operatoryId);
    }
    if (patientId) {
      filteredAppointments = filteredAppointments.filter(apt => apt.patientId == patientId);
    }

    res.json({
      success: true,
      appointments: filteredAppointments,
      dateRange: { startDate, endDate },
      totalCount: filteredAppointments.length
    });

  } catch (error) {
    console.error('Date range API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch appointments for date range',
      message: error.message
    });
  }
});

// Get specific appointment details
router.get('/appointments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const appointment = await openDentalService.getAppointmentDetails(id);
    
    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: `Appointment not found with ID: ${id}`
      });
    }

    res.json({
      success: true,
      appointment
    });

  } catch (error) {
    console.error('Get appointment API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch appointment details',
      message: error.message
    });
  }
});

// ============================================================================
// CONFLICT DETECTION AND SMART SCHEDULING
// ============================================================================

// Check for scheduling conflicts
router.post('/appointments/check-conflicts', async (req, res) => {
  try {
    const appointmentData = req.body;
    
    // Validate required fields
    const requiredFields = ['dateTime', 'duration', 'providerId', 'operatoryId'];
    const missingFields = requiredFields.filter(field => !appointmentData[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        missingFields
      });
    }

    const conflicts = await openDentalService.checkSchedulingConflicts(appointmentData);
    const hasConflicts = conflicts.length > 0;

    let alternatives = [];
    if (hasConflicts) {
      alternatives = await openDentalService.findAlternativeTimeSlots(appointmentData, conflicts);
    }

    res.json({
      success: true,
      hasConflicts,
      conflicts,
      alternatives,
      requestedSlot: {
        dateTime: appointmentData.dateTime,
        duration: appointmentData.duration,
        providerId: appointmentData.providerId,
        operatoryId: appointmentData.operatoryId
      }
    });

  } catch (error) {
    console.error('Conflict check API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check conflicts',
      message: error.message
    });
  }
});

// Find available time slots
router.post('/appointments/find-slots', async (req, res) => {
  try {
    const { 
      appointmentData,
      startDate,
      endDate,
      preferredTimes, // Array of preferred time ranges like ['09:00-12:00', '14:00-17:00']
      maxResults = 10
    } = req.body;

    if (!appointmentData || !appointmentData.duration || !appointmentData.providerId) {
      return res.status(400).json({
        success: false,
        message: 'appointmentData with duration and providerId is required'
      });
    }

    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const availableSlots = [];
    
    // Search through each day in the range
    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      const daySlots = await openDentalService.findAvailableSlotsForDay(appointmentData, new Date(date));
      
      // Filter by preferred times if specified
      let filteredSlots = daySlots;
      if (preferredTimes && preferredTimes.length > 0) {
        filteredSlots = daySlots.filter(slot => {
          const slotTime = slot.time;
          return preferredTimes.some(timeRange => {
            const [startTime, endTime] = timeRange.split('-');
            return slotTime >= startTime && slotTime <= endTime;
          });
        });
      }
      
      availableSlots.push(...filteredSlots);
      
      if (availableSlots.length >= maxResults) break;
    }

    res.json({
      success: true,
      availableSlots: availableSlots.slice(0, maxResults),
      searchCriteria: {
        startDate: start.toISOString().split('T')[0],
        endDate: end.toISOString().split('T')[0],
        duration: appointmentData.duration,
        providerId: appointmentData.providerId,
        operatoryId: appointmentData.operatoryId,
        preferredTimes
      },
      totalFound: availableSlots.length
    });

  } catch (error) {
    console.error('Find slots API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to find available slots',
      message: error.message
    });
  }
});

// ============================================================================
// APPOINTMENT BOOKING AND MANAGEMENT
// ============================================================================

// Book a new appointment
router.post('/appointments', async (req, res) => {
  try {
    const appointmentData = req.body;
    
    // Validate required fields
    const requiredFields = ['patientId', 'providerId', 'operatoryId', 'dateTime', 'duration'];
    const missingFields = requiredFields.filter(field => !appointmentData[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        missingFields,
        requiredFields
      });
    }

    const result = await openDentalService.bookAppointment(appointmentData);
    
    if (result.success) {
      res.status(201).json({
        success: true,
        message: 'Appointment booked successfully',
        appointmentId: result.appointmentId,
        appointment: result.appointment
      });
    } else {
      res.status(409).json({
        success: false,
        message: result.message,
        conflicts: result.conflicts,
        alternatives: result.alternatives
      });
    }

  } catch (error) {
    console.error('Booking API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to book appointment',
      message: error.message
    });
  }
});

// Update an existing appointment
router.put('/appointments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const result = await openDentalService.updateAppointment(id, updateData);
    
    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        appointment: result.appointment
      });
    } else {
      res.status(409).json({
        success: false,
        message: result.message,
        conflicts: result.conflicts
      });
    }

  } catch (error) {
    console.error('Update appointment API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update appointment',
      message: error.message
    });
  }
});

// Update appointment status only
router.patch('/appointments/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Status is required'
      });
    }

    const updateData = { status };
    if (notes) updateData.notes = notes;

    const result = await openDentalService.updateAppointment(id, updateData);
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Appointment status updated successfully',
        appointment: result.appointment
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.message,
        error: result.error
      });
    }

  } catch (error) {
    console.error('Update status API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update appointment status',
      message: error.message
    });
  }
});

// Cancel an appointment
router.delete('/appointments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const result = await openDentalService.cancelAppointment(id, reason);
    
    if (result.success) {
      res.json({
        success: true,
        message: result.message
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.message,
        error: result.error
      });
    }

  } catch (error) {
    console.error('Cancel appointment API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel appointment',
      message: error.message
    });
  }
});

// ============================================================================
// PATIENT VERIFICATION AND SEARCH
// ============================================================================

// Search patients with comprehensive query support
router.get('/patients/search', async (req, res) => {
  try {
    const { q, type } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: 'Search query must be at least 2 characters long'
      });
    }

    const patients = await openDentalService.searchPatients(q.trim());
    
    res.json({
      success: true,
      patients: patients || [],
      query: q.trim(),
      count: patients ? patients.length : 0
    });

  } catch (error) {
    console.error('Patient search API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search patients',
      message: error.message
    });
  }
});

// Verify patient appointments (for AI agent use)
router.get('/patients/:id/appointments', async (req, res) => {
  try {
    const { id } = req.params;
    const { includeHistory = 'true' } = req.query;

    const verification = await openDentalService.verifyPatientAppointments(
      id, 
      includeHistory === 'true'
    );

    res.json({
      success: true,
      patientId: id,
      hasUpcoming: verification.hasUpcoming,
      upcomingAppointments: verification.upcomingAppointments,
      recentAppointments: verification.recentAppointments,
      appointmentCount: {
        upcoming: verification.upcomingAppointments.length,
        recent: verification.recentAppointments.length
      }
    });

  } catch (error) {
    console.error('Patient verification API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify patient appointments',
      message: error.message
    });
  }
});

// Get patient details
router.get('/patients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const patient = await openDentalService.getPatientDetails(id);
    
    if (!patient) {
      return res.status(404).json({
        success: false,
        message: 'Patient not found'
      });
    }

    res.json({
      success: true,
      patient
    });

  } catch (error) {
    console.error('Get patient API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch patient details',
      message: error.message
    });
  }
});

// ============================================================================
// PROVIDER AND OPERATORY MANAGEMENT
// ============================================================================

// Get providers list
router.get('/providers', async (req, res) => {
  try {
    const providers = await openDentalService.getProviders();
    
    res.json({
      success: true,
      providers: providers || [],
      count: providers ? providers.length : 0
    });

  } catch (error) {
    console.error('Providers API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch providers',
      message: error.message
    });
  }
});

// Get operatories list
router.get('/operatories', async (req, res) => {
  try {
    const operatories = await openDentalService.getOperatories();
    
    res.json({
      success: true,
      operatories: operatories || [],
      count: operatories ? operatories.length : 0
    });

  } catch (error) {
    console.error('Operatories API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch operatories',
      message: error.message
    });
  }
});

// Get provider working hours
router.get('/providers/:id/schedule', async (req, res) => {
  try {
    const { id } = req.params;
    const { date } = req.query;
    
    const targetDate = date || new Date().toISOString().split('T')[0];
    const workingHours = await openDentalService.getProviderWorkingHours(id, targetDate);
    
    res.json({
      success: true,
      providerId: id,
      date: targetDate,
      workingHours
    });

  } catch (error) {
    console.error('Provider schedule API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch provider schedule',
      message: error.message
    });
  }
});

// ============================================================================
// AI AGENT SPECIFIC ENDPOINTS
// ============================================================================

// Smart booking for AI agents with comprehensive conflict handling
router.post('/ai/smart-book', async (req, res) => {
  try {
    const { 
      patientInfo,
      appointmentPreferences,
      callId,
      agentId
    } = req.body;

    // Validate required fields
    if (!patientInfo || !appointmentPreferences) {
      return res.status(400).json({
        success: false,
        message: 'patientInfo and appointmentPreferences are required'
      });
    }

    // Step 1: Search for existing patient
    let patient = null;
    if (patientInfo.phone || patientInfo.email || patientInfo.name) {
      const searchQuery = patientInfo.phone || patientInfo.email || patientInfo.name;
      const searchResults = await openDentalService.searchPatients(searchQuery);
      
      if (searchResults.length > 0) {
        // Use first match or let AI decide which patient
        patient = searchResults[0];
      }
    }

    // Step 2: Verify existing appointments if patient found
    let existingAppointments = [];
    if (patient) {
      const verification = await openDentalService.verifyPatientAppointments(patient.id);
      existingAppointments = verification.upcomingAppointments;
    }

    // Step 3: Find available slots based on preferences
    const appointmentData = {
      patientId: patient?.id,
      duration: appointmentPreferences.duration || 30,
      providerId: appointmentPreferences.providerId,
      operatoryId: appointmentPreferences.operatoryId,
      type: appointmentPreferences.type || 'Appointment',
      notes: appointmentPreferences.notes || `Booked via AI Agent ${agentId}`,
      isNew: !patient
    };

    const slotsResult = await openDentalService.findAvailableSlotsForDay(
      appointmentData,
      new Date(appointmentPreferences.preferredDate || new Date())
    );

    res.json({
      success: true,
      patientFound: !!patient,
      patient,
      existingAppointments,
      availableSlots: slotsResult.slice(0, 5), // Top 5 options
      recommendedActions: {
        needsPatientCreation: !patient,
        hasExistingAppointments: existingAppointments.length > 0,
        canBookImmediately: slotsResult.length > 0
      },
      callId,
      agentId
    });

  } catch (error) {
    console.error('AI smart booking API error:', error);
    res.status(500).json({
      success: false,
      error: 'Smart booking failed',
      message: error.message
    });
  }
});

// Quick appointment verification for AI agents
router.get('/ai/verify-appointment', async (req, res) => {
  try {
    const { phone, name, dateOfBirth } = req.query;
    
    if (!phone && !name && !dateOfBirth) {
      return res.status(400).json({
        success: false,
        message: 'At least one search parameter (phone, name, or dateOfBirth) is required'
      });
    }

    const searchQuery = phone || name || dateOfBirth;
    const patients = await openDentalService.searchPatients(searchQuery);
    
    let result = {
      patientFound: false,
      hasUpcomingAppointments: false,
      patients: [],
      appointments: []
    };

    if (patients.length > 0) {
      result.patientFound = true;
      result.patients = patients;

      // Check appointments for first matching patient
      const verification = await openDentalService.verifyPatientAppointments(patients[0].id);
      result.hasUpcomingAppointments = verification.hasUpcoming;
      result.appointments = verification.upcomingAppointments;
    }

    res.json({
      success: true,
      ...result,
      searchQuery,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('AI verification API error:', error);
    res.status(500).json({
      success: false,
      error: 'Appointment verification failed',
      message: error.message
    });
  }
});

// Get office schedule overview for AI agents
router.get('/ai/schedule-overview', async (req, res) => {
  try {
    const { date, providerId } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const appointments = await openDentalService.getCalendarAppointments({
      date: targetDate,
      providerIds: providerId ? [parseInt(providerId)] : undefined
    });

    const providers = await openDentalService.getProviders();
    const operatories = await openDentalService.getOperatories();

    // Calculate availability metrics
    const totalSlots = 16; // 8 hours * 2 slots per hour (rough estimate)
    const bookedSlots = appointments.length;
    const availabilityPercentage = Math.max(0, (totalSlots - bookedSlots) / totalSlots * 100);

    res.json({
      success: true,
      date: targetDate,
      appointments,
      providers,
      operatories,
      metrics: {
        totalAppointments: appointments.length,
        totalSlots,
        bookedSlots,
        availabilityPercentage: Math.round(availabilityPercentage),
        hasAvailability: availabilityPercentage > 0
      },
      lastSync: openDentalService.lastSyncTime
    });

  } catch (error) {
    console.error('AI schedule overview API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get schedule overview',
      message: error.message
    });
  }
});

// ============================================================================
// ERROR HANDLING MIDDLEWARE
// ============================================================================

// Handle 404s
router.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    message: `Open Dental API endpoint ${req.originalUrl} not found`
  });
});

// Global error handler for this router
router.use((error, req, res, next) => {
  console.error('Open Dental Router Error:', error);
  
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: error.message,
    endpoint: req.originalUrl
  });
});

module.exports = router; 