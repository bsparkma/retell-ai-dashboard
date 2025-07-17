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

const Calendar = () => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [stats, setStats] = useState({
    todayCount: 0,
    weekCount: 0,
    pendingCount: 0,
    completedCount: 0,
  });

  useEffect(() => {
    // In a real implementation, these would come from the API
    setStats({
      todayCount: 12,
      weekCount: 67,
      pendingCount: 3,
      completedCount: 8,
    });
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

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <Box mb={3}>
        <Typography variant="h4" component="h1" gutterBottom>
          📅 Appointment Calendar
        </Typography>
        <Typography variant="body1" color="textSecondary">
          Real-time sync with Open Dental scheduling system
        </Typography>
      </Box>

      {/* Quick Stats */}
      <Box mb={3}>
        <QuickStats />
      </Box>

      {/* Calendar Component */}
      <OpenDentalCalendar height={700} />

      {/* Additional Info */}
      <Box mt={3}>
        <Alert severity="info">
          <Typography variant="body2">
            📊 This calendar automatically syncs with your Open Dental system every 5 minutes. 
            The refresh rate has been optimized for medical practices to balance real-time updates with system performance.
          </Typography>
        </Alert>
      </Box>
    </Container>
  );
};

export default Calendar; 