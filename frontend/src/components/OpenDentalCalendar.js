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
import FullCalendar from '@fullcalendar/react';
import resourceTimeGridPlugin from '@fullcalendar/resource-timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { openDentalApi } from '../services/api';
import AppointmentBookingDialog from './AppointmentBookingDialog';

// Time configuration
const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

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
  const [resources, setResources] = useState([]);
  const [events, setEvents] = useState([]);
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

  // Transform providers/operatories to FullCalendar resources
  const transformToResources = useCallback((data, type) => {
    return data.map(item => ({
      id: `${type}_${item.id}`,
      title: item.name,
      originalId: item.id,
      type: type
    }));
  }, []);

  // Transform appointments to FullCalendar events
  const transformToEvents = useCallback((appointments, viewMode) => {
    return appointments.map(apt => {
      const resourceField = viewMode === 'provider' ? 'providerId' : 'operatoryId';
      const resourcePrefix = viewMode === 'provider' ? 'provider' : 'operatory';
      
      return {
        id: apt.id,
        title: `${apt.patient} - ${apt.type}`,
        start: `${format(selectedDate, 'yyyy-MM-dd')}T${apt.time}:00`,
        end: calculateEndTime(apt.time, apt.duration),
        resourceId: `${resourcePrefix}_${apt[resourceField]}`,
        backgroundColor: STATUS_COLORS[apt.status] || STATUS_COLORS.scheduled,
        borderColor: STATUS_COLORS[apt.status] || STATUS_COLORS.scheduled,
        textColor: 'white',
        extendedProps: {
          patient: apt.patient,
          type: apt.type,
          status: apt.status,
          notes: apt.notes,
          duration: apt.duration
        }
      };
    });
  }, [selectedDate]);

  // Helper function to calculate end time
  const calculateEndTime = (startTime, duration) => {
    const [hours, minutes] = startTime.split(':').map(Number);
    const startDate = new Date(selectedDate);
    startDate.setHours(hours, minutes, 0, 0);
    startDate.setMinutes(startDate.getMinutes() + duration);
    return startDate.toISOString();
  };

  // Fetch providers from API
  const fetchProviders = useCallback(async () => {
    try {
      const response = await openDentalApi.getProviders();
      if (response && response.success) {
        return response.providers || [];
      }
      return [];
    } catch (error) {
      console.error('Failed to fetch providers:', error);
      return [];
    }
  }, []);

  // Update resources when data changes
  useEffect(() => {
    const currentData = viewMode === 'provider' ? providers : operatories;
    const transformedResources = transformToResources(currentData, viewMode);
    setResources(transformedResources);
  }, [providers, operatories, viewMode, transformToResources]);

  // Update events when appointments change
  useEffect(() => {
    const transformedEvents = transformToEvents(appointments, viewMode);
    setEvents(transformedEvents);
  }, [appointments, viewMode, transformToEvents]);

  // Fetch calendar data with enhanced error handling
  const fetchCalendarData = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    else setLoading(true);
    
    setError(null);

    try {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      
      // Fetch providers and calendar data in parallel
      const [providersData, calendarResponse] = await Promise.all([
        fetchProviders(),
        openDentalApi.getCalendar({
          date: dateStr,
          view: viewMode
        })
      ]);
      
      console.log('🎯 API Response:', calendarResponse);
      
      if (calendarResponse && calendarResponse.success) {
        setAppointments(calendarResponse.appointments || []);
        setProviders(calendarResponse.providers || providersData);
        setOperatories(calendarResponse.operatories || []);
        
        // Update sync status if available
        if (calendarResponse.lastSync) {
          setSyncStatus(prev => ({
            ...prev,
            lastSync: calendarResponse.lastSync,
            enabled: true
          }));
        }
        
        console.log('✅ Real data loaded:', calendarResponse.appointments?.length || 0, 'appointments');
      } else {
        console.log('❌ No success in response, using providers only');
        setAppointments([]);
        setProviders(providersData);
        setOperatories([]);
      }
    } catch (err) {
      console.error('🚨 Open Dental API Error:', err);
      setAppointments([]);
      setProviders([]);
      setOperatories([]);
      setError('Failed to load calendar data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedDate, viewMode, fetchProviders]);

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

  // FullCalendar event handlers
  const handleEventClick = useCallback((clickInfo) => {
    const appointment = {
      id: clickInfo.event.id,
      patient: clickInfo.event.extendedProps.patient,
      time: format(new Date(clickInfo.event.start), 'HH:mm'),
      duration: clickInfo.event.extendedProps.duration,
      type: clickInfo.event.extendedProps.type,
      status: clickInfo.event.extendedProps.status,
      notes: clickInfo.event.extendedProps.notes
    };
    setSelectedAppointment(appointment);
  }, []);

  const handleDateSelect = useCallback((selectInfo) => {
    const resource = resources.find(r => r.id === selectInfo.resource.id);
    if (!resource) return;

    setSelectedTimeSlot({
      date: format(selectInfo.start, 'yyyy-MM-dd'),
      time: format(selectInfo.start, 'HH:mm'),
      dateTime: selectInfo.start,
      provider: resource.type === 'provider' ? { id: resource.originalId, name: resource.title } : null,
      operatory: resource.type === 'operatory' ? { id: resource.originalId, name: resource.title } : null
    });
    setBookingDialogOpen(true);
  }, [resources]);

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
  }, [fetchCalendarData, checkSyncStatus]);

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

      {/* FullCalendar Component */}
      <Paper elevation={2} sx={{ flex: 1, overflow: 'hidden', p: 2 }}>
        <FullCalendar
          plugins={[resourceTimeGridPlugin, interactionPlugin]}
          initialView="resourceTimeGridDay"
          date={selectedDate}
          resources={resources}
          events={events}
          
          // Office hours configuration
          slotDuration="00:15:00"
          slotLabelInterval="01:00"
          slotMinTime="08:00:00"
          slotMaxTime="17:00:00"
          businessHours={[{
            daysOfWeek: [1, 2, 3, 4], // Monday to Thursday
            startTime: '08:00',
            endTime: '17:00'
          }]}
          weekends={false}
          
          // Header and resource configuration
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: ''
          }}
          resourceAreaHeaderContent="Provider / Operatory"
          resourceAreaWidth="150px"
          
          // Event handlers
          eventClick={handleEventClick}
          select={handleDateSelect}
          selectable={true}
          selectMirror={true}
          
          // Styling
          height="100%"
          dayHeaderFormat={{ weekday: 'long', month: 'numeric', day: 'numeric' }}
          slotLabelFormat={{
            hour: 'numeric',
            minute: '2-digit',
            omitZeroMinute: false,
            meridiem: 'short'
          }}
          
          // Appearance
          nowIndicator={true}
          eventDisplay="block"
          eventTextColor="white"
          eventBackgroundColor="#1976d2"
          eventBorderColor="#1976d2"
        />
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