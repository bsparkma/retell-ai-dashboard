const express = require('express');
const router = express.Router();
const retellService = require('../config/retell');

// Mock data generator for fallback
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
    summary: 'Patient called to schedule a routine checkup appointment.'
  },
  {
    call_id: '2',
    caller_name: 'Sarah Johnson',
    caller_number: '+0987654321',
    call_date: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    reason: 'Prescription refill',
    duration: 120,
    success_status: 'Resolved',
    sentiment: 'neutral',
    is_new_patient: false,
    is_emergency: false,
    summary: 'Patient requested prescription refill for ongoing medication.'
  },
  {
    call_id: '3',
    caller_name: 'Emergency Call',
    caller_number: '+1122334455',
    call_date: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    reason: 'Medical emergency',
    duration: 300,
    success_status: 'Resolved',
    sentiment: 'negative',
    is_new_patient: false,
    is_emergency: true,
    summary: 'Emergency call regarding chest pain, directed to emergency services.'
  },
  {
    call_id: '4',
    caller_name: 'Mike Davis',
    caller_number: '+5566778899',
    call_date: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    reason: 'Lab results inquiry',
    duration: 90,
    success_status: 'Resolved',
    sentiment: 'positive',
    is_new_patient: false,
    is_emergency: false,
    summary: 'Patient called to inquire about recent lab test results.'
  },
  {
    call_id: '5',
    caller_name: 'Lisa Brown',
    caller_number: '+2233445566',
    call_date: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    reason: 'Insurance verification',
    duration: 240,
    success_status: 'Unresolved',
    sentiment: 'neutral',
    is_new_patient: true,
    is_emergency: false,
    summary: 'Patient called to verify insurance coverage for upcoming procedure.'
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
      end_time
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
    const transformedCalls = calls.map(call => ({
      ...call,
      call_id: call.call_id || call.id,
      caller_name: useMockData ? call.caller_name : (call.from_number || 'Unknown'),
      caller_number: useMockData ? call.caller_number : call.from_number,
      call_date: useMockData ? call.call_date : call.start_timestamp,
      reason: useMockData ? call.reason : (call.call_summary || 'Not available'),
      duration: useMockData ? call.duration : (call.end_timestamp && call.start_timestamp ? 
        Math.round((new Date(call.end_timestamp) - new Date(call.start_timestamp)) / 1000) : 0),
      success_status: useMockData ? call.success_status : (call.call_status === 'completed' ? 'Resolved' : 'Unresolved'),
      sentiment: useMockData ? call.sentiment : (call.sentiment || 'neutral'),
      is_new_patient: useMockData ? call.is_new_patient : (call.metadata?.is_new_patient || false),
      is_emergency: useMockData ? call.is_emergency : (call.metadata?.is_emergency || false),
      summary: useMockData ? call.summary : (call.call_analysis?.call_summary || 'No summary available')
    }));

    res.json({
      calls: transformedCalls,
      total: transformedCalls.length,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        has_more: transformedCalls.length === parseInt(limit)
      },
      source: useMockData ? 'mock' : 'api'
    });
  } catch (error) {
    console.error('Error in calls route:', error);
    // Final fallback to mock data
    const mockCalls = generateMockCalls();
    res.json({
      calls: mockCalls,
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
    
    const transformedCall = {
      ...call,
      call_id: call.call_id || call.id,
      caller_name: useMockData ? call.caller_name : (call.from_number || 'Unknown'),
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
      transcript: useMockData ? 'Mock transcript for demonstration purposes.' : (call.transcript || 'Transcript not available'),
      recording_url: useMockData ? null : call.recording_url
    };

    res.json(transformedCall);
  } catch (error) {
    console.error('Error fetching call:', error);
    const mockCalls = generateMockCalls();
    const mockCall = mockCalls[0];
    res.json({
      ...mockCall,
      transcript: 'Mock transcript for demonstration purposes.',
      recording_url: null
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
      transcript = {
        transcript: 'Mock transcript for demonstration purposes. This would contain the actual conversation transcription.',
        transcript_object: [
          { role: 'agent', content: 'Hello, how can I help you today?' },
          { role: 'user', content: 'I need to schedule an appointment.' },
          { role: 'agent', content: 'I\'d be happy to help you schedule an appointment.' }
        ]
      };
    }

    res.json(transcript);
  } catch (error) {
    console.error('Error fetching transcript:', error);
    res.json({
      transcript: 'Mock transcript for demonstration purposes.',
      transcript_object: []
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
      console.log('Retell API not available, no recording available');
      recording = { recording_url: null };
    }

    res.json(recording);
  } catch (error) {
    console.error('Error fetching recording:', error);
    res.json({ recording_url: null });
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
          [call.caller_name, call.caller_number, call.reason, call.summary] :
          [call.from_number, call.call_summary];
        
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

    const transformedCalls = filteredCalls.map(call => ({
      ...call,
      call_id: call.call_id || call.id,
      caller_name: useMockData ? call.caller_name : (call.from_number || 'Unknown'),
      caller_number: useMockData ? call.caller_number : call.from_number,
      call_date: useMockData ? call.call_date : call.start_timestamp,
      reason: useMockData ? call.reason : (call.call_summary || 'Not available'),
      duration: useMockData ? call.duration : (call.end_timestamp && call.start_timestamp ? 
        Math.round((new Date(call.end_timestamp) - new Date(call.start_timestamp)) / 1000) : 0),
      success_status: useMockData ? call.success_status : (call.call_status === 'completed' ? 'Resolved' : 'Unresolved'),
      sentiment: useMockData ? call.sentiment : (call.sentiment || 'neutral'),
      is_new_patient: useMockData ? call.is_new_patient : (call.metadata?.is_new_patient || false),
      is_emergency: useMockData ? call.is_emergency : (call.metadata?.is_emergency || false),
      summary: useMockData ? call.summary : (call.call_analysis?.call_summary || 'No summary available')
    }));

    res.json({ calls: transformedCalls });
  } catch (error) {
    console.error('Error searching calls:', error);
    res.json({ calls: generateMockCalls() });
  }
});

module.exports = router; 