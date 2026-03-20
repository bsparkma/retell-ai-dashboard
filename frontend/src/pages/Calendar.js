import React, { useState, useEffect } from 'react';
import {
  Container,
  Typography,
  Box,
  Grid,
  Card,
  CardContent,
  Alert,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import {
  CalendarToday as CalendarIcon,
  Schedule as ScheduleIcon,
  Person as PersonIcon,
  Event as EventIcon,
} from '@mui/icons-material';
import OpenDentalCalendar from '../components/OpenDentalCalendar';
import { openDentalApi } from '../services/api';

const Calendar = () => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [stats, setStats] = useState({
    todayCount: 0,
    weekCount: 0,
    pendingCount: 0,
    completedCount: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Fetch real Open Dental statistics
  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        
        // Get Monday of current week
        const monday = new Date(today);
        const day = monday.getDay();
        const diff = monday.getDate() - day + (day === 0 ? -6 : 1);
        monday.setDate(diff);
        
        // Get Sunday of current week
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        
        // Fetch today's appointments
        const todayResponse = await openDentalApi.getCalendar({ 
          date: todayStr 
        });
        
        // Fetch week's appointments
        const weekResponse = await openDentalApi.getAppointmentRange({
          startDate: monday.toISOString().split('T')[0],
          endDate: sunday.toISOString().split('T')[0]
        });
        
        const todayAppointments = todayResponse.appointments || [];
        const weekAppointments = weekResponse.appointments || [];
        
        // Calculate stats
        const pendingCount = todayAppointments.filter(apt => 
          apt.status === 'scheduled' || apt.status === 'confirmed'
        ).length;
        
        const completedCount = todayAppointments.filter(apt => 
          apt.status === 'completed'
        ).length;
        
        setStats({
          todayCount: todayAppointments.length,
          weekCount: weekAppointments.length,
          pendingCount,
          completedCount,
        });
        
      } catch (err) {
        console.warn('Failed to fetch Open Dental stats, using defaults:', err);
        // Fallback to default stats if API fails
        setStats({
          todayCount: 0,
          weekCount: 0,
          pendingCount: 0,
          completedCount: 0,
        });
        setError('Unable to connect to Open Dental. Showing calendar with limited data.');
      } finally {
        setLoading(false);
      }
    };
    
    fetchStats();
  }, []);

  // Quick stats component
  const QuickStats = () => (
    <Grid container spacing={2}>
      <Grid item xs={12} sm={6} md={3}>
        <Card>
          <CardContent>
            <Box display="flex" alignItems="center">
              <EventIcon color="primary" sx={{ mr: 1, fontSize: 30 }} />
              <Box>
                <Typography variant="h6">{stats.todayCount}</Typography>
                <Typography variant="body2" color="textSecondary">
                  Today's Appointments
                </Typography>
              </Box>
            </Box>
          </CardContent>
        </Card>
      </Grid>
      
      <Grid item xs={12} sm={6} md={3}>
        <Card>
          <CardContent>
            <Box display="flex" alignItems="center">
              <CalendarIcon color="info" sx={{ mr: 1, fontSize: 30 }} />
              <Box>
                <Typography variant="h6">{stats.weekCount}</Typography>
                <Typography variant="body2" color="textSecondary">
                  This Week
                </Typography>
              </Box>
            </Box>
          </CardContent>
        </Card>
      </Grid>
      
      <Grid item xs={12} sm={6} md={3}>
        <Card>
          <CardContent>
            <Box display="flex" alignItems="center">
              <ScheduleIcon color="warning" sx={{ mr: 1, fontSize: 30 }} />
              <Box>
                <Typography variant="h6">{stats.pendingCount}</Typography>
                <Typography variant="body2" color="textSecondary">
                  Pending Confirmation
                </Typography>
              </Box>
            </Box>
          </CardContent>
        </Card>
      </Grid>
      
      <Grid item xs={12} sm={6} md={3}>
        <Card>
          <CardContent>
            <Box display="flex" alignItems="center">
              <PersonIcon color="success" sx={{ mr: 1, fontSize: 30 }} />
              <Box>
                <Typography variant="h6">{stats.completedCount}</Typography>
                <Typography variant="body2" color="textSecondary">
                  Completed Today
                </Typography>
              </Box>
            </Box>
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );

  if (loading) {
    return (
      <Box sx={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <Box textAlign="center">
          <Typography variant="h6" gutterBottom>Loading Open Dental Calendar...</Typography>
          <Typography variant="body2" color="textSecondary">Connecting to your dental practice management system</Typography>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%' }}>
      <Box mb={3}>
        <Typography variant="h4" component="h1" gutterBottom>
          📅 Open Dental Calendar
        </Typography>
        <Typography variant="body1" color="textSecondary">
          {error ? 'Demo mode - Connect your Open Dental database for live data' : 'Real-time sync with your Open Dental scheduling system'}
        </Typography>
      </Box>

      {error && (
        <Alert severity="warning" sx={{ mb: 3, maxWidth: '1200px' }}>
          {error}
        </Alert>
      )}

      {/* Quick Stats */}
      <Box mb={3} sx={{ maxWidth: '1200px' }}>
        <QuickStats />
      </Box>

      {/* Calendar Component */}
      <Box sx={{ maxWidth: '1200px' }}>
        <OpenDentalCalendar height={700} />
      </Box>

      {/* Additional Info */}
      <Box mt={3} sx={{ maxWidth: '1200px' }}>
        <Alert severity={error ? "warning" : "info"}>
          <Typography variant="body2">
            {error ? 
              "📋 To connect your Open Dental database, set the OPENDENTAL_DB_URL environment variable with your database connection string and restart the backend service." :
              "📊 This calendar automatically syncs with your Open Dental system every 5 minutes. The refresh rate has been optimized for dental practices to balance real-time updates with system performance."
            }
          </Typography>
        </Alert>
      </Box>
    </Box>
  );
};

export default Calendar; 