// Frontend office configuration
// This manages office selection and agent filtering preferences

export const officeConfigs = [
  {
    id: 'default',
    name: 'All Offices',
    description: 'View calls from all agents',
    allowedAgents: [] // Empty array means show all agents
  },
  {
    id: 'office_main',
    name: 'Main Office',
    description: 'Primary office location',
    allowedAgents: ['1', '2'] // Medical Receptionist and Emergency Triage
  },
  {
    id: 'office_downtown',
    name: 'Downtown Office', 
    description: 'Downtown branch office',
    allowedAgents: ['1', '3'] // Medical Receptionist and Billing Support
  },
  {
    id: 'office_north',
    name: 'North Branch',
    description: 'North side location',
    allowedAgents: ['2', '4'] // Emergency Triage and Appointment Scheduler
  }
];

export const getOfficeConfig = (officeId) => {
  return officeConfigs.find(config => config.id === officeId) || officeConfigs[0];
};

export const getAllOfficeConfigs = () => {
  return officeConfigs;
};