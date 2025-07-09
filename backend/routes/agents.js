const express = require('express');
const router = express.Router();
const retellService = require('../config/retell');

// Get all agents
router.get('/', async (req, res) => {
  try {
    const agents = await retellService.getAgents();
    res.json(agents);
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json({ 
      message: 'Failed to fetch agents', 
      error: error.message 
    });
  }
});

// Get specific agent
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const agent = await retellService.getAgent(id);
    res.json(agent);
  } catch (error) {
    console.error('Error fetching agent:', error);
    res.status(500).json({ 
      message: 'Failed to fetch agent details', 
      error: error.message 
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
      'language'
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
    
    const updatedAgent = await retellService.updateAgent(id, filteredData);
    res.json(updatedAgent);
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
    const phoneNumbers = await retellService.getPhoneNumbers();
    const { id } = req.params;
    
    // Filter phone numbers for this agent
    const agentPhoneNumbers = phoneNumbers.filter(pn => pn.agent_id === id);
    
    res.json(agentPhoneNumbers);
  } catch (error) {
    console.error('Error fetching agent phone numbers:', error);
    res.status(500).json({ 
      message: 'Failed to fetch agent phone numbers', 
      error: error.message 
    });
  }
});

module.exports = router; 