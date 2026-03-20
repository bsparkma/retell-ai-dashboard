# Office-Specific Agent Deployment Guide

**Configure agent visibility for different office deployments**

## 🎯 Overview

This guide shows how to deploy the dashboard for different offices with customized agent visibility. Each office deployment can be configured to only show specific agents relevant to that office.

## 🏢 Office Configuration System

### Current Setup

The system supports multiple office configurations with different agent visibility:

- **All Offices** - Shows all available agents (default)
- **Main Office** - Medical Receptionist, Emergency Triage
- **Downtown Office** - Medical Receptionist, Billing Support  
- **North Branch** - Emergency Triage, Appointment Scheduler

## 📝 Configuration Files

### 1. Backend Configuration: `backend/config/officeAgents.js`

```javascript
const officeAgentConfig = {
  // Default - shows all agents
  default: {
    allowedAgents: [], // Empty = show all
    officeId: 'default',
    officeName: 'All Offices'
  },
  
  // Main office configuration
  office_main: {
    allowedAgents: ['1', '2'], // Only agents 1 and 2
    officeId: 'office_main',
    officeName: 'Main Office'
  },
  
  // Add more office configurations as needed
  office_pediatrics: {
    allowedAgents: ['1', '5'], // Custom agent set
    officeId: 'office_pediatrics',
    officeName: 'Pediatrics Office'
  }
};
```

### 2. Frontend Configuration: `frontend/src/config/officeConfig.js`

```javascript
export const officeConfigs = [
  {
    id: 'default',
    name: 'All Offices',
    description: 'View calls from all agents',
    allowedAgents: [] // Empty = show all
  },
  {
    id: 'office_main',
    name: 'Main Office', 
    description: 'Primary office location',
    allowedAgents: ['1', '2'] // Must match backend
  }
];
```

## 🚀 Deployment Methods

### Method 1: Single Deployment with Office Selector

**Best for:** Multiple offices sharing one server

1. **Deploy normally** with all office configurations
2. **Users select** their office from the dropdown
3. **Agent visibility** changes based on selection

```bash
# Standard deployment (current setup)
cd frontend
npm run build
# Deploy to server
```

### Method 2: Office-Specific Deployments  

**Best for:** Separate deployments per office

#### Step 1: Create Office-Specific Config

```bash
# Create configs for Downtown Office deployment
echo 'export const DEFAULT_OFFICE_ID = "office_downtown";' > frontend/src/config/deployment.js

# Update officeConfig.js to set default
```

#### Step 2: Modify Frontend for Single Office

```javascript
// In frontend/src/pages/Dashboard.js
import { DEFAULT_OFFICE_ID } from '../config/deployment';

// Set default office (hide selector if desired)
const [officeId, setOfficeId] = useState(DEFAULT_OFFICE_ID || 'default');
```

#### Step 3: Deploy Per Office

```bash
# For Downtown Office
export REACT_APP_DEFAULT_OFFICE="office_downtown"
npm run build
# Deploy to downtown-dashboard.yoursite.com

# For Main Office  
export REACT_APP_DEFAULT_OFFICE="office_main"
npm run build
# Deploy to main-dashboard.yoursite.com
```

## 🔧 Customization Examples

### Example 1: Pediatrics Office

Only show pediatric-specific agents:

```javascript
// Backend: backend/config/officeAgents.js
office_pediatrics: {
  allowedAgents: ['6', '7'], // Pediatric Nurse, Child Specialist
  officeId: 'office_pediatrics',
  officeName: 'Pediatrics Department'
}

// Frontend: frontend/src/config/officeConfig.js
{
  id: 'office_pediatrics',
  name: 'Pediatrics Department',
  description: 'Child-focused medical care',
  allowedAgents: ['6', '7']
}
```

### Example 2: Emergency Department

Only emergency-related agents:

```javascript
office_emergency: {
  allowedAgents: ['2', '8', '9'], // Emergency Triage, Trauma Coordinator, Critical Care
  officeId: 'office_emergency', 
  officeName: 'Emergency Department'
}
```

### Example 3: Completely Hide Office Selector

For single-office deployments:

```javascript
// In Dashboard.js - remove office selector entirely
// Comment out or remove this section:
/*
<FormControl size="small" sx={{ minWidth: 150 }}>
  <InputLabel>Office</InputLabel>
  <Select value={officeId} ...>
*/
```

## 📊 Agent Management

### Current Agent IDs

Based on your Retell AI setup:

- **Agent 1**: Medical Receptionist
- **Agent 2**: Emergency Triage  
- **Agent 3**: Billing Support
- **Agent 4**: Appointment Scheduler

### Adding New Agents

1. **Get agent ID** from Retell AI dashboard
2. **Add to both configs** (backend + frontend)
3. **Assign to offices** as needed

```javascript
// Add new agent to configuration
office_cardiology: {
  allowedAgents: ['1', '10'], // Receptionist + Cardiology Specialist
  officeId: 'office_cardiology',
  officeName: 'Cardiology Department'
}
```

## 🔄 Deployment Commands

### Production Update (Current Setup)

```bash
# Update configuration files
scp frontend/src/config/officeConfig.js root@159.89.82.167:/root/retell-ai-dashboard/frontend/src/config/
scp backend/config/officeAgents.js root@159.89.82.167:/root/retell-ai-dashboard/backend/config/

# Rebuild and restart
cd frontend
npm run build
scp -r build/* root@159.89.82.167:/root/retell-ai-dashboard/frontend/build/
ssh root@159.89.82.167 "pm2 restart retell-backend"
```

### New Office Deployment

```bash
# Clone for new office
git clone https://github.com/bsparkma/retell-ai-dashboard.git pediatrics-dashboard
cd pediatrics-dashboard

# Configure for specific office
# Edit configs to default to office_pediatrics
# Deploy to separate server or subdomain
```

## 🎯 Features Per Office

### Dashboard Features
- ✅ **Office-specific call filtering**
- ✅ **Agent dropdown shows only allowed agents**
- ✅ **Call history filtered by office agents**
- ✅ **Agent column shows relevant agents only**

### Agents Page Features  
- ✅ **Shows only office-allowed agents**
- ✅ **Office selector in header**
- ✅ **Agent management limited to relevant agents**
- ✅ **Usage statistics for office agents only**

## 📈 Benefits

### For Multi-Office Practices
- **Focused view** - Staff only see relevant agents
- **Reduced confusion** - No unnecessary agent options
- **Better organization** - Clear office separation
- **Consistent branding** - Each office can have custom deployment

### For Single-Office Practices
- **Simplified interface** - Remove office selector entirely
- **Streamlined workflow** - Direct access to relevant agents
- **Custom domain** - office-specific URLs
- **Tailored experience** - Perfect fit for specific needs

## 🚀 Next Steps

1. **Choose deployment method** based on your needs
2. **Configure office agents** in both backend and frontend
3. **Test locally** with different office selections
4. **Deploy to production** using preferred method
5. **Train staff** on office-specific features

## 📞 Support

For questions about office-specific deployments:
- Update configuration files as shown above
- Test with different `officeId` values
- Check agent filtering in both Dashboard and Agents pages
- Verify API responses include `office_config` data

**Production Server**: http://159.89.82.167/
**Configuration Files**: Backend + Frontend configs must match
**Agent IDs**: Must match Retell AI dashboard exactly