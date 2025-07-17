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
  Paper,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Switch,
  FormControlLabel,
  useTheme,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  styled,
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

// Styled components for the PMS grid
const TimeSlotCell = styled(TableCell)(({ theme }) => ({
  borderRight: `1px solid ${theme.palette.divider}`,
  borderBottom: `1px solid ${theme.palette.divider}`,
  width: '80px',
  padding: '4px 8px',
  fontSize: '0.75rem',
  backgroundColor: theme.palette.grey[50],
  fontWeight: 'bold',
  textAlign: 'center',
  position: 'sticky',
  left: 0,
  zIndex: 1,
}));

const ProviderHeaderCell = styled(TableCell)(({ theme }) => ({
  borderRight: `1px solid ${theme.palette.divider}`,
  borderBottom: `2px solid ${theme.palette.primary.main}`,
  padding: '8px',
  backgroundColor: theme.palette.primary.main,
  color: theme.palette.primary.contrastText,
  fontWeight: 'bold',
  textAlign: 'center',
  minWidth: '150px',
}));

const AppointmentCell = styled(TableCell)(({ theme }) => ({
  borderRight: `1px solid ${theme.palette.divider}`,
  borderBottom: `1px solid ${theme.palette.divider}`,
  padding: '2px',
  height: '40px',
  verticalAlign: 'top',
  position: 'relative',
  minWidth: '150px',
}));

const AppointmentBlock = styled(Paper)(({ theme, status }) => ({
  padding: '4px 6px',
  margin: '1px',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '0.75rem',
  lineHeight: '1.2',
  backgroundColor: getAppointmentColor(status, theme),
  color: theme.palette.getContrastText(getAppointmentColor(status, theme)),
  boxShadow: theme.shadows[1],
  '&:hover': {
    boxShadow: theme.shadows[3],
    transform: 'translateY(-1px)',
  },
  transition: 'all 0.2s ease-in-out',
}));

function getAppointmentColor(status, theme) {
  switch (status) {
    case 'scheduled': return theme.palette.info.light;
    case 'confirmed': return theme.palette.primary.light;
    case 'arrived': return theme.palette.warning.light;
    case 'completed': return theme.palette.success.light;
    case 'cancelled': return theme.palette.error.light;
    default: return theme.palette.grey[300];
  }
}

const OpenDentalCalendar = ({ height = 600 }) => {
  const theme = useTheme();
  
  // State management
  const [currentDate, setCurrentDate] = useState(new Date());
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [odEnabled, setOdEnabled] = useState(false);
  const [selectedAppointment, setSelectedAppointment] = useState(null);
  const [appointmentDetailsOpen, setAppointmentDetailsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  
  // Refs for cleanup
  const refreshTimer = useRef(null);
  const visibilityTimer = useRef(null);

  // Time slots configuration
  const timeSlots = [
    '8:00 AM', '8:15 AM', '8:30 AM', '8:45 AM',
    '9:00 AM', '9:15 AM', '9:30 AM', '9:45 AM',
    '10:00 AM', '10:15 AM', '10:30 AM', '10:45 AM',
    '11:00 AM', '11:15 AM', '11:30 AM', '11:45 AM',
    '12:00 PM', '12:15 PM', '12:30 PM', '12:45 PM',
    '1:00 PM', '1:15 PM', '1:30 PM', '1:45 PM',
    '2:00 PM', '2:15 PM', '2:30 PM', '2:45 PM',
    '3:00 PM', '3:15 PM', '3:30 PM', '3:45 PM',
    '4:00 PM', '4:15 PM', '4:30 PM', '4:45 PM',
    '5:00 PM', '5:15 PM', '5:30 PM', '5:45 PM',
  ];

  // Check Open Dental health on mount
  useEffect(() => {
    const checkOdHealth = async () => {
      try {
        await openDentalApi.getHealth();
        setOdEnabled(true);
      } catch (error) {
        console.log('Open Dental not available, using mock data');
        setOdEnabled(false);
      }
    };
    
    checkOdHealth();
  }, []);

  // Auto-refresh logic
  useEffect(() => {
    if (autoRefreshEnabled && !loading) {
      refreshTimer.current = setInterval(() => {
        if (!document.hidden) {
          fetchAppointments(false);
        }
      }, 300000); // 5 minutes

      return () => {
        if (refreshTimer.current) {
          clearInterval(refreshTimer.current);
        }
      };
    }
  }, [autoRefreshEnabled, loading, fetchAppointments]);

  // Page visibility optimization
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && autoRefreshEnabled) {
        clearTimeout(visibilityTimer.current);
        visibilityTimer.current = setTimeout(() => {
          fetchAppointments(false);
        }, 1000);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (visibilityTimer.current) {
        clearTimeout(visibilityTimer.current);
      }
    };
  }, [autoRefreshEnabled, fetchAppointments]);

  // Initial data load
  useEffect(() => {
    fetchAppointments();
  }, [currentDate]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (refreshTimer.current) {
        clearInterval(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, []);

  const fetchAppointments = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true);
      setError(null);

      const startDate = new Date(currentDate);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(currentDate);
      endDate.setHours(23, 59, 59, 999);
      
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
    const today = new Date(currentDate);
    
    // Generate appointments for the selected day only
    for (let i = 0; i < 12; i++) {
      const hour = 8 + Math.floor(Math.random() * 10);
      const minute = Math.floor(Math.random() * 4) * 15; // 0, 15, 30, 45
      
      appointments.push({
        id: `mock-${i}`,
        patientName: `Patient ${i + 1}`,
        patientPhone: `+1-555-${String(Math.floor(Math.random() * 9000) + 1000)}`,
        appointmentType: ['Checkup', 'Cleaning', 'Consultation', 'Emergency', 'Crown Prep', 'Root Canal'][Math.floor(Math.random() * 6)],
        duration: [15, 30, 45, 60][Math.floor(Math.random() * 4)],
        providerName: ['Dr. Smith', 'Dr. Johnson', 'Dr. Brown', 'Dr. Wilson'][Math.floor(Math.random() * 4)],
        roomName: `Op ${Math.floor(Math.random() * 6) + 1}`,
        status: ['scheduled', 'confirmed', 'arrived', 'completed'][Math.floor(Math.random() * 4)],
        dateTime: new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, minute),
        notes: Math.random() > 0.7 ? 'Special instructions needed' : '',
        isEmergency: Math.random() > 0.9,
      });
    }
    
    return appointments.sort((a, b) => a.dateTime - b.dateTime);
  };

  // Get unique providers/operatories
  const getProviders = () => {
    const providersSet = new Set();
    appointments.forEach(apt => {
      providersSet.add(`${apt.providerName} (${apt.roomName})`);
    });
    return Array.from(providersSet).sort();
  };

  // Get appointments for a specific time slot and provider
  const getAppointmentsForSlot = (timeSlot, provider) => {
    const [time, period] = timeSlot.split(' ');
    const [hour, minute] = time.split(':').map(Number);
    const adjustedHour = period === 'PM' && hour !== 12 ? hour + 12 : (period === 'AM' && hour === 12 ? 0 : hour);
    
    return appointments.filter(apt => {
      const aptDate = new Date(apt.dateTime);
      const aptHour = aptDate.getHours();
      const aptMinute = aptDate.getMinutes();
      const providerMatch = provider.includes(apt.providerName) && provider.includes(apt.roomName);
      
      // Check if appointment starts within this 15-minute slot
      return providerMatch && aptHour === adjustedHour && Math.floor(aptMinute / 15) * 15 === minute;
    });
  };

  const handleDateChange = (days) => {
    const newDate = new Date(currentDate);
    newDate.setDate(currentDate.getDate() + days);
    setCurrentDate(newDate);
  };

  const goToToday = () => {
    setCurrentDate(new Date());
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
      day: 'numeric' 
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

  const providers = getProviders();

  return (
    <Card sx={{ height, display: 'flex', flexDirection: 'column' }}>
      <CardHeader
        title={
          <Box display="flex" alignItems="center" gap={1}>
            <CalendarIcon />
            <Typography variant="h6" component="span">
              Schedule - {currentDate.toLocaleDateString('en-US', { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
              })}
            </Typography>
            {!odEnabled && (
              <Chip 
                label="Demo Mode" 
                color="warning" 
                size="small"
                icon={<WarningIcon />}
              />
            )}
          </Box>
        }
        action={
          <Box display="flex" gap={1}>
            <IconButton onClick={() => handleDateChange(-1)} size="small">
              <PrevIcon />
            </IconButton>
            <IconButton onClick={goToToday} size="small">
              <TodayIcon />
            </IconButton>
            <IconButton onClick={() => handleDateChange(1)} size="small">
              <NextIcon />
            </IconButton>
            <IconButton 
              onClick={() => fetchAppointments()} 
              disabled={loading}
              size="small"
            >
              {loading ? <CircularProgress size={20} /> : <RefreshIcon />}
            </IconButton>
            <IconButton 
              onClick={() => setSettingsOpen(true)} 
              size="small"
            >
              <SettingsIcon />
            </IconButton>
          </Box>
        }
      />

      <CardContent sx={{ flex: 1, p: 0, overflow: 'hidden' }}>
        {error && (
          <Alert severity="warning" sx={{ m: 2 }}>
            {error} - Showing sample data for demonstration.
          </Alert>
        )}

        {lastRefresh && (
          <Box px={2} py={1}>
            <Typography variant="caption" color="textSecondary">
              Last updated: {lastRefresh.toLocaleTimeString()}
              {autoRefreshEnabled && ' • Auto-refresh enabled'}
            </Typography>
          </Box>
        )}

        <TableContainer sx={{ height: 'calc(100% - 60px)', overflow: 'auto' }}>
          <Table stickyHeader size="small">
            <TableHead>
              <TableRow>
                <TimeSlotCell>Time</TimeSlotCell>
                {providers.map((provider) => (
                  <ProviderHeaderCell key={provider}>
                    {provider}
                  </ProviderHeaderCell>
                ))}
                {providers.length === 0 && (
                  <ProviderHeaderCell>
                    No appointments found
                  </ProviderHeaderCell>
                )}
              </TableRow>
            </TableHead>
            <TableBody>
              {timeSlots.map((timeSlot) => (
                <TableRow key={timeSlot}>
                  <TimeSlotCell>{timeSlot}</TimeSlotCell>
                  {providers.map((provider) => {
                    const slotAppointments = getAppointmentsForSlot(timeSlot, provider);
                    return (
                      <AppointmentCell key={`${timeSlot}-${provider}`}>
                        {slotAppointments.map((appointment) => (
                          <AppointmentBlock
                            key={appointment.id}
                            status={appointment.status}
                            onClick={() => handleAppointmentClick(appointment)}
                            elevation={1}
                          >
                            <Typography variant="caption" display="block" fontWeight="bold">
                              {appointment.patientName}
                            </Typography>
                            <Typography variant="caption" display="block">
                              {appointment.appointmentType}
                            </Typography>
                            <Typography variant="caption" display="block" sx={{ opacity: 0.8 }}>
                              {appointment.duration}min
                            </Typography>
                          </AppointmentBlock>
                        ))}
                      </AppointmentCell>
                    );
                  })}
                  {providers.length === 0 && (
                    <AppointmentCell>
                      {/* Empty cell when no providers */}
                    </AppointmentCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
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
              Refresh is paused when the page is not visible to conserve bandwidth.
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