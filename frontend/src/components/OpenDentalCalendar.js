import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  ButtonGroup,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Chip,
  IconButton,
  FormControl,
  Select,
  MenuItem,
  InputLabel,
  Tooltip,
  CircularProgress,
  Alert,
  Badge,
  Fab,
  Snackbar
} from '@mui/material';
import {
  ChevronLeft,
  ChevronRight,
  Today,
  Refresh,
  Add,
  Sync,
  Warning,
  CheckCircle,
  Person,
  LocationOn
} from '@mui/icons-material';
import { format, addDays, subDays, isToday, parseISO } from 'date-fns';
import { openDentalApi } from '../services/api';
import AppointmentBookingDialog from './AppointmentBookingDialog';

// Time configuration
const START_HOUR = 8; // 8 AM
const END_HOUR = 18; // 6 PM
const TIME_SLOT_MINUTES = 30;
const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Provider/Operatory colors
const PROVIDER_COLORS = [
  '#1976d2', '#388e3c', '#f57c00', '#7b1fa2', 
  '#c2185b', '#00796b', '#5d4037', '#455a64',
  '#e91e63', '#9c27b0', '#673ab7', '#3f51b5'
];

// Appointment status colors
const STATUS_COLORS = {
  scheduled: '#2196f3',
  confirmed: '#4caf50', 
  arrived: '#ff9800',
  completed: '#9e9e9e',
  cancelled: '#f44336',
  no_show: '#795548'
};

const OpenDentalCalendar = () => {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [appointments, setAppointments] = useState([]);
  const [providers, setProviders] = useState([]);
  const [operatories, setOperatories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedAppointment, setSelectedAppointment] = useState(null);
  const [viewMode, setViewMode] = useState('provider'); // 'provider' or 'operatory'
  const [refreshing, setRefreshing] = useState(false);
  
  // New booking functionality
  const [bookingDialogOpen, setBookingDialogOpen] = useState(false);
  const [selectedTimeSlot, setSelectedTimeSlot] = useState(null);
  const [syncStatus, setSyncStatus] = useState({ enabled: false, lastSync: null, conflicts: 0 });
  const [notification, setNotification] = useState({ open: false, message: '', severity: 'info' });

  // Generate time slots for the day
  const timeSlots = useMemo(() => {
    const slots = [];
    const totalMinutes = (END_HOUR - START_HOUR) * 60;
    
    for (let i = 0; i <= totalMinutes; i += TIME_SLOT_MINUTES) {
      const hour = START_HOUR + Math.floor(i / 60);
      const minute = i % 60;
      const time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
      const timeValue = hour * 60 + minute;
      
      slots.push({
        time,
        timeValue,
        hour,
        minute
      });
    }
    return slots;
  }, []);

  // Get current time indicator position
  const getCurrentTimePosition = useCallback(() => {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeValue = currentHour * 60 + currentMinute;
    
    if (currentTimeValue < START_HOUR * 60 || currentTimeValue > END_HOUR * 60) {
      return null;
    }
    
    const totalMinutes = (END_HOUR - START_HOUR) * 60;
    const position = ((currentTimeValue - START_HOUR * 60) / totalMinutes) * 100;
    return position;
  }, []);

  // Generate mock data for demonstration
  const generateMockData = useCallback(() => {
    const mockProviders = [
      { id: 1, name: 'Dr. Brian Albert', color: PROVIDER_COLORS[0] },
      { id: 2, name: 'Dr. Sarah Lexington', color: PROVIDER_COLORS[1] },
      { id: 3, name: 'Dr. Michael Chen', color: PROVIDER_COLORS[2] },
      { id: 4, name: 'Dr. Emily Rodriguez', color: PROVIDER_COLORS[3] }
    ];

    const mockOperatories = [
      { id: 1, name: 'Op 1', color: PROVIDER_COLORS[4] },
      { id: 2, name: 'Op 2', color: PROVIDER_COLORS[5] },
      { id: 3, name: 'Op 3', color: PROVIDER_COLORS[6] },
      { id: 4, name: 'Hygiene 1', color: PROVIDER_COLORS[7] }
    ];

    const mockAppointments = [
      {
        id: 1,
        patient: 'John Smith',
        time: '09:00',
        duration: 60,
        type: 'Cleaning',
        status: 'confirmed',
        providerId: 1,
        operatoryId: 1,
        notes: 'Regular checkup and cleaning'
      },
      {
        id: 2,
        patient: 'Mary Johnson',
        time: '10:30',
        duration: 30,
        type: 'Consultation',
        status: 'scheduled',
        providerId: 2,
        operatoryId: 2,
        notes: 'New patient consultation'
      },
      {
        id: 3,
        patient: 'Robert Davis',
        time: '14:00',
        duration: 90,
        type: 'Root Canal',
        status: 'arrived',
        providerId: 1,
        operatoryId: 1,
        notes: 'Endodontic treatment'
      },
      {
        id: 4,
        patient: 'Lisa Wilson',
        time: '15:30',
        duration: 45,
        type: 'Crown Prep',
        status: 'confirmed',
        providerId: 3,
        operatoryId: 3,
        notes: 'Crown preparation'
      }
    ];

    setProviders(mockProviders);
    setOperatories(mockOperatories);
    setAppointments(mockAppointments);
  }, []);

  // Fetch calendar data with enhanced error handling
  const fetchCalendarData = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    else setLoading(true);
    
    setError(null);

    try {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      
      // Try to fetch from Open Dental API
      const response = await openDentalApi.getCalendar({
        date: dateStr,
        view: viewMode
      });
      
      if (response.appointments) {
        setAppointments(response.appointments);
        setProviders(response.providers || []);
        setOperatories(response.operatories || []);
        
        // Update sync status if available
        if (response.lastSync) {
          setSyncStatus(prev => ({
            ...prev,
            lastSync: response.lastSync,
            enabled: true
          }));
        }
      } else {
        // Fallback to mock data
        generateMockData();
      }
    } catch (err) {
      console.warn('Open Dental API not available, using mock data:', err);
      generateMockData();
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedDate, viewMode, generateMockData]);

  // Show notification
  const showNotification = useCallback((message, severity = 'info') => {
    setNotification({ open: true, message, severity });
  }, []);

  // Check sync status
  const checkSyncStatus = useCallback(async () => {
    try {
      const response = await openDentalApi.getSyncStatus();
      setSyncStatus({
        enabled: response.enabled,
        lastSync: response.lastSync,
        conflicts: response.conflicts?.length || 0,
        isActive: response.isActive
      });
    } catch (error) {
      console.error('Failed to check sync status:', error);
    }
  }, []);

  // Trigger manual sync
  const triggerSync = useCallback(async () => {
    setRefreshing(true);
    try {
      await openDentalApi.triggerSync();
      showNotification('Sync triggered successfully', 'success');
      // Refresh calendar data after sync
      setTimeout(() => {
        fetchCalendarData(false);
        checkSyncStatus();
      }, 2000);
    } catch (error) {
      console.error('Manual sync failed:', error);
      showNotification('Sync failed. Please try again.', 'error');
    } finally {
      setRefreshing(false);
    }
  }, [fetchCalendarData, checkSyncStatus, showNotification]);

  // Get columns based on view mode
  const columns = useMemo(() => {
    return viewMode === 'provider' ? providers : operatories;
  }, [viewMode, providers, operatories]);

  // Calculate appointment position and height
  const getAppointmentStyle = useCallback((appointment) => {
    const [hour, minute] = appointment.time.split(':').map(Number);
    const startTimeValue = hour * 60 + minute;
    const endTimeValue = startTimeValue + appointment.duration;
    
    const totalMinutes = (END_HOUR - START_HOUR) * 60;
    const top = ((startTimeValue - START_HOUR * 60) / totalMinutes) * 100;
    const height = (appointment.duration / totalMinutes) * 100;
    
    return {
      position: 'absolute',
      top: `${top}%`,
      height: `${height}%`,
      left: '2px',
      right: '2px',
      backgroundColor: STATUS_COLORS[appointment.status] || STATUS_COLORS.scheduled,
      border: '1px solid rgba(255,255,255,0.2)',
      borderRadius: '4px',
      padding: '4px',
      fontSize: '12px',
      color: 'white',
      overflow: 'hidden',
      cursor: 'pointer',
      zIndex: 1,
      '&:hover': {
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        zIndex: 2
      }
    };
  }, []);

  // Get appointments for a specific column and time slot
  const getAppointmentsForSlot = useCallback((columnId, timeSlot) => {
    return appointments.filter(apt => {
      const columnField = viewMode === 'provider' ? 'providerId' : 'operatoryId';
      const [hour, minute] = apt.time.split(':').map(Number);
      const aptTimeValue = hour * 60 + minute;
      const endTimeValue = aptTimeValue + apt.duration;
      
      return apt[columnField] === columnId && 
             aptTimeValue < (timeSlot.timeValue + TIME_SLOT_MINUTES) &&
             endTimeValue > timeSlot.timeValue;
    });
  }, [appointments, viewMode]);

  // Handle date navigation
  const navigateDate = (direction) => {
    if (direction === 'prev') {
      setSelectedDate(subDays(selectedDate, 1));
    } else if (direction === 'next') {
      setSelectedDate(addDays(selectedDate, 1));
    } else {
      setSelectedDate(new Date());
    }
  };

  // Handle appointment click
  const handleAppointmentClick = (appointment) => {
    setSelectedAppointment(appointment);
  };

  // Handle cell click for booking
  const handleCellClick = useCallback((columnId, timeSlot) => {
    const column = columns.find(c => c.id === columnId);
    if (!column) return;

    const selectedDateTime = new Date(selectedDate);
    selectedDateTime.setHours(timeSlot.hour, timeSlot.minute, 0, 0);

    setSelectedTimeSlot({
      date: format(selectedDate, 'yyyy-MM-dd'),
      time: timeSlot.time,
      dateTime: selectedDateTime,
      provider: viewMode === 'provider' ? column : null,
      operatory: viewMode === 'operatory' ? column : null
    });
    setBookingDialogOpen(true);
  }, [columns, selectedDate, viewMode]);

  // Handle appointment booked
  const handleAppointmentBooked = useCallback((newAppointment) => {
    showNotification('Appointment booked successfully!', 'success');
    fetchCalendarData(); // Refresh calendar
    setBookingDialogOpen(false);
    setSelectedTimeSlot(null);
  }, [fetchCalendarData, showNotification]);

  // Close notification
  const handleCloseNotification = () => {
    setNotification(prev => ({ ...prev, open: false }));
  };

  // Auto-refresh setup with sync status checking
  useEffect(() => {
    fetchCalendarData();
    checkSyncStatus();
    
    const interval = setInterval(() => {
      fetchCalendarData(true);
      checkSyncStatus();
    }, REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, [fetchCalendarData]);

  // Current time indicator position
  const currentTimePosition = getCurrentTimePosition();

  if (loading && !refreshing) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" height="400px">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header Controls */}
      <Paper elevation={1} sx={{ p: 2, mb: 2 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={2}>
          {/* Date Navigation */}
          <Box display="flex" alignItems="center" gap={1}>
            <ButtonGroup variant="outlined" size="small">
              <IconButton onClick={() => navigateDate('prev')}>
                <ChevronLeft />
              </IconButton>
              <Button onClick={() => navigateDate('today')} startIcon={<Today />}>
                Today
              </Button>
              <IconButton onClick={() => navigateDate('next')}>
                <ChevronRight />
              </IconButton>
            </ButtonGroup>
            
            <Typography variant="h6" sx={{ ml: 2, minWidth: '200px' }}>
              {format(selectedDate, 'EEEE, MMMM d, yyyy')}
            </Typography>
          </Box>

          {/* View Controls */}
          <Box display="flex" alignItems="center" gap={2}>
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel>View</InputLabel>
              <Select
                value={viewMode}
                label="View"
                onChange={(e) => setViewMode(e.target.value)}
              >
                <MenuItem value="provider">
                  <Person sx={{ mr: 1 }} /> Providers
                </MenuItem>
                <MenuItem value="operatory">
                  <LocationOn sx={{ mr: 1 }} /> Operatories
                </MenuItem>
              </Select>
            </FormControl>

            <Tooltip title="Refresh Calendar">
              <IconButton 
                onClick={() => fetchCalendarData(true)}
                disabled={refreshing}
                size="small"
              >
                {refreshing ? <CircularProgress size={20} /> : <Refresh />}
              </IconButton>
            </Tooltip>

            {syncStatus.enabled && (
              <Tooltip title={`Sync Status: ${syncStatus.isActive ? 'Active' : 'Inactive'} | Last: ${syncStatus.lastSync ? format(new Date(syncStatus.lastSync), 'h:mm a') : 'Never'}`}>
                <Badge badgeContent={syncStatus.conflicts} color="warning">
                  <IconButton 
                    onClick={triggerSync}
                    disabled={refreshing}
                    size="small"
                    color={syncStatus.isActive ? 'success' : 'default'}
                  >
                    <Sync />
                  </IconButton>
                </Badge>
              </Tooltip>
            )}
          </Box>
        </Box>
      </Paper>

      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Calendar Grid */}
      <Paper elevation={2} sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Column Headers */}
        <Box 
          sx={{ 
            display: 'grid',
            gridTemplateColumns: `80px repeat(${columns.length}, 1fr)`,
            borderBottom: 1,
            borderColor: 'divider',
            backgroundColor: 'grey.50'
          }}
        >
          <Box sx={{ p: 1, borderRight: 1, borderColor: 'divider' }}>
            <Typography variant="subtitle2" color="text.secondary">Time</Typography>
          </Box>
          {columns.map((column) => (
            <Box 
              key={column.id}
              sx={{ 
                p: 1, 
                borderRight: 1, 
                borderColor: 'divider',
                backgroundColor: column.color,
                color: 'white',
                textAlign: 'center'
              }}
            >
              <Typography variant="subtitle2" fontWeight="bold">
                {column.name}
              </Typography>
            </Box>
          ))}
        </Box>

        {/* Calendar Body */}
        <Box sx={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <Box 
            sx={{ 
              display: 'grid',
              gridTemplateColumns: `80px repeat(${columns.length}, 1fr)`,
              minHeight: '100%',
              position: 'relative'
            }}
          >
            {/* Time Labels Column */}
            <Box sx={{ borderRight: 1, borderColor: 'divider' }}>
              {timeSlots.map((slot, index) => (
                <Box 
                  key={slot.time}
                  sx={{ 
                    height: '60px',
                    borderBottom: 1,
                    borderColor: 'divider',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: slot.minute === 0 ? 'grey.50' : 'transparent'
                  }}
                >
                  {slot.minute === 0 && (
                    <Typography variant="caption" color="text.secondary">
                      {slot.time}
                    </Typography>
                  )}
                </Box>
              ))}
            </Box>

            {/* Calendar Columns */}
            {columns.map((column) => (
              <Box 
                key={column.id}
                sx={{ 
                  borderRight: 1, 
                  borderColor: 'divider',
                  position: 'relative',
                  minHeight: `${timeSlots.length * 60}px`
                }}
              >
                {/* Time Slot Grid */}
                {timeSlots.map((slot, index) => (
                  <Box 
                    key={slot.time}
                    onClick={() => handleCellClick(column.id, slot)}
                    sx={{ 
                      height: '60px',
                      borderBottom: 1,
                      borderColor: 'divider',
                      position: 'relative',
                      backgroundColor: slot.minute === 0 ? 'rgba(0,0,0,0.02)' : 'transparent',
                      cursor: 'pointer',
                      '&:hover': {
                        backgroundColor: 'primary.light',
                        opacity: 0.1
                      }
                    }}
                  />
                ))}

                {/* Appointments */}
                {appointments
                  .filter(apt => {
                    const columnField = viewMode === 'provider' ? 'providerId' : 'operatoryId';
                    return apt[columnField] === column.id;
                  })
                  .map((appointment) => (
                    <Box
                      key={appointment.id}
                      onClick={() => handleAppointmentClick(appointment)}
                      sx={getAppointmentStyle(appointment)}
                    >
                      <Typography variant="caption" sx={{ fontWeight: 'bold', display: 'block' }}>
                        {appointment.time}
                      </Typography>
                      <Typography variant="caption" sx={{ display: 'block' }}>
                        {appointment.patient}
                      </Typography>
                      <Typography variant="caption" sx={{ display: 'block', opacity: 0.9 }}>
                        {appointment.type}
                      </Typography>
                    </Box>
                  ))
                }
              </Box>
            ))}

            {/* Current Time Indicator */}
            {isToday(selectedDate) && currentTimePosition !== null && (
              <Box
                sx={{
                  position: 'absolute',
                  top: `${currentTimePosition}%`,
                  left: '80px',
                  right: 0,
                  height: '2px',
                  backgroundColor: 'error.main',
                  zIndex: 10,
                  '&::before': {
                    content: '""',
                    position: 'absolute',
                    left: '-6px',
                    top: '-4px',
                    width: '10px',
                    height: '10px',
                    backgroundColor: 'error.main',
                    borderRadius: '50%'
                  }
                }}
              />
            )}
          </Box>
        </Box>
      </Paper>

      {/* Appointment Detail Dialog */}
      <Dialog 
        open={!!selectedAppointment} 
        onClose={() => setSelectedAppointment(null)}
        maxWidth="sm"
        fullWidth
      >
        {selectedAppointment && (
          <>
            <DialogTitle>
              Appointment Details
              <Chip 
                label={selectedAppointment.status}
                color={selectedAppointment.status === 'confirmed' ? 'success' : 'default'}
                size="small"
                sx={{ ml: 2 }}
              />
            </DialogTitle>
            <DialogContent>
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: '1fr 1fr' }}>
                <Box>
                  <Typography variant="subtitle2" color="text.secondary">Patient</Typography>
                  <Typography variant="body1">{selectedAppointment.patient}</Typography>
                </Box>
                <Box>
                  <Typography variant="subtitle2" color="text.secondary">Time</Typography>
                  <Typography variant="body1">
                    {selectedAppointment.time} ({selectedAppointment.duration} min)
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="subtitle2" color="text.secondary">Appointment Type</Typography>
                  <Typography variant="body1">{selectedAppointment.type}</Typography>
                </Box>
                <Box>
                  <Typography variant="subtitle2" color="text.secondary">Status</Typography>
                  <Typography variant="body1" sx={{ textTransform: 'capitalize' }}>
                    {selectedAppointment.status.replace('_', ' ')}
                  </Typography>
                </Box>
                {selectedAppointment.notes && (
                  <Box sx={{ gridColumn: '1 / -1' }}>
                    <Typography variant="subtitle2" color="text.secondary">Notes</Typography>
                    <Typography variant="body2">{selectedAppointment.notes}</Typography>
                  </Box>
                )}
              </Box>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setSelectedAppointment(null)}>Close</Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      {/* Floating Action Button for New Appointments */}
      <Fab
        color="primary"
        sx={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 1000
        }}
        onClick={() => setBookingDialogOpen(true)}
      >
        <Add />
      </Fab>

      {/* Appointment Booking Dialog */}
      <AppointmentBookingDialog
        open={bookingDialogOpen}
        onClose={() => {
          setBookingDialogOpen(false);
          setSelectedTimeSlot(null);
        }}
        providers={providers}
        operatories={operatories}
        selectedDate={selectedTimeSlot?.date}
        selectedProvider={selectedTimeSlot?.provider}
        selectedOperatory={selectedTimeSlot?.operatory}
        selectedTime={selectedTimeSlot?.time}
        onAppointmentBooked={handleAppointmentBooked}
      />

      {/* Notification Snackbar */}
      <Snackbar
        open={notification.open}
        autoHideDuration={6000}
        onClose={handleCloseNotification}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Alert 
          onClose={handleCloseNotification} 
          severity={notification.severity}
          sx={{ width: '100%' }}
        >
          {notification.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default OpenDentalCalendar; 