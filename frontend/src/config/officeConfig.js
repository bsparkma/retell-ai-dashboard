// Frontend office configuration
// This manages office selection and agent filtering preferences

export const officeConfigs = [
  {
    id: 'default',
    name: 'All Offices',
    description: 'View calls from all agents'
  },
  {
    id: 'office_main',
    name: 'Main Office',
    description: 'Primary office location'
  },
  {
    id: 'office_downtown',
    name: 'Downtown Office', 
    description: 'Downtown branch office'
  },
  {
    id: 'office_north',
    name: 'North Branch',
    description: 'North side location'
  }
];

export const getOfficeConfig = (officeId) => {
  return officeConfigs.find(config => config.id === officeId) || officeConfigs[0];
};

export const getAllOfficeConfigs = () => {
  return officeConfigs;
};