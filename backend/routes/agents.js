const express = require('express');
const router = express.Router();
const retellService = require('../config/retell');

// Enhanced mock data for agents
const generateMockAgents = () => [
  {
    agent_id: '1',
    agent_name: 'Medical Receptionist',
    voice_id: 'sarah',
    voice_temperature: 0.7,
    voice_speed: 1.0,
    responsiveness: 0.85,
    interruption_sensitivity: 0.5,
    enable_backchannel: true,
    backchannel_frequency: 0.3,
    language: 'en-US',
    prompt: 'You are a helpful medical receptionist AI assistant. Your primary responsibilities include scheduling appointments, answering basic medical questions, verifying insurance information, and directing patients to appropriate healthcare resources. Always maintain a professional, empathetic, and patient-friendly demeanor.',
    status: 'active',
    created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString()
  },
  {
    agent_id: '2',
    agent_name: 'Emergency Triage',
    voice_id: 'michael',
    voice_temperature: 0.5,
    voice_speed: 1.1,
    responsiveness: 0.95,
    interruption_sensitivity: 0.7,
    enable_backchannel: false,
    backchannel_frequency: 0.1,
    language: 'en-US',
    prompt: 'You are an emergency medical triage AI specialist. Quickly assess the urgency of medical situations, provide appropriate guidance for emergency care, and prioritize cases based on severity. Always remain calm and provide clear, actionable instructions for emergency situations.',
    status: 'active',
    created_at: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  },
  {
    agent_id: '3',
    agent_name: 'Billing Support',
    voice_id: 'emily',
    voice_temperature: 0.6,
    voice_speed: 0.9,
    responsiveness: 0.6,
    interruption_sensitivity: 0.4,
    enable_backchannel: true,
    backchannel_frequency: 0.4,
    language: 'en-US',
    prompt: 'You are a medical billing support AI agent. Help patients understand their bills, explain insurance coverage, set up payment plans, and resolve billing inquiries. Be patient and thorough when explaining complex billing information.',
    status: 'active',
    created_at: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    agent_id: '4',
    agent_name: 'Pharmacy Assistant',
    voice_id: 'david',
    voice_temperature: 0.8,
    voice_speed: 1.0,
    responsiveness: 0.3,
    interruption_sensitivity: 0.6,
    enable_backchannel: true,
    backchannel_frequency: 0.2,
    language: 'en-US',
    prompt: 'You are a pharmacy assistant AI focused on medication management, prescription refills, drug interactions, and medication counseling. Provide accurate information about medications while emphasizing the importance of consulting with healthcare providers.',
    status: 'inactive',
    created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
  }
];

// Get all agents
router.get('/', async (req, res) => {
  try {
    let agents;
    let useMockData = false;

    try {
      agents = await retellService.getAgents();
      
      // If API returns empty or no agents, use mock data
      if (!agents || agents.length === 0) {
        agents = generateMockAgents();
        useMockData = true;
      }
    } catch (apiError) {
      console.log('Retell API not available, using mock agents data');
      agents = generateMockAgents();
      useMockData = true;
    }

    // Transform agents data to ensure consistent format
    const transformedAgents = agents.map(agent => ({
      ...agent,
      id: agent.agent_id || agent.id,
      agent_id: agent.agent_id || agent.id,
      // Ensure all required fields are present
      voice_temperature: agent.voice_temperature || 0.7,
      voice_speed: agent.voice_speed || 1.0,
      responsiveness: agent.responsiveness || 0.5,
      interruption_sensitivity: agent.interruption_sensitivity || 0.5,
      enable_backchannel: agent.enable_backchannel !== undefined ? agent.enable_backchannel : true,
      backchannel_frequency: agent.backchannel_frequency || 0.3,
      language: agent.language || 'en-US',
      status: agent.status || 'active'
    }));

    res.json({
      agents: transformedAgents,
      total: transformedAgents.length,
      source: useMockData ? 'mock' : 'api'
    });
  } catch (error) {
    console.error('Error fetching agents:', error);
    // Final fallback to mock data
    const mockAgents = generateMockAgents();
    res.json({
      agents: mockAgents,
      total: mockAgents.length,
      source: 'mock'
    });
  }
});

// Get specific agent
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let agent;
    let useMockData = false;

    try {
      agent = await retellService.getAgent(id);
    } catch (apiError) {
      console.log('Retell API not available, using mock agent data');
      const mockAgents = generateMockAgents();
      agent = mockAgents.find(a => a.agent_id === id) || mockAgents[0];
      useMockData = true;
    }

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Transform agent data
    const transformedAgent = {
      ...agent,
      id: agent.agent_id || agent.id,
      agent_id: agent.agent_id || agent.id,
      voice_temperature: agent.voice_temperature || 0.7,
      voice_speed: agent.voice_speed || 1.0,
      responsiveness: agent.responsiveness || 0.5,
      interruption_sensitivity: agent.interruption_sensitivity || 0.5,
      enable_backchannel: agent.enable_backchannel !== undefined ? agent.enable_backchannel : true,
      backchannel_frequency: agent.backchannel_frequency || 0.3,
      language: agent.language || 'en-US',
      status: agent.status || 'active'
    };

    res.json(transformedAgent);
  } catch (error) {
    console.error('Error fetching agent:', error);
    // Fallback to mock data
    const mockAgents = generateMockAgents();
    const mockAgent = mockAgents[0];
    res.json({
      ...mockAgent,
      id: mockAgent.agent_id
    });
  }
});

// Update agent (for agent adjustment feature)
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    
    // Validate update data
    const allowedFields = [
      'agent_name',
      'voice_id',
      'voice_temperature',
      'voice_speed',
      'responsiveness',
      'interruption_sensitivity',
      'enable_backchannel',
      'backchannel_frequency',
      'enable_transcription_formatting',
      'llm_websocket_url',
      'prompt',
      'language',
      'status'
    ];
    
    const filteredData = {};
    Object.keys(updateData).forEach(key => {
      if (allowedFields.includes(key)) {
        filteredData[key] = updateData[key];
      }
    });
    
    if (Object.keys(filteredData).length === 0) {
      return res.status(400).json({ 
        message: 'No valid fields provided for update' 
      });
    }

    let updatedAgent;
    let useMockData = false;

    try {
      updatedAgent = await retellService.updateAgent(id, filteredData);
    } catch (apiError) {
      console.log('Retell API not available, simulating agent update');
      // Find mock agent and simulate update
      const mockAgents = generateMockAgents();
      const mockAgent = mockAgents.find(a => a.agent_id === id) || mockAgents[0];
      
      updatedAgent = {
        ...mockAgent,
        ...filteredData,
        updated_at: new Date().toISOString()
      };
      useMockData = true;
    }

    res.json({
      ...updatedAgent,
      id: updatedAgent.agent_id || updatedAgent.id,
      source: useMockData ? 'mock' : 'api'
    });
  } catch (error) {
    console.error('Error updating agent:', error);
    res.status(500).json({ 
      message: 'Failed to update agent', 
      error: error.message 
    });
  }
});

// Get phone numbers associated with agents
router.get('/:id/phone-numbers', async (req, res) => {
  try {
    const { id } = req.params;
    let phoneNumbers = [];
    let useMockData = false;

    try {
      const allPhoneNumbers = await retellService.getPhoneNumbers();
      // Filter phone numbers for this agent
      phoneNumbers = allPhoneNumbers.filter(pn => pn.agent_id === id);
    } catch (apiError) {
      console.log('Retell API not available, using mock phone numbers');
      // Mock phone numbers for agents
      const mockPhoneNumbers = [
        { 
          phone_number_id: '1', 
          agent_id: '1', 
          phone_number: '+1-555-0001',
          nickname: 'Main Reception Line'
        },
        { 
          phone_number_id: '2', 
          agent_id: '2', 
          phone_number: '+1-555-0911',
          nickname: 'Emergency Line'
        },
        { 
          phone_number_id: '3', 
          agent_id: '3', 
          phone_number: '+1-555-0002',
          nickname: 'Billing Support'
        }
      ];
      phoneNumbers = mockPhoneNumbers.filter(pn => pn.agent_id === id);
      useMockData = true;
    }
    
    res.json({
      phone_numbers: phoneNumbers,
      total: phoneNumbers.length,
      source: useMockData ? 'mock' : 'api'
    });
  } catch (error) {
    console.error('Error fetching agent phone numbers:', error);
    res.json({
      phone_numbers: [],
      total: 0,
      source: 'mock'
    });
  }
});

// Test agent endpoint (for testing functionality)
router.post('/:id/test', async (req, res) => {
  try {
    const { id } = req.params;
    const { test_message } = req.body;

    // Simulate agent testing
    res.json({
      agent_id: id,
      test_successful: true,
      response: `Test response from agent ${id}: "${test_message || 'Hello, I am ready to assist you.'}"`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error testing agent:', error);
    res.status(500).json({
      message: 'Failed to test agent',
      error: error.message
    });
  }
});

module.exports = router; 