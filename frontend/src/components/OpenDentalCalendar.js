import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Card,
  CardContent,
  CardHeader,
  Typography,
  IconButton,
  Button,
  Chip,
  Tooltip,
  Alert,
  CircularProgress,
  Grid,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Switch,
  FormControlLabel,
  useTheme,
} from '@mui/material';
import {
  CalendarToday as CalendarIcon,
  Refresh as RefreshIcon,
  Settings as SettingsIcon,
  Event as EventIcon,
  Person as PersonIcon,
  Schedule as ScheduleIcon,
  ChevronLeft as PrevIcon,
  ChevronRight as NextIcon,
  Today as TodayIcon,
  Warning as WarningIcon,
} from '@mui/icons-material';
import { openDentalApi } from '../services/api';

const OpenDentalCalendar = ({ height = 600 }) => {
  const theme = useTheme();
  
  // State management
  const [currentDate, setCurrentDate] = useState(new Date());
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [odEnabled, setOdEnabled] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [selectedAppointment, setSelectedAppointment] = useState(null);
  const [appointmentDetailsOpen, setAppointmentDetailsOpen] = useState(false);
  
  // Refs
  const refreshTimer = useRef(null);

  // Check Open Dental status on mount
  useEffect(() => {
    checkOpenDentalStatus();
  }, []);

  // Set up auto-refresh every 5 minutes
  useEffect(() => {
    if (autoRefreshEnabled && odEnabled) {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }

    return () => stopAutoRefresh();
  }, [autoRefreshEnabled, odEnabled]);

  const checkOpenDentalStatus = async () => {
    try {
      const health = await openDentalApi.getHealth();
      setOdEnabled(health.enabled);
      if (health.enabled) {
        fetchAppointments();
      }
    } catch (error) {
      console.warn('Open Dental health check failed:', error);
      setOdEnabled(false);
      // Show mock data for demonstration
      setAppointments(generateMockAppointments());
    }
  };

  const startAutoRefresh = () => {
    stopAutoRefresh();
    // Refresh every 5 minutes (300,000 ms)
    refreshTimer.current = setInterval(() => {
      fetchAppointments(false); // Silent refresh
    }, 300000);
  };

  const stopAutoRefresh = () => {
    if (refreshTimer.current) {
      clearInterval(refreshTimer.current);
      refreshTimer.current = null;
    }
  };

  const fetchAppointments = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true);
      setError(null);

      const startDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const endDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
      
      const response = await openDentalApi.getSlots({
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        includeBooked: true,
      });

      setAppointments(response.slots || []);
      setLastRefresh(new Date());
    } catch (error) {
      console.error('Failed to fetch appointments:', error);
      setError(error.message);
      // Use mock data for demonstration
      setAppointments(generateMockAppointments());
    } finally {
      setLoading(false);
    }
  }, [currentDate]);

  const generateMockAppointments = () => {
    const appointments = [];
    const today = new Date();
    
    for (let i = 0; i < 15; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + Math.floor(Math.random() * 30) - 15);
      
      const hour = 8 + Math.floor(Math.random() * 10);
      const minute = Math.random() > 0.5 ? 0 : 30;
      
      appointments.push({
        id: `mock-${i}`,
        patientName: `Patient ${i + 1}`,
        patientPhone: `+1-555-${String(Math.floor(Math.random() * 9000) + 1000)}`,
        appointmentType: ['Checkup', 'Cleaning', 'Consultation', 'Emergency'][Math.floor(Math.random() * 4)],
        duration: [30, 45, 60][Math.floor(Math.random() * 3)],
        providerName: ['Dr. Smith', 'Dr. Johnson', 'Dr. Brown'][Math.floor(Math.random() * 3)],
        roomName: `Room ${Math.floor(Math.random() * 5) + 1}`,
        status: ['scheduled', 'confirmed', 'arrived', 'completed'][Math.floor(Math.random() * 4)],
        dateTime: new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute),
        notes: Math.random() > 0.7 ? 'Special instructions needed' : '',
        isEmergency: Math.random() > 0.9,
      });
    }
    
    return appointments.sort((a, b) => a.dateTime - b.dateTime);
  };

  // Get today's appointments
  const getTodaysAppointments = () => {
    const today = new Date();
    return appointments.filter(apt => {
      const aptDate = new Date(apt.dateTime);
      return aptDate.toDateString() === today.toDateString();
    });
  };

  // Get this week's appointments
  const getWeeksAppointments = () => {
    const today = new Date();
    const oneWeekFromNow = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    
    return appointments.filter(apt => {
      const aptDate = new Date(apt.dateTime);
      return aptDate >= today && aptDate <= oneWeekFromNow;
    });
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'scheduled': return 'primary';
      case 'confirmed': return 'info';
      case 'arrived': return 'warning';
      case 'completed': return 'success';
      case 'cancelled': return 'error';
      default: return 'default';
    }
  };

  const handleAppointmentClick = (appointment) => {
    setSelectedAppointment(appointment);
    setAppointmentDetailsOpen(true);
  };

  const formatTime = (dateTime) => {
    const date = new Date(dateTime);
    return date.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
  };

  const formatDate = (dateTime) => {
    const date = new Date(dateTime);
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      weekday: 'short'
    });
  };

  if (!odEnabled) {
    return (
      <Card>
        <CardContent>
          <Alert severity="info" icon={<WarningIcon />}>
            <Typography variant="h6">Open Dental Calendar</Typography>
            <Typography variant="body2">
              Open Dental integration is not configured. Showing sample appointment data for demonstration.
            </Typography>
          </Alert>
          
          {/* Still show sample data */}
          <Box mt={2}>
            <Typography variant="h6" gutterBottom>Sample Appointments</Typography>
            <List>
              {generateMockAppointments().slice(0, 5).map((appointment) => (
                <ListItem key={appointment.id} button onClick={() => handleAppointmentClick(appointment)}>
                  <ListItemIcon>
                    <EventIcon color={appointment.isEmergency ? 'error' : 'primary'} />
                  </ListItemIcon>
                  <ListItemText
                    primary={`${formatTime(appointment.dateTime)} - ${appointment.patientName}`}
                    secondary={`${appointment.appointmentType} with ${appointment.providerName}`}
                  />
                  <Chip
                    label={appointment.status}
                    size="small"
                    color={getStatusColor(appointment.status)}
                  />
                </ListItem>
              ))}
            </List>
          </Box>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card sx={{ height: height }}>
      <CardHeader
        title={
          <Box display="flex" alignItems="center">
            <CalendarIcon sx={{ mr: 1 }} />
            <Typography variant="h6">
              Open Dental Calendar
            </Typography>
            {loading && <CircularProgress size={20} sx={{ ml: 1 }} />}
          </Box>
        }
        action={
          <Box display="flex" alignItems="center" gap={1}>
            {lastRefresh && (
              <Typography variant="caption" color="textSecondary">
                Updated: {lastRefresh.toLocaleTimeString()}
              </Typography>
            )}
            
            <Tooltip title="Refresh now">
              <IconButton onClick={() => fetchAppointments()} disabled={loading}>
                <RefreshIcon />
              </IconButton>
            </Tooltip>
            
            <Tooltip title="Settings">
              <IconButton onClick={() => setSettingsOpen(true)}>
                <SettingsIcon />
              </IconButton>
            </Tooltip>
          </Box>
        }
      />

      <CardContent sx={{ height: height - 80, overflow: 'auto' }}>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Grid container spacing={3}>
          {/* Today's Appointments */}
          <Grid item xs={12} md={6}>
            <Typography variant="h6" gutterBottom>
              Today's Appointments ({getTodaysAppointments().length})
            </Typography>
            
            {getTodaysAppointments().length === 0 ? (
              <Typography variant="body2" color="textSecondary">
                No appointments scheduled for today
              </Typography>
            ) : (
              <List dense>
                {getTodaysAppointments().map((appointment) => (
                  <ListItem
                    key={appointment.id}
                    button
                    onClick={() => handleAppointmentClick(appointment)}
                    sx={{
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 1,
                      mb: 1,
                    }}
                  >
                    <ListItemIcon>
                      <EventIcon color={appointment.isEmergency ? 'error' : 'primary'} />
                    </ListItemIcon>
                    <ListItemText
                      primary={
                        <Box display="flex" alignItems="center" gap={1}>
                          <Typography variant="body2" fontWeight="medium">
                            {formatTime(appointment.dateTime)}
                          </Typography>
                          <Typography variant="body2">
                            {appointment.patientName}
                          </Typography>
                        </Box>
                      }
                      secondary={`${appointment.appointmentType} • ${appointment.providerName}`}
                    />
                    <Chip
                      label={appointment.status}
                      size="small"
                      color={getStatusColor(appointment.status)}
                    />
                  </ListItem>
                ))}
              </List>
            )}
          </Grid>

          {/* This Week's Appointments */}
          <Grid item xs={12} md={6}>
            <Typography variant="h6" gutterBottom>
              This Week ({getWeeksAppointments().length})
            </Typography>
            
            <List dense>
              {getWeeksAppointments().slice(0, 10).map((appointment) => (
                <ListItem
                  key={appointment.id}
                  button
                  onClick={() => handleAppointmentClick(appointment)}
                  sx={{
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1,
                    mb: 1,
                  }}
                >
                  <ListItemIcon>
                    <EventIcon color={appointment.isEmergency ? 'error' : 'primary'} />
                  </ListItemIcon>
                  <ListItemText
                    primary={
                      <Box display="flex" alignItems="center" gap={1}>
                        <Typography variant="body2" fontWeight="medium">
                          {formatDate(appointment.dateTime)}
                        </Typography>
                        <Typography variant="body2">
                          {formatTime(appointment.dateTime)}
                        </Typography>
                      </Box>
                    }
                    secondary={`${appointment.patientName} • ${appointment.appointmentType}`}
                  />
                  <Chip
                    label={appointment.status}
                    size="small"
                    color={getStatusColor(appointment.status)}
                  />
                </ListItem>
              ))}
            </List>
          </Grid>
        </Grid>
      </CardContent>

      {/* Settings Dialog */}
      <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Calendar Settings</DialogTitle>
        <DialogContent>
          <Box py={2}>
            <FormControlLabel
              control={
                <Switch
                  checked={autoRefreshEnabled}
                  onChange={(e) => setAutoRefreshEnabled(e.target.checked)}
                />
              }
              label="Auto-refresh calendar every 5 minutes"
            />
            
            <Typography variant="body2" color="textSecondary" sx={{ mt: 1 }}>
              Calendar will automatically sync with Open Dental every 5 minutes when enabled.
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSettingsOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Appointment Details Dialog */}
      <Dialog 
        open={appointmentDetailsOpen} 
        onClose={() => setAppointmentDetailsOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        {selectedAppointment && (
          <>
            <DialogTitle>
              <Box display="flex" alignItems="center" gap={1}>
                <EventIcon />
                Appointment Details
                {selectedAppointment.isEmergency && (
                  <Chip label="Emergency" color="error" size="small" />
                )}
              </Box>
            </DialogTitle>
            <DialogContent>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <Typography variant="subtitle2" color="textSecondary">Patient</Typography>
                  <Typography variant="body1">{selectedAppointment.patientName}</Typography>
                  <Typography variant="body2">{selectedAppointment.patientPhone}</Typography>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <Typography variant="subtitle2" color="textSecondary">Date & Time</Typography>
                  <Typography variant="body1">
                    {new Date(selectedAppointment.dateTime).toLocaleDateString()}
                  </Typography>
                  <Typography variant="body2">
                    {formatTime(selectedAppointment.dateTime)} ({selectedAppointment.duration} min)
                  </Typography>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <Typography variant="subtitle2" color="textSecondary">Provider</Typography>
                  <Typography variant="body1">{selectedAppointment.providerName}</Typography>
                  <Typography variant="body2">{selectedAppointment.roomName}</Typography>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <Typography variant="subtitle2" color="textSecondary">Status</Typography>
                  <Chip
                    label={selectedAppointment.status}
                    color={getStatusColor(selectedAppointment.status)}
                    sx={{ mt: 0.5 }}
                  />
                </Grid>
                <Grid item xs={12}>
                  <Typography variant="subtitle2" color="textSecondary">Appointment Type</Typography>
                  <Typography variant="body1">{selectedAppointment.appointmentType}</Typography>
                </Grid>
                {selectedAppointment.notes && (
                  <Grid item xs={12}>
                    <Typography variant="subtitle2" color="textSecondary">Notes</Typography>
                    <Typography variant="body2">{selectedAppointment.notes}</Typography>
                  </Grid>
                )}
              </Grid>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setAppointmentDetailsOpen(false)}>Close</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Card>
  );
};

export default OpenDentalCalendar; 