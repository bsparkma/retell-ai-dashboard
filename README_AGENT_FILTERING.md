# Agent Filtering Feature

## Overview
The dashboard now supports filtering calls by specific agents, allowing you to limit the call history to only show calls from agents relevant to your office.

## Features Added

### 1. Office Configuration
- Created `backend/config/officeAgents.js` to manage which agents are visible for each office
- Supports multiple office configurations with different agent sets
- Default configuration shows all agents

### 2. Backend Updates
- Updated `/api/calls` endpoint to support `office_id` parameter
- Added agent filtering functionality in `filterCallsForOffice()`
- Included `agent_id` in call data transformation
- Added office configuration response in API

### 3. Frontend Updates
- Added agent filter dropdown to Dashboard
- Added office selector to control which agents are available
- Added agent column to the call history table
- Added agent filter chip display

## Configuration

### Setting up Office Agents
Edit `backend/config/officeAgents.js`:

```javascript
const officeAgentConfig = {
  office_main: {
    allowedAgents: ['1', '2'], // Only show Medical Receptionist and Emergency Triage
    officeId: 'office_main',
    officeName: 'Main Office'
  },
  // Add more office configurations as needed
};
```

### Customizing Office Options
Edit `frontend/src/config/officeConfig.js` to add or modify office selections.

## Usage

1. **Select Office**: Use the office dropdown in the top-right of the call history section
2. **Filter by Agent**: Use the agent filter dropdown in the filter bar
3. **Clear Filters**: Click the "Clear" button to reset all filters

## API Changes

### New Parameters
- `GET /api/calls?office_id=office_main` - Filter calls by office configuration

### Response Changes
- Added `office_config` in API response when office_id is provided
- Included `agent_id` field in call data

## Files Modified

### Backend
- `backend/routes/calls.js` - Added office filtering and agent_id support
- `backend/config/officeAgents.js` - New configuration file

### Frontend  
- `frontend/src/pages/Dashboard.js` - Added agent filtering UI and logic
- `frontend/src/config/officeConfig.js` - New office configuration

## Benefits

1. **Office-specific Views**: Each office only sees relevant agents
2. **Improved Performance**: Fewer calls to display and process
3. **Better Organization**: Clearer call management for multi-office setups
4. **Flexible Configuration**: Easy to add new offices and modify agent assignments