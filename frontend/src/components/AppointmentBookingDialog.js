import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Box,
  Typography,
  Alert,
  CircularProgress,
  Autocomplete,
  Chip,
  Grid,
  Card,
  CardContent,
  CardActions,
  Stepper,
  Step,
  StepLabel,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Divider,
  LinearProgress
} from '@mui/material';
import {
  Person,
  Schedule,
  Warning,
  CheckCircle,
  Error,
  AccessTime,
  LocalHospital,
  Phone,
  Email,
  CalendarToday
} from '@mui/icons-material';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { format, addMinutes } from 'date-fns';
import { openDentalApi } from '../services/api';

const AppointmentBookingDialog = ({ 
  open, 
  onClose, 
  providers = [], 
  operatories = [], 
  selectedDate,
  selectedProvider,
  selectedOperatory,
  selectedTime,
  onAppointmentBooked 
}) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  // Patient search and selection
  const [patientQuery, setPatientQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  
  // Appointment details
  const [appointmentData, setAppointmentData] = useState({
    dateTime: selectedDate && selectedTime 
      ? new Date(`${selectedDate}T${selectedTime}:00`) 
      : new Date(),
    duration: 30,
    providerId: selectedProvider?.id || '',
    operatoryId: selectedOperatory?.id || '',
    type: '',
    notes: '',
    isNew: false
  });
  
  // Conflict detection
  const [conflicts, setConflicts] = useState([]);
  const [alternatives, setAlternatives] = useState([]);
  const [hasConflicts, setHasConflicts] = useState(false);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  
  // Form state
  const [newPatientData, setNewPatientData] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    dateOfBirth: ''
  });

  const appointmentTypes = [
    'Consultation',
    'Cleaning',
    'Checkup',
    'Filling',
    'Crown',
    'Root Canal',
    'Extraction',
    'Emergency',
    'Follow-up'
  ];

  const durations = [15, 30, 45, 60, 90, 120];

  const steps = ['Select Patient', 'Appointment Details', 'Confirm Booking'];

  useEffect(() => {
    if (selectedDate && selectedTime && selectedProvider && selectedOperatory) {
      setAppointmentData(prev => ({
        ...prev,
        dateTime: new Date(`${selectedDate}T${selectedTime}:00`),
        providerId: selectedProvider.id,
        operatoryId: selectedOperatory.id
      }));
    }
  }, [selectedDate, selectedTime, selectedProvider, selectedOperatory]);

  // Patient search functionality
  const searchPatients = async (query) => {
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }

    setSearchLoading(true);
    try {
      const response = await openDentalApi.searchPatients(query);
      setSearchResults(response.patients || []);
    } catch (error) {
      console.error('Patient search failed:', error);
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  };

  // Conflict checking
  const checkConflicts = async () => {
    if (!appointmentData.dateTime || !appointmentData.providerId || !appointmentData.operatoryId) {
      return;
    }

    setCheckingConflicts(true);
    try {
      const response = await openDentalApi.checkConflicts({
        dateTime: appointmentData.dateTime.toISOString(),
        duration: appointmentData.duration,
        providerId: appointmentData.providerId,
        operatoryId: appointmentData.operatoryId,
        patientId: selectedPatient?.id
      });

      setHasConflicts(response.hasConflicts);
      setConflicts(response.conflicts || []);
      setAlternatives(response.alternatives || []);
    } catch (error) {
      console.error('Conflict check failed:', error);
      setError('Unable to check for conflicts. Please try again.');
    } finally {
      setCheckingConflicts(false);
    }
  };

  // Handle step navigation
  const handleNext = async () => {
    if (currentStep === 0) {
      // Validate patient selection
      if (!selectedPatient && !newPatientData.firstName) {
        setError('Please select or enter patient information');
        return;
      }
      if (!selectedPatient) {
        setAppointmentData(prev => ({ ...prev, isNew: true }));
      }
    } else if (currentStep === 1) {
      // Check conflicts before final step
      await checkConflicts();
    }
    
    setCurrentStep(prev => prev + 1);
    setError(null);
  };

  const handleBack = () => {
    setCurrentStep(prev => prev - 1);
    setError(null);
  };

  // Book appointment
  const handleBookAppointment = async () => {
    setLoading(true);
    setError(null);

    try {
      const bookingData = {
        patientId: selectedPatient?.id,
        ...appointmentData,
        dateTime: appointmentData.dateTime.toISOString()
      };

      // If new patient, include patient data
      if (appointmentData.isNew) {
        bookingData.newPatientData = newPatientData;
      }

      const response = await openDentalApi.bookAppointment(bookingData);

      if (response.success) {
        onAppointmentBooked?.(response.appointment);
        handleClose();
      } else {
        setError(response.message || 'Failed to book appointment');
        if (response.conflicts) {
          setConflicts(response.conflicts);
          setAlternatives(response.alternatives || []);
          setHasConflicts(true);
        }
      }
    } catch (error) {
      console.error('Booking failed:', error);
      setError('Failed to book appointment. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Select alternative time slot
  const selectAlternative = (alternative) => {
    setAppointmentData(prev => ({
      ...prev,
      dateTime: new Date(alternative.dateTime)
    }));
    setHasConflicts(false);
    setConflicts([]);
    setAlternatives([]);
  };

  const handleClose = () => {
    setCurrentStep(0);
    setSelectedPatient(null);
    setPatientQuery('');
    setSearchResults([]);
    setConflicts([]);
    setAlternatives([]);
    setHasConflicts(false);
    setError(null);
    setNewPatientData({
      firstName: '',
      lastName: '',
      phone: '',
      email: '',
      dateOfBirth: ''
    });
    onClose();
  };

  const renderPatientStep = () => (
    <Box>
      <Typography variant="h6" gutterBottom>
        Find or Add Patient
      </Typography>
      
      <Autocomplete
        options={searchResults}
        getOptionLabel={(option) => `${option.fullName} - ${option.phone}`}
        loading={searchLoading}
        onInputChange={(event, value) => {
          setPatientQuery(value);
          searchPatients(value);
        }}
        onChange={(event, value) => setSelectedPatient(value)}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Search for existing patient"
            placeholder="Enter name, phone, or email"
            InputProps={{
              ...params.InputProps,
              endAdornment: (
                <>
                  {searchLoading && <CircularProgress size={20} />}
                  {params.InputProps.endAdornment}
                </>
              ),
            }}
          />
        )}
        renderOption={(props, option) => (
          <Box component="li" {...props}>
            <Box>
              <Typography variant="body1">{option.fullName}</Typography>
              <Typography variant="body2" color="text.secondary">
                {option.phone} • {option.email}
              </Typography>
            </Box>
          </Box>
        )}
        sx={{ mb: 3 }}
      />

      {selectedPatient && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6">{selectedPatient.fullName}</Typography>
            <Box display="flex" gap={2} mt={1}>
              <Chip icon={<Phone />} label={selectedPatient.phone} size="small" />
              <Chip icon={<Email />} label={selectedPatient.email} size="small" />
            </Box>
          </CardContent>
        </Card>
      )}

      <Divider sx={{ my: 2 }}>
        <Typography variant="body2" color="text.secondary">OR</Typography>
      </Divider>

      <Typography variant="subtitle1" gutterBottom>
        Add New Patient
      </Typography>
      
      <Grid container spacing={2}>
        <Grid item xs={6}>
          <TextField
            fullWidth
            label="First Name"
            value={newPatientData.firstName}
            onChange={(e) => setNewPatientData(prev => ({ ...prev, firstName: e.target.value }))}
          />
        </Grid>
        <Grid item xs={6}>
          <TextField
            fullWidth
            label="Last Name"
            value={newPatientData.lastName}
            onChange={(e) => setNewPatientData(prev => ({ ...prev, lastName: e.target.value }))}
          />
        </Grid>
        <Grid item xs={6}>
          <TextField
            fullWidth
            label="Phone Number"
            value={newPatientData.phone}
            onChange={(e) => setNewPatientData(prev => ({ ...prev, phone: e.target.value }))}
          />
        </Grid>
        <Grid item xs={6}>
          <TextField
            fullWidth
            label="Email"
            type="email"
            value={newPatientData.email}
            onChange={(e) => setNewPatientData(prev => ({ ...prev, email: e.target.value }))}
          />
        </Grid>
        <Grid item xs={12}>
          <TextField
            fullWidth
            label="Date of Birth"
            type="date"
            InputLabelProps={{ shrink: true }}
            value={newPatientData.dateOfBirth}
            onChange={(e) => setNewPatientData(prev => ({ ...prev, dateOfBirth: e.target.value }))}
          />
        </Grid>
      </Grid>
    </Box>
  );

  const renderAppointmentDetailsStep = () => (
    <Box>
      <Typography variant="h6" gutterBottom>
        Appointment Details
      </Typography>
      
      <Grid container spacing={3}>
        <Grid item xs={12}>
          <LocalizationProvider dateAdapter={AdapterDateFns}>
            <DateTimePicker
              label="Appointment Date & Time"
              value={appointmentData.dateTime}
              onChange={(newValue) => setAppointmentData(prev => ({ ...prev, dateTime: newValue }))}
              renderInput={(params) => <TextField {...params} fullWidth />}
              minDate={new Date()}
            />
          </LocalizationProvider>
        </Grid>
        
        <Grid item xs={6}>
          <FormControl fullWidth>
            <InputLabel>Duration (minutes)</InputLabel>
            <Select
              value={appointmentData.duration}
              label="Duration (minutes)"
              onChange={(e) => setAppointmentData(prev => ({ ...prev, duration: e.target.value }))}
            >
              {durations.map(duration => (
                <MenuItem key={duration} value={duration}>
                  {duration} minutes
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
        
        <Grid item xs={6}>
          <FormControl fullWidth>
            <InputLabel>Appointment Type</InputLabel>
            <Select
              value={appointmentData.type}
              label="Appointment Type"
              onChange={(e) => setAppointmentData(prev => ({ ...prev, type: e.target.value }))}
            >
              {appointmentTypes.map(type => (
                <MenuItem key={type} value={type}>
                  {type}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
        
        <Grid item xs={6}>
          <FormControl fullWidth>
            <InputLabel>Provider</InputLabel>
            <Select
              value={appointmentData.providerId}
              label="Provider"
              onChange={(e) => setAppointmentData(prev => ({ ...prev, providerId: e.target.value }))}
            >
              {providers.map(provider => (
                <MenuItem key={provider.id} value={provider.id}>
                  {provider.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
        
        <Grid item xs={6}>
          <FormControl fullWidth>
            <InputLabel>Operatory</InputLabel>
            <Select
              value={appointmentData.operatoryId}
              label="Operatory"
              onChange={(e) => setAppointmentData(prev => ({ ...prev, operatoryId: e.target.value }))}
            >
              {operatories.map(operatory => (
                <MenuItem key={operatory.id} value={operatory.id}>
                  {operatory.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
        
        <Grid item xs={12}>
          <TextField
            fullWidth
            label="Notes"
            multiline
            rows={3}
            value={appointmentData.notes}
            onChange={(e) => setAppointmentData(prev => ({ ...prev, notes: e.target.value }))}
          />
        </Grid>
      </Grid>

      {checkingConflicts && (
        <Box mt={2}>
          <LinearProgress />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Checking for scheduling conflicts...
          </Typography>
        </Box>
      )}
    </Box>
  );

  const renderConfirmationStep = () => (
    <Box>
      <Typography variant="h6" gutterBottom>
        Confirm Appointment
      </Typography>
      
      {hasConflicts && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <Typography variant="subtitle2">Scheduling Conflicts Detected</Typography>
          {conflicts.map((conflict, index) => (
            <Typography key={index} variant="body2">
              • {conflict.message}
            </Typography>
          ))}
        </Alert>
      )}

      {alternatives.length > 0 && (
        <Box mb={2}>
          <Typography variant="subtitle1" gutterBottom>
            Alternative Time Slots:
          </Typography>
          <List>
            {alternatives.slice(0, 3).map((alt, index) => (
              <ListItem 
                key={index}
                button
                onClick={() => selectAlternative(alt)}
                sx={{ border: 1, borderColor: 'divider', borderRadius: 1, mb: 1 }}
              >
                <ListItemIcon>
                  <AccessTime />
                </ListItemIcon>
                <ListItemText
                  primary={format(new Date(alt.dateTime), 'MMM d, yyyy h:mm a')}
                  secondary="Available"
                />
              </ListItem>
            ))}
          </List>
        </Box>
      )}

      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Appointment Summary
          </Typography>
          
          <Box display="flex" alignItems="center" mb={1}>
            <Person sx={{ mr: 1 }} />
            <Typography>
              {selectedPatient ? selectedPatient.fullName : `${newPatientData.firstName} ${newPatientData.lastName}`}
              {appointmentData.isNew && <Chip label="New Patient" size="small" sx={{ ml: 1 }} />}
            </Typography>
          </Box>
          
          <Box display="flex" alignItems="center" mb={1}>
            <CalendarToday sx={{ mr: 1 }} />
            <Typography>
              {format(appointmentData.dateTime, 'MMM d, yyyy h:mm a')}
            </Typography>
          </Box>
          
          <Box display="flex" alignItems="center" mb={1}>
            <Schedule sx={{ mr: 1 }} />
            <Typography>
              {appointmentData.duration} minutes - {appointmentData.type}
            </Typography>
          </Box>
          
          <Box display="flex" alignItems="center" mb={1}>
            <LocalHospital sx={{ mr: 1 }} />
            <Typography>
              {providers.find(p => p.id === appointmentData.providerId)?.name} • {' '}
              {operatories.find(o => o.id === appointmentData.operatoryId)?.name}
            </Typography>
          </Box>
          
          {appointmentData.notes && (
            <Box mt={2}>
              <Typography variant="subtitle2">Notes:</Typography>
              <Typography variant="body2">{appointmentData.notes}</Typography>
            </Box>
          )}
        </CardContent>
      </Card>
    </Box>
  );

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>
        Book New Appointment
        <Stepper activeStep={currentStep} sx={{ mt: 2 }}>
          {steps.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>
      </DialogTitle>
      
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        
        {currentStep === 0 && renderPatientStep()}
        {currentStep === 1 && renderAppointmentDetailsStep()}
        {currentStep === 2 && renderConfirmationStep()}
      </DialogContent>
      
      <DialogActions>
        <Button onClick={handleClose}>Cancel</Button>
        {currentStep > 0 && (
          <Button onClick={handleBack}>Back</Button>
        )}
        {currentStep < steps.length - 1 ? (
          <Button 
            onClick={handleNext} 
            variant="contained"
            disabled={loading}
          >
            Next
          </Button>
        ) : (
          <Button 
            onClick={handleBookAppointment} 
            variant="contained" 
            disabled={loading || (hasConflicts && alternatives.length === 0)}
            startIcon={loading && <CircularProgress size={20} />}
          >
            {hasConflicts ? 'Book Despite Conflicts' : 'Book Appointment'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};

export default AppointmentBookingDialog; 