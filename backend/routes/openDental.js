const express = require('express');
const router = express.Router();
const openDentalService = require('../config/openDental');

// Health check for Open Dental integration
router.get('/health', (req, res) => {
  res.json({
    enabled: openDentalService.isEnabled(),
    status: openDentalService.isEnabled() ? 'connected' : 'disabled',
    lastCheck: new Date().toISOString()
  });
});

// Get calendar data with provider/operatory view support
router.get('/calendar', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({
        error: 'Open Dental not configured',
        message: 'Please configure OD_API_URL and OD_API_KEY environment variables'
      });
    }

    const { date, view, providerIds, operatoryIds } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];
    const viewMode = view || 'provider';

    // Get appointments for the specified date
    const appointments = await openDentalService.getCalendarAppointments({
      date: targetDate,
      view: viewMode,
      providerIds: providerIds ? providerIds.split(',') : undefined,
      operatoryIds: operatoryIds ? operatoryIds.split(',') : undefined
    });

    // Get providers and operatories
    const [providers, operatories] = await Promise.all([
      openDentalService.getProviders(),
      openDentalService.getOperatories()
    ]);

    res.json({
      date: targetDate,
      view: viewMode,
      appointments: appointments || [],
      providers: providers || [],
      operatories: operatories || [],
      totalAppointments: appointments ? appointments.length : 0
    });

  } catch (error) {
    console.error('Calendar API error:', error);
    res.status(500).json({
      error: 'Failed to fetch calendar data',
      message: error.message
    });
  }
});

// Get providers list
router.get('/providers', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({
        error: 'Open Dental not configured',
        message: 'Please configure OD_API_URL and OD_API_KEY environment variables'
      });
    }

    const providers = await openDentalService.getProviders();
    res.json({
      providers: providers || [],
      count: providers ? providers.length : 0
    });

  } catch (error) {
    console.error('Providers API error:', error);
    res.status(500).json({
      error: 'Failed to fetch providers',
      message: error.message
    });
  }
});

// Get operatories list
router.get('/operatories', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({
        error: 'Open Dental not configured',
        message: 'Please configure OD_API_URL and OD_API_KEY environment variables'
      });
    }

    const operatories = await openDentalService.getOperatories();
    res.json({
      operatories: operatories || [],
      count: operatories ? operatories.length : 0
    });

  } catch (error) {
    console.error('Operatories API error:', error);
    res.status(500).json({
      error: 'Failed to fetch operatories',
      message: error.message
    });
  }
});

// Get appointment slots for a date range
router.get('/slots', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({
        error: 'Open Dental not configured',
        message: 'Please configure OD_API_URL and OD_API_KEY environment variables'
      });
    }

    const { 
      startDate, 
      endDate, 
      providerId, 
      operatoryId,
      appointmentType,
      duration 
    } = req.query;

    const slots = await openDentalService.getAvailableSlots({
      startDate,
      endDate,
      providerId,
      operatoryId,
      appointmentType,
      duration: duration ? parseInt(duration) : undefined
    });

    res.json({
      slots: slots || [],
      count: slots ? slots.length : 0,
      dateRange: { startDate, endDate }
    });

  } catch (error) {
    console.error('Slots API error:', error);
    res.status(500).json({
      error: 'Failed to fetch available slots',
      message: error.message
    });
  }
});

// Book an appointment
router.post('/book', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({
        error: 'Open Dental not configured',
        message: 'Please configure OD_API_URL and OD_API_KEY environment variables'
      });
    }

    const appointmentData = req.body;
    
    // Validate required fields
    const requiredFields = ['patientId', 'providerId', 'operatoryId', 'dateTime', 'duration', 'appointmentType'];
    const missingFields = requiredFields.filter(field => !appointmentData[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: `The following fields are required: ${missingFields.join(', ')}`
      });
    }

    const result = await openDentalService.bookAppointment(appointmentData);
    
    res.status(201).json({
      success: true,
      appointment: result,
      message: 'Appointment booked successfully'
    });

  } catch (error) {
    console.error('Booking API error:', error);
    res.status(500).json({
      error: 'Failed to book appointment',
      message: error.message
    });
  }
});

// Update appointment status
router.patch('/appointments/:id/status', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({
        error: 'Open Dental not configured',
        message: 'Please configure OD_API_URL and OD_API_KEY environment variables'
      });
    }

    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        error: 'Status is required',
        message: 'Please provide a valid appointment status'
      });
    }

    const result = await openDentalService.updateAppointmentStatus(id, status);
    
    res.json({
      success: true,
      appointment: result,
      message: 'Appointment status updated successfully'
    });

  } catch (error) {
    console.error('Update status API error:', error);
    res.status(500).json({
      error: 'Failed to update appointment status',
      message: error.message
    });
  }
});

// Cancel appointment
router.delete('/appointments/:id', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({
        error: 'Open Dental not configured',
        message: 'Please configure OD_API_URL and OD_API_KEY environment variables'
      });
    }

    const { id } = req.params;
    const { reason } = req.body;

    const result = await openDentalService.cancelAppointment(id, reason);
    
    res.json({
      success: true,
      message: 'Appointment cancelled successfully',
      cancellationId: result.id
    });

  } catch (error) {
    console.error('Cancel appointment API error:', error);
    res.status(500).json({
      error: 'Failed to cancel appointment',
      message: error.message
    });
  }
});

// Search patients
router.get('/patients/search', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({
        error: 'Open Dental not configured',
        message: 'Please configure OD_API_URL and OD_API_KEY environment variables'
      });
    }

    const { q } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.status(400).json({
        error: 'Invalid search query',
        message: 'Search query must be at least 2 characters long'
      });
    }

    const patients = await openDentalService.searchPatients(q.trim());
    
    res.json({
      patients: patients || [],
      count: patients ? patients.length : 0,
      query: q.trim()
    });

  } catch (error) {
    console.error('Patient search API error:', error);
    res.status(500).json({
      error: 'Failed to search patients',
      message: error.message
    });
  }
});

// Create new patient
router.post('/patients', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({
        error: 'Open Dental not configured',
        message: 'Please configure OD_API_URL and OD_API_KEY environment variables'
      });
    }

    const patientData = req.body;
    
    // Validate required fields
    const requiredFields = ['firstName', 'lastName', 'dateOfBirth'];
    const missingFields = requiredFields.filter(field => !patientData[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: `The following fields are required: ${missingFields.join(', ')}`
      });
    }

    const result = await openDentalService.createPatient(patientData);
    
    res.status(201).json({
      success: true,
      patient: result,
      message: 'Patient created successfully'
    });

  } catch (error) {
    console.error('Create patient API error:', error);
    res.status(500).json({
      error: 'Failed to create patient',
      message: error.message
    });
  }
});

// Get appointment details
router.get('/appointments/:id', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({
        error: 'Open Dental not configured',
        message: 'Please configure OD_API_URL and OD_API_KEY environment variables'
      });
    }

    const { id } = req.params;
    const appointment = await openDentalService.getAppointmentDetails(id);
    
    if (!appointment) {
      return res.status(404).json({
        error: 'Appointment not found',
        message: `No appointment found with ID: ${id}`
      });
    }

    res.json({
      appointment,
      success: true
    });

  } catch (error) {
    console.error('Get appointment API error:', error);
    res.status(500).json({
      error: 'Failed to fetch appointment details',
      message: error.message
    });
  }
});

module.exports = router; 