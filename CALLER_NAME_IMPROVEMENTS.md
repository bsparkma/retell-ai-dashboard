# Caller Name Extraction and Patient Identification Improvements

## Overview

The dashboard has been significantly enhanced to better extract caller names from transcripts and summaries, and to automatically determine whether callers are new or existing patients using the OpenDental integration.

## Key Improvements

### 1. Enhanced Name Extraction

#### Multiple Extraction Methods
- **Basic Regex Patterns**: Improved patterns to catch more natural conversation flows
- **Summary Analysis**: AI-style analysis of call summaries to find names
- **Advanced Context Analysis**: Uses conversation context to identify names

#### New Patterns Added
- Phone greeting patterns: `"This is John"`, `"John speaking"`
- Agent addressing patterns: `"Thank you, John"`, `"I'll help you, Sarah"`
- Medical context patterns: `"prescription for Mike"`, `"appointment for Lisa"`

### 2. OpenDental Patient Matching

#### Automatic Patient Lookup
- **Phone Number Matching**: First tries to match by phone number in OpenDental
- **Name Matching**: Falls back to name-based search if phone doesn't match
- **Appointment History Verification**: Confirms patient status by checking appointment history

#### Patient Status Determination
- **New Patient**: No matching record found in OpenDental
- **Existing Patient**: Found in OpenDental with appointment history
- **In System**: Found in OpenDental but no appointments (edge case)

### 3. Enhanced Dashboard Display

#### Improved Caller Column
- **Color-coded Avatars**: Blue for new patients, green for existing patients
- **Name Identification Status**: Shows "Unknown Caller" when only phone number available
- **Match Indicators**: Green checkmark shows how patient was matched (phone/name)
- **Warning Labels**: Indicates when name couldn't be identified

#### Enhanced Patient Type Column
- **Detailed Tooltips**: Shows appointment history information
- **Visual Indicators**: Filled chips for confirmed matches, outlined for unconfirmed
- **Color Coding**: Primary (blue) for new, success (green) for existing

## Technical Implementation

### Backend Changes (`backend/routes/calls.js`)

#### New Functions
```javascript
extractCallerNameAdvanced() // Main orchestration function
extractCallerNameBasic()    // Improved regex patterns
extractNameFromSummary()    // Summary-based extraction
extractNameAdvanced()       // Context-aware extraction
determinePatientStatus()    // OpenDental integration
```

#### New API Endpoints
- `POST /api/calls/test-patient-lookup` - Test name extraction and patient lookup
- `GET /api/calls/patient-suggestions/:query` - Get patient suggestions

### Frontend Changes (`frontend/src/pages/Dashboard.js`)

#### Removed Duplicate Logic
- Removed frontend name extraction (now handled by backend)
- Simplified call processing logic

#### Enhanced UI Components
- Improved caller column with status indicators
- Enhanced patient type column with tooltips
- Added visual feedback for matching confidence

## Testing the Improvements

### 1. Using Mock Data
The system includes enhanced mock data with various scenarios:
- **John Smith**: New patient with clear name identification
- **Sarah Johnson**: Existing patient with emergency call
- **Mike Williams**: Existing patient with prescription refill
- **Lisa Brown**: New patient with insurance inquiry
- **Unknown Caller**: Phone number only, no name identified

### 2. API Testing
Use the test endpoint to experiment with name extraction:

```bash
curl -X POST http://localhost:5000/api/calls/test-patient-lookup \
  -H "Content-Type: application/json" \
  -d '{
    "transcript": "Agent: Hello, how can I help? User: Hi, my name is John Smith, I need an appointment.",
    "summary": "Patient John Smith called to schedule an appointment.",
    "callerNumber": "+1234567890"
  }'
```

### 3. Patient Suggestions
Test patient lookup functionality:

```bash
curl http://localhost:5000/api/calls/patient-suggestions/John
```

## Configuration Requirements

### OpenDental Integration
Ensure these environment variables are set:
```env
OD_API_URL=your_opendental_api_url
OD_API_KEY=your_opendental_api_key
```

### Dependencies
The following OpenDental service methods are used:
- `searchPatients(query)` - Search patients by name/phone
- `verifyPatientAppointments(patientId)` - Check appointment history

## Fallback Behavior

### When OpenDental is Unavailable
- Falls back to basic name extraction
- Defaults to "new patient" status
- Maintains full functionality with reduced intelligence

### When Name Cannot be Extracted
- Shows phone number as display name
- Indicates "Unknown Caller" in UI
- Provides visual warning about missing name

## Future Enhancements

### Potential AI Integration
- Use OpenAI/Claude API for more sophisticated name extraction
- Analyze call sentiment and context for better patient classification
- Implement fuzzy matching for similar-sounding names

### Additional Features
- Manual name correction interface
- Bulk re-processing of historical calls
- Confidence scoring for extracted names
- Integration with other patient management systems

## Monitoring and Debugging

### Logging
The system logs:
- Name extraction attempts and results
- Patient matching success/failure
- OpenDental API calls and responses
- Fallback scenarios

### Debug Information
Each call now includes `patient_match_info` field with:
- `matchedBy`: How the patient was identified ('phone' or 'name')
- `patientId`: OpenDental patient ID if found
- `hasAppointmentHistory`: Boolean indicating appointment history
- `error`: Any errors encountered during lookup

## Performance Considerations

### Caching
Consider implementing caching for:
- Patient search results (short-term)
- Phone number to patient mappings
- Recent name extraction results

### Batch Processing
For high-volume scenarios:
- Process calls in batches
- Use background jobs for patient lookup
- Implement rate limiting for OpenDental API calls

## Summary

These improvements significantly enhance the user experience by:

1. **Better Name Recognition**: Multiple extraction methods catch more names
2. **Automatic Patient Classification**: Reduces manual work by auto-determining patient status  
3. **Visual Feedback**: Clear indicators show the confidence and method of identification
4. **Integrated Workflow**: Seamlessly connects call data with patient management system

The system maintains backward compatibility and provides graceful fallbacks when external services are unavailable. 