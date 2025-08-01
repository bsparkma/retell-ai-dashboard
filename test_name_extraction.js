#!/usr/bin/env node

// Test script for name extraction functionality
// Run with: node test_name_extraction.js

// Mock OpenDental service for testing
const mockOpenDentalService = {
  async searchPatients(query) {
    // Mock patient database
    const mockPatients = [
      { id: 1, fullName: 'John Smith', phone: '1234567890' },
      { id: 2, fullName: 'Sarah Johnson', phone: '0987654321' },
      { id: 3, fullName: 'Mike Williams', phone: '1122334455' }
    ];
    
    return mockPatients.filter(p => 
      p.fullName.toLowerCase().includes(query.toLowerCase()) ||
      p.phone.includes(query.replace(/\D/g, ''))
    );
  },

  async verifyPatientAppointments(patientId) {
    return {
      hasUpcoming: Math.random() > 0.5,
      recentAppointments: [{ id: 1, date: '2024-01-15' }],
      upcomingAppointments: []
    };
  }
};

// Import the extraction functions (simplified for testing)
const extractCallerNameBasic = (transcript, callerNumber) => {
  if (!transcript) return callerNumber;
  
  const agentNames = ['karen', 'assistant', 'agent', 'bot', 'ai', 'system', 'operator'];
  
  const callerPatterns = [
    /(?:user|caller):\s*.*?(?:my name is|i'm|this is|i am)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?:user|caller):\s*.*?(?:call me|it's|name's)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?:user|caller):\s*(?:hi|hello),?\s*(?:my name is|i'm|this is)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?<!agent:.*?)(?:my name is|i'm|this is|i am)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?:user|caller):\s*(?:hi|hello),?\s*([a-zA-Z]+(?:\s+[a-zA-Z]+)?)\s+(?:here|speaking|calling)/i,
    /(?:user|caller):\s*(?:this is|it's)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i
  ];
  
  for (const pattern of callerPatterns) {
    const match = transcript.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim().toLowerCase();
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

const extractNameFromSummary = (summary) => {
  if (!summary) return null;

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
      const commonWords = ['Patient', 'Caller', 'Person', 'User', 'Someone', 'Individual'];
      if (!commonWords.includes(name)) {
        return name;
      }
    }
  }

  return null;
};

const extractNameAdvanced = (transcript, summary) => {
  if (!transcript && !summary) return null;

  const fullText = `${transcript || ''} ${summary || ''}`;
  
  const advancedPatterns = [
    /(?:agent|assistant):\s*.*?(?:thank you|hello|hi),?\s+([A-Z][a-zA-Z]+)/i,
    /(?:agent|assistant):\s*.*?I(?:'ll|'d)\s+(?:be happy to\s+)?help\s+you,?\s+([A-Z][a-zA-Z]+)/i,
    /(?:appointment|booking|schedule).*?for\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
    /(?:prescription|medication|refill).*for\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
    /(?:patient|caller)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:needs|wants|requires|is)/i
  ];

  for (const pattern of advancedPatterns) {
    const match = fullText.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      if (name.length > 1 && !/^\d/.test(name)) {
        return name;
      }
    }
  }

  return null;
};

const determinePatientStatus = async (callerName, callerNumber) => {
  try {
    let patients = [];
    
    if (callerNumber && callerNumber !== 'Unknown') {
      const cleanPhone = callerNumber.replace(/\D/g, '');
      if (cleanPhone.length >= 10) {
        patients = await mockOpenDentalService.searchPatients(cleanPhone);
      }
    }

    if (patients.length === 0 && callerName && callerName !== callerNumber) {
      patients = await mockOpenDentalService.searchPatients(callerName);
    }

    if (patients.length > 0) {
      const patient = patients[0];
      const appointmentHistory = await mockOpenDentalService.verifyPatientAppointments(patient.id);
      
      return {
        isNewPatient: false,
        patientId: patient.id,
        patientName: patient.fullName,
        hasAppointmentHistory: appointmentHistory.recentAppointments.length > 0 || appointmentHistory.hasUpcoming,
        matchedBy: callerNumber && callerNumber !== 'Unknown' ? 'phone' : 'name'
      };
    }

    return {
      isNewPatient: true,
      patientId: null,
      patientName: callerName,
      hasAppointmentHistory: false,
      matchedBy: null
    };

  } catch (error) {
    console.error('Error determining patient status:', error);
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

// Test cases
const testCases = [
  {
    name: "Basic name introduction",
    transcript: "Agent: Hello, how can I help? User: Hi, my name is John Smith, I need an appointment.",
    summary: "Patient called to schedule appointment.",
    callerNumber: "+1234567890"
  },
  {
    name: "Phone greeting pattern",
    transcript: "Agent: Good morning. User: This is Sarah Johnson calling.",
    summary: "Caller inquired about services.",
    callerNumber: "+0987654321"
  },
  {
    name: "Agent addressing caller",
    transcript: "Agent: I'll be happy to help you, Mike. User: Thank you.",
    summary: "Patient requested prescription refill.",
    callerNumber: "+1122334455"
  },
  {
    name: "Summary-based extraction",
    transcript: "Agent: How can I help? User: I need help with something.",
    summary: "Patient Lisa Brown called regarding insurance verification.",
    callerNumber: "+2233445566"
  },
  {
    name: "No name available",
    transcript: "Agent: Hello. User: Yeah, I need to make an appointment.",
    summary: "Caller inquired about appointment availability.",
    callerNumber: "+5555551234"
  },
  {
    name: "Medical context pattern",
    transcript: "Agent: What can I do for you? User: I need a prescription refill.",
    summary: "Prescription refill request for patient David Wilson.",
    callerNumber: "+6666667890"
  }
];

async function runTests() {
  console.log("🧪 Testing Enhanced Name Extraction System\n");
  console.log("=" * 60);
  
  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    console.log(`\nTest ${i + 1}: ${testCase.name}`);
    console.log("-".repeat(40));
    console.log(`Transcript: ${testCase.transcript}`);
    console.log(`Summary: ${testCase.summary}`);
    console.log(`Phone: ${testCase.callerNumber}`);
    
    // Run extraction methods
    const basicName = extractCallerNameBasic(testCase.transcript, testCase.callerNumber);
    const summaryName = extractNameFromSummary(testCase.summary);
    const advancedName = extractNameAdvanced(testCase.transcript, testCase.summary);
    
    // Determine best extracted name
    let finalName = basicName;
    if (finalName === testCase.callerNumber && summaryName) {
      finalName = summaryName;
    }
    if (finalName === testCase.callerNumber && advancedName) {
      finalName = advancedName;
    }
    
    // Get patient status
    const patientInfo = await determinePatientStatus(finalName, testCase.callerNumber);
    
    console.log("\n📊 Results:");
    console.log(`  Basic Extraction: ${basicName}`);
    console.log(`  Summary Extraction: ${summaryName || 'None'}`);
    console.log(`  Advanced Extraction: ${advancedName || 'None'}`);
    console.log(`  Final Name: ${finalName}`);
    console.log(`  Patient Status: ${patientInfo.isNewPatient ? 'New Patient' : 'Existing Patient'}`);
    if (patientInfo.matchedBy) {
      console.log(`  Matched By: ${patientInfo.matchedBy}`);
      console.log(`  Patient ID: ${patientInfo.patientId}`);
    }
    
    console.log("=" * 40);
  }
  
  console.log("\n✅ Testing completed!");
  console.log("\n📝 Summary:");
  console.log("- Multiple extraction methods provide better coverage");
  console.log("- OpenDental integration enables automatic patient classification");
  console.log("- Fallback mechanisms ensure robustness");
  console.log("- Visual indicators in UI show extraction confidence");
}

// Run the tests
runTests().catch(console.error); 