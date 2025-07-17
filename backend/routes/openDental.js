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

// Get calendar appointments for a date range
router.get('/calendar', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({ 
        error: 'Open Dental not configured',
        message: 'Please configure OD_API_URL and OD_API_KEY environment variables'
      });
    }

    const { startDate, endDate } = req.query;
    
    if (!startDate) {
      return res.status(400).json({ 
        error: 'Start date required',
        message: 'Please provide startDate parameter (YYYY-MM-DD format)'
      });
    }

    const appointments = await openDentalService.getCalendarAppointments(startDate, endDate);
    
    res.json({ 
      appointments,
      dateRange: { startDate, endDate },
      count: appointments.length
    });
  } catch (error) {
    console.error('Error fetching calendar appointments:', error);
    res.status(500).json({ 
      error: 'Failed to fetch calendar appointments',
      message: error.message 
    });
  }
});

// Enhanced slots endpoint with calendar support
router.post('/slots', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({ 
        error: 'Open Dental not configured',
        message: 'Please configure OD_API_URL and OD_API_KEY environment variables'
      });
    }

    const slots = await openDentalService.getSlots(req.body);
    
    res.json({ 
      slots,
      refreshedAt: new Date().toISOString(),
      parameters: req.body
    });
  } catch (error) {
    console.error('Error fetching appointment slots:', error);
    res.status(500).json({ 
      error: 'Failed to fetch appointment slots',
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

    const { patNum, slot, defNumApptType, callId } = req.body;

    if (!patNum || !slot || !defNumApptType) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['patNum', 'slot', 'defNumApptType']
      });
    }

    const appointment = await openDentalService.bookSlot(patNum, slot, defNumApptType);
    
    // Log the successful booking
    console.log(`✅ Appointment booked for patient ${patNum}:`, appointment);
    
    res.json({ 
      success: true,
      appointment,
      message: 'Appointment successfully booked'
    });
  } catch (error) {
    console.error('Error booking appointment:', error);
    
    if (error.message === 'Appointment slot already booked') {
      return res.status(409).json({ 
        error: 'Slot already booked',
        message: 'This appointment slot is no longer available'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to book appointment',
      message: error.message 
    });
  }
});

// Search patient by phone number
router.get('/patient/search', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({ 
        error: 'Open Dental not configured'
      });
    }

    const { phone } = req.query;
    
    if (!phone) {
      return res.status(400).json({ 
        error: 'Phone number required',
        message: 'Please provide a phone parameter'
      });
    }

    const patients = await openDentalService.searchPatientByPhone(phone);
    res.json({ patients });
  } catch (error) {
    console.error('Error searching patient:', error);
    res.status(500).json({ 
      error: 'Failed to search patient',
      message: error.message 
    });
  }
});

// Get patient details
router.get('/patient/:patNum', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({ 
        error: 'Open Dental not configured'
      });
    }

    const { patNum } = req.params;
    const patient = await openDentalService.getPatient(patNum);
    res.json({ patient });
  } catch (error) {
    console.error('Error fetching patient:', error);
    res.status(500).json({ 
      error: 'Failed to fetch patient',
      message: error.message 
    });
  }
});

// Create new patient
router.post('/patient', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({ 
        error: 'Open Dental not configured'
      });
    }

    const patient = await openDentalService.createPatient(req.body);
    res.json({ 
      success: true,
      patient,
      message: 'Patient successfully created'
    });
  } catch (error) {
    console.error('Error creating patient:', error);
    res.status(500).json({ 
      error: 'Failed to create patient',
      message: error.message 
    });
  }
});

// Smart appointment booking from call data
router.post('/smart-book', async (req, res) => {
  try {
    if (!openDentalService.isEnabled()) {
      return res.status(503).json({ 
        error: 'Open Dental not configured'
      });
    }

    const { callId, callerPhone, callerName, appointmentType = 'checkup' } = req.body;

    // Step 1: Search for existing patient
    let patient;
    try {
      const searchResults = await openDentalService.searchPatientByPhone(callerPhone);
      patient = searchResults.length > 0 ? searchResults[0] : null;
    } catch (error) {
      console.log('Patient search failed, will create new patient');
    }

    // Step 2: Create patient if not found
    if (!patient) {
      const patientData = {
        FName: callerName.split(' ')[0] || 'Unknown',
        LName: callerName.split(' ').slice(1).join(' ') || 'Patient',
        HmPhone: callerPhone,
        // Add other required fields based on your Open Dental setup
      };
      
      try {
        patient = await openDentalService.createPatient(patientData);
      } catch (error) {
        return res.status(500).json({
          error: 'Failed to create patient',
          message: error.message
        });
      }
    }

    // Step 3: Get available slots
    const slotsResponse = await openDentalService.getSlots({
      startDate: new Date().toISOString().split('T')[0], // Today
      days: 14, // Next 2 weeks
      appointmentType
    });

    if (!slotsResponse.length) {
      return res.json({
        success: false,
        message: 'No available appointment slots found',
        patient,
        availableSlots: []
      });
    }

    res.json({
      success: true,
      message: 'Patient found/created, slots available',
      patient,
      availableSlots: slotsResponse,
      suggestedBooking: {
        patNum: patient.PatNum,
        slot: slotsResponse[0], // First available slot
        defNumApptType: 1 // Default appointment type
      }
    });

  } catch (error) {
    console.error('Error in smart booking:', error);
    res.status(500).json({ 
      error: 'Smart booking failed',
      message: error.message 
    });
  }
});

module.exports = router; 