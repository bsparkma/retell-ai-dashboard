// Office-specific agent configuration
// This file defines which agents should be visible for each office

const officeAgentConfig = {
  // Default configuration - shows all agents
  default: {
    allowedAgents: [], // Empty array means show all agents
    officeId: 'default',
    officeName: 'All Offices'
  },
  
  // Example office configurations
  // You can customize these based on your actual office setup
  office_main: {
    allowedAgents: ['1', '2'], // Medical Receptionist and Emergency Triage
    officeId: 'office_main',
    officeName: 'Main Office'
  },
  
  office_downtown: {
    allowedAgents: ['1', '3'], // Medical Receptionist and Billing Support
    officeId: 'office_downtown', 
    officeName: 'Downtown Office'
  },
  
  office_north: {
    allowedAgents: ['2', '4'], // Emergency Triage and Appointment Scheduler
    officeId: 'office_north',
    officeName: 'North Branch'
  }
};

// Get configuration for a specific office
const getOfficeConfig = (officeId = 'default') => {
  return officeAgentConfig[officeId] || officeAgentConfig.default;
};

// Get all available office configurations
const getAllOfficeConfigs = () => {
  return Object.values(officeAgentConfig);
};

// Check if an agent is allowed for a specific office
const isAgentAllowedForOffice = (agentId, officeId = 'default') => {
  const config = getOfficeConfig(officeId);
  // If allowedAgents is empty, all agents are allowed
  if (!config.allowedAgents || config.allowedAgents.length === 0) {
    return true;
  }
  return config.allowedAgents.includes(agentId.toString());
};

// Filter agents based on office configuration
const filterAgentsForOffice = (agents, officeId = 'default') => {
  const config = getOfficeConfig(officeId);
  
  // If no specific agents configured, return all
  if (!config.allowedAgents || config.allowedAgents.length === 0) {
    return agents;
  }
  
  // Filter agents based on allowed list
  return agents.filter(agent => 
    config.allowedAgents.includes((agent.agent_id || agent.id).toString())
  );
};

// Filter calls based on office configuration
const filterCallsForOffice = (calls, officeId = 'default') => {
  const config = getOfficeConfig(officeId);
  
  // If no specific agents configured, return all calls
  if (!config.allowedAgents || config.allowedAgents.length === 0) {
    return calls;
  }
  
  // Filter calls based on agent_id
  return calls.filter(call => {
    // If call doesn't have agent_id, include it (for backward compatibility)
    if (!call.agent_id) {
      return true;
    }
    return config.allowedAgents.includes(call.agent_id.toString());
  });
};

module.exports = {
  officeAgentConfig,
  getOfficeConfig,
  getAllOfficeConfigs,
  isAgentAllowedForOffice,
  filterAgentsForOffice,
  filterCallsForOffice
};