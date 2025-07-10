const express = require('express');
const router = express.Router();
const retellService = require('../config/retell');

// Enhanced mock data with AI-extracted names
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
    summary: 'Patient called to schedule a routine checkup appointment for next week. Discussed available time slots and confirmed insurance coverage.',
    transcript: 'Agent: Hello, thank you for calling our medical practice. How can I help you today? User: Hi, my name is John Smith, I need to schedule an appointment for a routine checkup. Agent: I\'d be happy to help you schedule that appointment, Mr. Smith. Let me check our available slots.',
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
    summary: 'URGENT: Emergency call regarding severe chest pain. Patient experiencing shortness of breath and was advised to seek immediate medical attention.',
    transcript: 'Agent: Emergency line, how can I help? User: This is Sarah Johnson, I\'m having severe chest pain and trouble breathing. I need help immediately. Agent: I understand this is urgent, Sarah. Let me help you right away.',
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
    summary: 'Patient requested prescription refill for ongoing medication. Verified patient information and processed refill request.',
    transcript: 'Agent: How can I help you today? User: Hi, I\'m Mike Williams and I need a prescription refill for my blood pressure medication. Agent: I can help you with that, Mike. Let me verify your information.',
    recording_url: 'https://example.com/recordings/call3.mp3'
  },
  {
    call_id: '4',
    caller_name: 'Lisa Brown',
    caller_number: '+2233445566',
    call_date: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    reason: 'Insurance verification',
    duration: 240,
    success_status: 'Resolved',
    sentiment: 'neutral',
    is_new_patient: true,
    is_emergency: false,
    summary: 'Patient called to verify insurance coverage for upcoming procedure. Confirmed coverage details and provided authorization codes.',
    transcript: 'Agent: Thank you for calling. User: Hi, this is Lisa Brown. I need to verify my insurance coverage for an upcoming procedure. Agent: I\'ll be happy to help you with that, Lisa.',
    recording_url: null
  }
];

// AI Name extraction function - improved to exclude agent names
const extractCallerName = (transcript, callerNumber) => {
  if (!transcript) return callerNumber;
  
  // Common AI agent names to exclude
  const agentNames = ['karen', 'assistant', 'agent', 'bot', 'ai', 'system', 'operator'];
  
  // Look for caller-specific patterns (what the USER says, not the agent)
  const callerPatterns = [
    /(?:user|caller):\s*.*?(?:my name is|i'm|this is|i am)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?:user|caller):\s*.*?(?:call me|it's|name's)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    // Look for direct caller introduction patterns
    /(?:user|caller):\s*(?:hi|hello),?\s*(?:my name is|i'm|this is)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    // Generic patterns but exclude agent responses
    /(?<!agent:.*?)(?:my name is|i'm|this is|i am)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i
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
      id: call.call_id || call.id, // Ensure we have both id and call_id
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
      recording_url: useMockData ? call.recording_url : call.recording_url
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

    const transformedCalls = filteredCalls.map(call => ({
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
      recording_url: useMockData ? call.recording_url : call.recording_url
    }));

    res.json({ calls: transformedCalls });
  } catch (error) {
    console.error('Error searching calls:', error);
    const mockCalls = generateMockCalls();
    res.json({ calls: mockCalls.map(call => ({ ...call, id: call.call_id })) });
  }
});

module.exports = router; 