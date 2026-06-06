const express = require('express');
const router = express.Router();
const retellService = require('../config/retell');
const odAccess = require('../platform/odAccess');
const { filterCallsForOffice, getOfficeConfig } = require('../config/officeAgents');

// Enhanced AI-powered name extraction function
const extractCallerNameAdvanced = async (transcript, summary, callerNumber) => {
  // First try basic extraction patterns
  const basicName = extractCallerNameBasic(transcript, callerNumber);
  if (basicName !== callerNumber) {
    return basicName;
  }

  // Try AI-powered analysis of summary
  const summaryName = extractNameFromSummary(summary);
  if (summaryName) {
    return summaryName;
  }

  // Try more advanced transcript analysis
  const advancedName = extractNameAdvanced(transcript, summary);
  if (advancedName) {
    return advancedName;
  }

  return callerNumber; // Final fallback
};

// Basic regex-based name extraction (existing logic)
const extractCallerNameBasic = (transcript, callerNumber) => {
  // Guard against a non-string transcript (e.g. Retell's transcript_object array): the
  // regex `.match()` calls below would otherwise throw "transcript.match is not a function".
  if (!transcript || typeof transcript !== 'string') return callerNumber;

  // Common AI agent names to exclude
  const agentNames = ['karen', 'assistant', 'agent', 'bot', 'ai', 'system', 'operator'];
  
  // Look for caller-specific patterns (what the USER says, not the agent)
  const callerPatterns = [
    /(?:user|caller):\s*.*?(?:my name is|i'm|this is|i am)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?:user|caller):\s*.*?(?:call me|it's|name's)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    // Look for direct caller introduction patterns
    /(?:user|caller):\s*(?:hi|hello),?\s*(?:my name is|i'm|this is)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    // Generic patterns but exclude agent responses
    /(?<!agent:.*?)(?:my name is|i'm|this is|i am)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    // More natural conversation patterns
    /(?:user|caller):\s*(?:hi|hello),?\s*([a-zA-Z]+(?:\s+[a-zA-Z]+)?)\s+(?:here|speaking|calling)/i,
    // Phone greeting patterns
    /(?:user|caller):\s*(?:this is|it's)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i
  ];
  
  for (const pattern of callerPatterns) {
    const match = transcript.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim().toLowerCase();
      
      // Validate the name and exclude agent names
      const commonWords = ['okay', 'yes', 'no', 'sure', 'well', 'um', 'uh', 'the', 'that', 'this', 'here', 'calling'];
      if (name.length > 1 && 
          !commonWords.includes(name) && 
          !agentNames.includes(name)) {
        return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
      }
    }
  }
  
  return callerNumber;
};

// Extract name from call summary using AI-style analysis
const extractNameFromSummary = (summary) => {
  if (!summary) return null;

  // Look for name patterns in summaries
  const summaryPatterns = [
    /patient\s+(?:named\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
    /caller\s+(?:named\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
    /Mr\.?\s+([A-Z][a-zA-Z]+)/i,
    /Mrs\.?\s+([A-Z][a-zA-Z]+)/i,
    /Ms\.?\s+([A-Z][a-zA-Z]+)/i,
    /([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+called/i,
    /([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+is\s+(?:calling|requesting|asking)/i
  ];

  for (const pattern of summaryPatterns) {
    const match = summary.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      // Validate it's a real name (not common words)
      const commonWords = ['Patient', 'Caller', 'Person', 'User', 'Someone', 'Individual'];
      if (!commonWords.includes(name)) {
        return name;
      }
    }
  }

  return null;
};

// Advanced name extraction using context analysis
const extractNameAdvanced = (transcript, summary) => {
  if (!transcript && !summary) return null;

  const fullText = `${transcript || ''} ${summary || ''}`;
  
  // Look for name patterns with better context awareness
  const advancedPatterns = [
    // Agent addressing caller by name
    /(?:agent|assistant):\s*.*?(?:thank you|hello|hi),?\s+([A-Z][a-zA-Z]+)/i,
    /(?:agent|assistant):\s*.*?I(?:'ll|'d)\s+(?:be happy to\s+)?help\s+you,?\s+([A-Z][a-zA-Z]+)/i,
    // Appointment scheduling context
    /(?:appointment|booking|schedule).*?for\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
    // Prescription/medical context
    /(?:prescription|medication|refill).*for\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
    // General medical context
    /(?:patient|caller)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:needs|wants|requires|is)/i
  ];

  for (const pattern of advancedPatterns) {
    const match = fullText.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      // Additional validation
      if (name.length > 1 && !/^\d/.test(name)) {
        return name;
      }
    }
  }

  return null;
};

// Check if caller is new or existing patient using OpenDental
const determinePatientStatus = async (req, callerName, callerNumber) => {
  try {
    // First try to find patient by phone number
    let patients = [];

    if (callerNumber && callerNumber !== 'Unknown') {
      const cleanPhone = callerNumber.replace(/\D/g, '');
      if (cleanPhone.length >= 10) {
        patients = await odAccess.searchPatients(req, cleanPhone);
      }
    }

    // If no match by phone, try by name
    if (patients.length === 0 && callerName && callerName !== callerNumber) {
      patients = await odAccess.searchPatients(req, callerName);
    }

    if (patients.length > 0) {
      // Found matching patient(s) - they're existing
      const patient = patients[0]; // Take the first match

      // Get appointment history to confirm they're really existing
      const appointmentHistory = await odAccess.verifyPatientAppointments(req, patient.id);
      
      return {
        isNewPatient: false,
        patientId: patient.id,
        patientName: patient.fullName,
        hasAppointmentHistory: appointmentHistory.recentAppointments.length > 0 || appointmentHistory.hasUpcoming,
        matchedBy: callerNumber && callerNumber !== 'Unknown' ? 'phone' : 'name'
      };
    }

    // No matching patient found - they're new
    return {
      isNewPatient: true,
      patientId: null,
      patientName: callerName,
      hasAppointmentHistory: false,
      matchedBy: null
    };

  } catch (error) {
    console.error('Error determining patient status:', error);
    // Default to new patient if we can't determine
    return {
      isNewPatient: true,
      patientId: null,
      patientName: callerName,
      hasAppointmentHistory: false,
      matchedBy: null,
      error: error.message
    };
  }
};

// Enhanced mock data with better variety including transfer tracking
const generateMockCalls = () => [
  {
    call_id: '1',
    caller_name: 'John Smith',
    caller_number: '+1234567890',
    call_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    reason: 'Appointment booking',
    duration: 180,
    success_status: 'Resolved',
    sentiment: 'positive',
    is_new_patient: true,
    is_emergency: false,
    transfer_status: 'successful',
    transfer_attempted: true,
    transfer_destination: 'Appointment Desk',
    transfer_timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000 + 120000).toISOString(),
    callback_required: false,
    summary: 'Patient John Smith called to schedule a routine checkup appointment for next week. Successfully transferred to appointment desk after initial screening. Patient was able to schedule appointment.',
    transcript: 'Agent: Hello, thank you for calling our medical practice. How can I help you today? User: Hi, my name is John Smith, I need to schedule an appointment for a routine checkup. Agent: I\'d be happy to help you schedule that appointment, Mr. Smith. Let me transfer you to our appointment desk. User: That sounds great, thank you.',
    recording_url: 'https://example.com/recordings/call1.mp3'
  },
  {
    call_id: '2',
    caller_name: 'Sarah Johnson',
    caller_number: '+0987654321',
    call_date: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    reason: 'Emergency consultation',
    duration: 420,
    success_status: 'Unresolved',
    sentiment: 'negative',
    is_new_patient: false,
    is_emergency: true,
    transfer_status: 'failed',
    transfer_attempted: true,
    transfer_destination: 'Emergency Line',
    transfer_timestamp: new Date(Date.now() - 4 * 60 * 60 * 1000 + 300000).toISOString(),
    callback_required: true,
    callback_reason: 'Transfer to emergency line failed - patient disconnected',
    summary: 'URGENT: Emergency call from existing patient Sarah Johnson regarding severe chest pain. Attempted transfer to emergency line but call was disconnected. REQUIRES IMMEDIATE CALLBACK.',
    transcript: 'Agent: Emergency line, how can I help? User: This is Sarah Johnson, I\'m having severe chest pain and trouble breathing. I need help immediately. Agent: I understand this is urgent, Sarah. Let me transfer you to our emergency line right away. User: Please hurry, I... [call disconnected]',
    recording_url: 'https://example.com/recordings/call2.mp3'
  },
  {
    call_id: '3',
    caller_name: 'Mike Williams',
    caller_number: '+1122334455',
    call_date: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    reason: 'Prescription refill',
    duration: 150,
    success_status: 'Resolved',
    sentiment: 'neutral',
    is_new_patient: false,
    is_emergency: false,
    transfer_status: 'successful',
    transfer_attempted: true,
    transfer_destination: 'Pharmacy Department',
    transfer_timestamp: new Date(Date.now() - 6 * 60 * 60 * 1000 + 90000).toISOString(),
    callback_required: false,
    summary: 'Existing patient Mike Williams requested prescription refill for ongoing blood pressure medication. Successfully transferred to pharmacy department and refill processed.',
    transcript: 'Agent: How can I help you today? User: Hi, I\'m Mike Williams and I need a prescription refill for my blood pressure medication. Agent: I can help you with that, Mike. Let me verify your information and transfer you to our pharmacy department.',
    recording_url: 'https://example.com/recordings/call3.mp3'
  },
  {
    call_id: '4',
    caller_name: 'Lisa Brown',
    caller_number: '+2233445566',
    call_date: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    reason: 'Insurance verification',
    duration: 240,
    success_status: 'Unresolved',
    sentiment: 'neutral',
    is_new_patient: true,
    is_emergency: false,
    transfer_status: 'voicemail',
    transfer_attempted: true,
    transfer_destination: 'Billing Department',
    transfer_timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000 + 180000).toISOString(),
    callback_required: true,
    callback_reason: 'Billing department unavailable - patient left voicemail requesting callback',
    summary: 'New patient Lisa Brown called to verify insurance coverage for upcoming procedure. Billing department was unavailable, patient left voicemail requesting callback about coverage details.',
    transcript: 'Agent: Thank you for calling. How can I assist you? User: Hi, this is Lisa Brown. I need to verify my insurance coverage for an upcoming procedure. Agent: I\'ll transfer you to our billing department for insurance verification. [Transfer to voicemail] User: Hi, this is Lisa Brown, please call me back about my insurance coverage verification.',
    recording_url: null
  },
  {
    call_id: '5',
    caller_name: '+5555551234',
    caller_number: '+5555551234',
    call_date: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    reason: 'Appointment inquiry',
    duration: 90,
    success_status: 'Unresolved',
    sentiment: 'negative',
    is_new_patient: true,
    is_emergency: false,
    transfer_status: 'failed',
    transfer_attempted: true,
    transfer_destination: 'Scheduling Department',
    transfer_timestamp: new Date(Date.now() - 8 * 60 * 60 * 1000 + 60000).toISOString(),
    callback_required: true,
    callback_reason: 'Transfer failed due to technical issues - caller hung up frustrated',
    summary: 'Unknown caller inquired about appointment availability. Transfer to scheduling department failed due to technical issues. Caller became frustrated and disconnected. REQUIRES CALLBACK.',
    transcript: 'Agent: Hello, how can I help you? User: Yeah, I need to see if I can get an appointment. Agent: Of course! Let me transfer you to our scheduling department. User: This is taking too long! [hangs up]',
    recording_url: null
  }
];

// Get all calls
router.get('/', async (req, res) => {
  try {
    const { 
      limit = 50, 
      offset = 0, 
      sort_order = 'descending',
      filter_criteria = {},
      start_time,
      end_time,
      office_id
    } = req.query;

    const params = {
      limit: parseInt(limit),
      offset: parseInt(offset),
      sort_order
    };

    if (start_time) params.start_time = start_time;
    if (end_time) params.end_time = end_time;
    if (Object.keys(filter_criteria).length > 0) {
      params.filter_criteria = filter_criteria;
    }

    let calls;
    let useMockData = false;

    try {
      const apiResponse = await retellService.getCalls(params);
      calls = apiResponse;
      
      // If API returns empty or no calls, use mock data
      if (!calls || calls.length === 0) {
        calls = generateMockCalls();
        useMockData = true;
      }
    } catch (apiError) {
      console.log('Retell API not available, using mock data for demonstration');
      calls = generateMockCalls();
      useMockData = true;
    }
    
    // Transform data to include additional fields for the dashboard
    const transformedCalls = await Promise.all(calls.map(async (call) => {
      let callerName, isNewPatient, patientInfo;
      
      if (useMockData) {
        // Use mock data as-is
        callerName = call.caller_name;
        isNewPatient = call.is_new_patient;
        patientInfo = { isNewPatient, patientName: callerName };
      } else {
        // Process real API data with enhanced name extraction and patient lookup
        const extractedName = await extractCallerNameAdvanced(
          call.transcript, 
          call.call_summary || call.summary, 
          call.from_number || 'Unknown'
        );
        
        // Determine patient status using OpenDental
        patientInfo = await determinePatientStatus(req, extractedName, call.from_number);
        
        callerName = patientInfo.patientName || extractedName;
        isNewPatient = patientInfo.isNewPatient;
      }

      return {
        ...call,
        call_id: call.call_id || call.id,
        id: call.call_id || call.id, // Ensure we have both id and call_id
        caller_name: callerName,
        caller_number: useMockData ? call.caller_number : call.from_number,
        call_date: useMockData ? call.call_date : call.start_timestamp,
        reason: useMockData ? call.reason : (call.call_summary || 'Not available'),
        duration: useMockData ? call.duration : (call.end_timestamp && call.start_timestamp ? 
          Math.round((new Date(call.end_timestamp) - new Date(call.start_timestamp)) / 1000) : 0),
        success_status: useMockData ? call.success_status : (call.call_status === 'completed' ? 'Resolved' : 'Unresolved'),
        sentiment: useMockData ? call.sentiment : (call.sentiment || 'neutral'),
        is_new_patient: isNewPatient,
        is_emergency: useMockData ? call.is_emergency : (call.metadata?.is_emergency || false),
        summary: useMockData ? call.summary : (call.call_analysis?.call_summary || 'No summary available'),
        transcript: useMockData ? call.transcript : (call.transcript || 'Transcript not available'),
        recording_url: useMockData ? call.recording_url : call.recording_url,
        // Include agent information
        agent_id: useMockData ? call.agent_id : call.agent_id,
        // Add transfer tracking fields
        transfer_status: useMockData ? call.transfer_status : (call.metadata?.transfer_status || 'none'),
        transfer_attempted: useMockData ? call.transfer_attempted : (call.metadata?.transfer_attempted || false),
        transfer_destination: useMockData ? call.transfer_destination : (call.metadata?.transfer_destination || null),
        transfer_timestamp: useMockData ? call.transfer_timestamp : (call.metadata?.transfer_timestamp || null),
        callback_required: useMockData ? call.callback_required : (call.metadata?.callback_required || false),
        callback_reason: useMockData ? call.callback_reason : (call.metadata?.callback_reason || null),
        // Add patient matching info for debugging/display
        patient_match_info: useMockData ? null : patientInfo
      };
    }));

    // Filter calls based on office configuration if office_id provided
    const finalCalls = office_id ? filterCallsForOffice(transformedCalls, office_id) : transformedCalls;

    res.json({
      calls: finalCalls,
      total: finalCalls.length,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        has_more: finalCalls.length === parseInt(limit)
      },
      source: useMockData ? 'mock' : 'api',
      office_config: office_id ? getOfficeConfig(office_id) : null
    });
  } catch (error) {
    console.error('Error in calls route:', error);
    // Final fallback to mock data
    const mockCalls = generateMockCalls();
    res.json({
      calls: mockCalls.map(call => ({ ...call, id: call.call_id })),
      total: mockCalls.length,
      pagination: {
        limit: 50,
        offset: 0,
        has_more: false
      },
      source: 'mock'
    });
  }
});

// Get specific call details
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let call;
    let useMockData = false;

    try {
      call = await retellService.getCall(id);
    } catch (apiError) {
      console.log('Retell API not available, using mock data for call details');
      // Find mock call by ID
      const mockCalls = generateMockCalls();
      call = mockCalls.find(c => c.call_id === id) || mockCalls[0];
      useMockData = true;
    }

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }
    
    const transformedCall = {
      ...call,
      call_id: call.call_id || call.id,
      id: call.call_id || call.id,
      caller_name: useMockData ? call.caller_name : extractCallerName(call.transcript, call.from_number || 'Unknown'),
      caller_number: useMockData ? call.caller_number : call.from_number,
      call_date: useMockData ? call.call_date : call.start_timestamp,
      reason: useMockData ? call.reason : (call.call_summary || 'Not available'),
      duration: useMockData ? call.duration : (call.end_timestamp && call.start_timestamp ? 
        Math.round((new Date(call.end_timestamp) - new Date(call.start_timestamp)) / 1000) : 0),
      success_status: useMockData ? call.success_status : (call.call_status === 'completed' ? 'Resolved' : 'Unresolved'),
      sentiment: useMockData ? call.sentiment : (call.sentiment || 'neutral'),
      is_new_patient: useMockData ? call.is_new_patient : (call.metadata?.is_new_patient || false),
      is_emergency: useMockData ? call.is_emergency : (call.metadata?.is_emergency || false),
      summary: useMockData ? call.summary : (call.call_analysis?.call_summary || 'No summary available'),
      transcript: useMockData ? call.transcript : (call.transcript || 'Transcript not available'),
      recording_url: useMockData ? call.recording_url : call.recording_url,
      // Add sentiment analysis data
      sentiment_scores: useMockData && call.sentiment_scores ? call.sentiment_scores : [
        { time: '0:00', score: 0.5 },
        { time: '1:00', score: 0.3 },
        { time: '2:00', score: 0.7 }
      ]
    };

    res.json(transformedCall);
  } catch (error) {
    console.error('Error fetching call:', error);
    const mockCalls = generateMockCalls();
    const mockCall = mockCalls[0];
    res.json({
      ...mockCall,
      id: mockCall.call_id,
      transcript: mockCall.transcript || 'Mock transcript for demonstration purposes.',
      recording_url: mockCall.recording_url || null,
      sentiment_scores: [
        { time: '0:00', score: 0.5 },
        { time: '1:00', score: 0.3 },
        { time: '2:00', score: 0.7 }
      ]
    });
  }
});

// Get call transcript
router.get('/:id/transcript', async (req, res) => {
  try {
    const { id } = req.params;
    let transcript;

    try {
      transcript = await retellService.getCallTranscript(id);
    } catch (apiError) {
      console.log('Retell API not available, using mock transcript');
      // Find mock call by ID for transcript
      const mockCalls = generateMockCalls();
      const mockCall = mockCalls.find(c => c.call_id === id) || mockCalls[0];
      
      transcript = {
        transcript: mockCall.transcript || 'Mock transcript for demonstration purposes.',
        transcript_object: mockCall.transcript ? [
          { role: 'agent', content: 'Hello, how can I help you today?', timestamp: '00:00:00' },
          { role: 'user', content: mockCall.transcript.split('User: ')[1]?.split(' Agent:')[0] || 'I need assistance.', timestamp: '00:00:05' },
          { role: 'agent', content: 'I\'d be happy to help you with that.', timestamp: '00:00:10' }
        ] : []
      };
    }

    res.json(transcript);
  } catch (error) {
    console.error('Error fetching transcript:', error);
    res.json({
      transcript: 'Mock transcript for demonstration purposes.',
      transcript_object: [
        { role: 'agent', content: 'Hello, how can I help you today?', timestamp: '00:00:00' },
        { role: 'user', content: 'I need assistance.', timestamp: '00:00:05' },
        { role: 'agent', content: 'I\'d be happy to help you with that.', timestamp: '00:00:10' }
      ]
    });
  }
});

// Get call recording/audio
router.get('/:id/recording', async (req, res) => {
  try {
    const { id } = req.params;
    let recording;

    try {
      recording = await retellService.getCallRecording(id);
    } catch (apiError) {
      console.log('Retell API not available, checking mock data for recording');
      // Find mock call by ID for recording URL
      const mockCalls = generateMockCalls();
      const mockCall = mockCalls.find(c => c.call_id === id) || mockCalls[0];
      
      recording = { 
        recording_url: mockCall.recording_url || null,
        call_id: id,
        duration: mockCall.duration || 0
      };
    }

    res.json(recording);
  } catch (error) {
    console.error('Error fetching recording:', error);
    res.json({ 
      recording_url: null,
      call_id: req.params.id,
      duration: 0
    });
  }
});

// Search calls
router.post('/search', async (req, res) => {
  try {
    const { query, filters = {} } = req.body;
    let calls;
    let useMockData = false;

    try {
      calls = await retellService.getCalls();
    } catch (apiError) {
      console.log('Retell API not available, using mock data for search');
      calls = generateMockCalls();
      useMockData = true;
    }
    
    let filteredCalls = calls;
    
    if (query) {
      filteredCalls = calls.filter(call => {
        const searchFields = useMockData ? 
          [call.caller_name, call.caller_number, call.reason, call.summary, call.transcript] :
          [call.from_number, call.call_summary, call.transcript];
        
        return searchFields.some(field => 
          field && field.toLowerCase().includes(query.toLowerCase())
        );
      });
    }
    
    if (filters.sentiment) {
      filteredCalls = filteredCalls.filter(call => call.sentiment === filters.sentiment);
    }
    
    if (filters.call_status) {
      const expectedStatus = useMockData ? filters.call_status : 
        (filters.call_status === 'Resolved' ? 'completed' : 'other');
      filteredCalls = filteredCalls.filter(call => 
        useMockData ? call.success_status === filters.call_status : call.call_status === expectedStatus
      );
    }

    const transformedCalls = await Promise.all(filteredCalls.map(async (call) => {
      let callerName, isNewPatient, patientInfo;
      
      if (useMockData) {
        callerName = call.caller_name;
        isNewPatient = call.is_new_patient;
        patientInfo = { isNewPatient, patientName: callerName };
      } else {
        const extractedName = await extractCallerNameAdvanced(
          call.transcript, 
          call.call_summary || call.summary, 
          call.from_number || 'Unknown'
        );
        
        patientInfo = await determinePatientStatus(req, extractedName, call.from_number);
        callerName = patientInfo.patientName || extractedName;
        isNewPatient = patientInfo.isNewPatient;
      }

      return {
        ...call,
        call_id: call.call_id || call.id,
        id: call.call_id || call.id,
        caller_name: callerName,
        caller_number: useMockData ? call.caller_number : call.from_number,
        call_date: useMockData ? call.call_date : call.start_timestamp,
        reason: useMockData ? call.reason : (call.call_summary || 'Not available'),
        duration: useMockData ? call.duration : (call.end_timestamp && call.start_timestamp ? 
          Math.round((new Date(call.end_timestamp) - new Date(call.start_timestamp)) / 1000) : 0),
        success_status: useMockData ? call.success_status : (call.call_status === 'completed' ? 'Resolved' : 'Unresolved'),
        sentiment: useMockData ? call.sentiment : (call.sentiment || 'neutral'),
        is_new_patient: isNewPatient,
        is_emergency: useMockData ? call.is_emergency : (call.metadata?.is_emergency || false),
        summary: useMockData ? call.summary : (call.call_analysis?.call_summary || 'No summary available'),
        transcript: useMockData ? call.transcript : (call.transcript || 'Transcript not available'),
        recording_url: useMockData ? call.recording_url : call.recording_url,
        patient_match_info: useMockData ? null : patientInfo
      };
    }));

    res.json({ calls: transformedCalls });
  } catch (error) {
    console.error('Error searching calls:', error);
    const mockCalls = generateMockCalls();
    res.json({ calls: mockCalls.map(call => ({ ...call, id: call.call_id })) });
  }
});

// Test patient lookup endpoint
router.post('/test-patient-lookup', async (req, res) => {
  try {
    const { transcript, summary, callerNumber, callerName } = req.body;
    
    if (!transcript && !summary && !callerName) {
      return res.status(400).json({ 
        error: 'Must provide at least one of: transcript, summary, or callerName' 
      });
    }

    // Test name extraction
    const extractedName = callerName || await extractCallerNameAdvanced(
      transcript, 
      summary, 
      callerNumber || 'Unknown'
    );

    // Test patient status determination
    const patientInfo = await determinePatientStatus(req, extractedName, callerNumber);

    res.json({
      success: true,
      extractedName,
      patientInfo,
      tests: {
        basicExtraction: extractCallerNameBasic(transcript || '', callerNumber || 'Unknown'),
        summaryExtraction: extractNameFromSummary(summary),
        advancedExtraction: extractNameAdvanced(transcript, summary)
      }
    });

  } catch (error) {
    console.error('Error in patient lookup test:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      extractedName: null,
      patientInfo: null
    });
  }
});

// Get patient suggestions for a given input
router.get('/patient-suggestions/:query', async (req, res) => {
  try {
    const { query } = req.params;
    
    if (!query || query.length < 2) {
      return res.json({ suggestions: [] });
    }

    const patients = await odAccess.searchPatients(req, query);

    res.json({
      suggestions: patients.map(patient => ({
        id: patient.id,
        name: patient.fullName,
        phone: patient.phone,
        email: patient.email,
        lastVisit: patient.lastVisit,
        isActive: patient.isActive
      }))
    });

  } catch (error) {
    console.error('Error getting patient suggestions:', error);
    res.json({ suggestions: [] });
  }
});

module.exports = router; 