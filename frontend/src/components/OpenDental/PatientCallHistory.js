/**
 * Patient Call History
 * 
 * Displays all calls associated with a specific patient,
 * with summary statistics and timeline view.
 */

import React, { useState, useEffect } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Avatar,
  Chip,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  CircularProgress,
  Alert,
  Divider,
  IconButton,
  Tooltip,
  Button,
  Grid,
  Paper,
} from '@mui/material';
import {
  Person as PersonIcon,
  Phone as PhoneIcon,
  Email as EmailIcon,
  SmartToy as AIIcon,
  SupportAgent as StaffIcon,
  AccessTime as TimeIcon,
  TrendingUp as TrendingUpIcon,
  TrendingDown as TrendingDownIcon,
  Warning as WarningIcon,
  CheckCircle as CheckIcon,
  Refresh as RefreshIcon,
  PlayArrow as PlayIcon,
  ArrowForward as ArrowIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { openDentalSyncApi } from '../../services/api';

const PatientCallHistory = ({ patientId, compact = false }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const navigate = useNavigate();

  // Fetch patient call history
  const fetchHistory = async () => {
    if (!patientId) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const result = await openDentalSyncApi.getPatientCalls(patientId, compact ? 10 : 50);
      setData(result);
    } catch (err) {
      console.error('Failed to fetch patient call history:', err);
      setError(err.response?.data?.error || 'Failed to load call history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, [patientId]);

  // Format duration
  const formatDuration = (seconds) => {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Get sentiment color
  const getSentimentColor = (sentiment) => {
    switch (sentiment) {
      case 'positive': return 'success';
      case 'negative': return 'error';
      default: return 'default';
    }
  };

  // Render loading state
  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  // Render error state
  if (error) {
    return (
      <Alert 
        severity="error" 
        action={
          <Button color="inherit" size="small" onClick={fetchHistory}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  }

  // Render empty state
  if (!data || data.calls?.length === 0) {
    return (
      <Box textAlign="center" py={4}>
        <PhoneIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 2 }} />
        <Typography color="text.secondary">
          No calls found for this patient
        </Typography>
      </Box>
    );
  }

  const { patient, calls, stats } = data;

  return (
    <Box>
      {/* Patient Header */}
      {patient && !compact && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Box display="flex" alignItems="center" gap={2}>
              <Avatar sx={{ width: 56, height: 56, bgcolor: 'primary.main' }}>
                <PersonIcon sx={{ fontSize: 32 }} />
              </Avatar>
              <Box flex={1}>
                <Typography variant="h6">
                  {patient.fullName || `${patient.firstName} ${patient.lastName}`}
                </Typography>
                <Box display="flex" gap={2} mt={0.5}>
                  {patient.phone && (
                    <Box display="flex" alignItems="center" gap={0.5}>
                      <PhoneIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                      <Typography variant="body2" color="text.secondary">
                        {patient.phone}
                      </Typography>
                    </Box>
                  )}
                  {patient.email && (
                    <Box display="flex" alignItems="center" gap={0.5}>
                      <EmailIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                      <Typography variant="body2" color="text.secondary">
                        {patient.email}
                      </Typography>
                    </Box>
                  )}
                </Box>
              </Box>
              <Tooltip title="Refresh">
                <IconButton onClick={fetchHistory}>
                  <RefreshIcon />
                </IconButton>
              </Tooltip>
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Statistics */}
      {stats && !compact && (
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid item xs={6} md={3}>
            <Paper sx={{ p: 2, textAlign: 'center' }}>
              <Typography variant="h4" color="primary">
                {stats.totalCalls}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Total Calls
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={6} md={3}>
            <Paper sx={{ p: 2, textAlign: 'center' }}>
              <Box display="flex" alignItems="center" justifyContent="center" gap={0.5}>
                <AIIcon color="info" />
                <Typography variant="h4" color="info.main">
                  {stats.aiCalls}
                </Typography>
              </Box>
              <Typography variant="body2" color="text.secondary">
                AI Calls
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={6} md={3}>
            <Paper sx={{ p: 2, textAlign: 'center' }}>
              <Box display="flex" alignItems="center" justifyContent="center" gap={0.5}>
                <StaffIcon color="secondary" />
                <Typography variant="h4" color="secondary.main">
                  {stats.staffCalls}
                </Typography>
              </Box>
              <Typography variant="body2" color="text.secondary">
                Staff Calls
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={6} md={3}>
            <Paper sx={{ p: 2, textAlign: 'center' }}>
              <Box display="flex" alignItems="center" justifyContent="center" gap={0.5}>
                <WarningIcon color="error" />
                <Typography variant="h4" color="error.main">
                  {stats.emergencyCalls}
                </Typography>
              </Box>
              <Typography variant="body2" color="text.secondary">
                Emergency Calls
              </Typography>
            </Paper>
          </Grid>
        </Grid>
      )}

      {/* Call List */}
      <Typography variant="subtitle2" color="text.secondary" gutterBottom>
        {compact ? 'Recent Calls' : 'Call History'}
        {stats?.lastCallDate && (
          <Typography component="span" variant="caption" sx={{ ml: 1 }}>
            (Last call: {new Date(stats.lastCallDate).toLocaleDateString()})
          </Typography>
        )}
      </Typography>

      <List disablePadding>
        {calls.map((call, index) => (
          <React.Fragment key={call.id}>
            <ListItem
              sx={{
                borderRadius: 1,
                mb: 1,
                bgcolor: 'background.paper',
                border: '1px solid',
                borderColor: 'divider',
                cursor: 'pointer',
                '&:hover': { bgcolor: 'action.hover' }
              }}
              onClick={() => navigate(`/calls/${call.id}`)}
            >
              <ListItemAvatar>
                <Avatar sx={{ 
                  bgcolor: call.handler_type === 'ai' ? 'info.main' : 'secondary.main' 
                }}>
                  {call.handler_type === 'ai' ? <AIIcon /> : <StaffIcon />}
                </Avatar>
              </ListItemAvatar>
              
              <ListItemText
                primary={
                  <Box display="flex" alignItems="center" gap={1}>
                    <Typography fontWeight="medium">
                      {call.summary?.substring(0, 60) || call.call_reason || 'Call'}
                      {call.summary?.length > 60 && '...'}
                    </Typography>
                    {call.is_emergency && (
                      <Chip 
                        size="small" 
                        label="Emergency" 
                        color="error" 
                        icon={<WarningIcon />}
                      />
                    )}
                  </Box>
                }
                secondary={
                  <Box component="span" display="flex" gap={2} alignItems="center" mt={0.5}>
                    <Box component="span" display="flex" alignItems="center" gap={0.5}>
                      <TimeIcon sx={{ fontSize: 14 }} />
                      <Typography variant="caption">
                        {new Date(call.call_date).toLocaleString()}
                      </Typography>
                    </Box>
                    <Typography variant="caption">
                      {formatDuration(call.duration_seconds)}
                    </Typography>
                    <Chip 
                      size="small" 
                      label={call.sentiment || 'neutral'}
                      color={getSentimentColor(call.sentiment)}
                      variant="outlined"
                    />
                    <Chip 
                      size="small" 
                      label={call.source === 'retell' ? 'Retell AI' : 'Mango'}
                      variant="outlined"
                    />
                  </Box>
                }
              />
              
              <Box display="flex" alignItems="center" gap={1}>
                {call.od_sync_status === 'synced' && (
                  <Tooltip title="Synced to Open Dental">
                    <CheckIcon color="success" fontSize="small" />
                  </Tooltip>
                )}
                <ArrowIcon color="action" />
              </Box>
            </ListItem>
          </React.Fragment>
        ))}
      </List>

      {/* Show More */}
      {compact && calls.length >= 10 && (
        <Box textAlign="center" mt={2}>
          <Button 
            variant="outlined" 
            onClick={() => navigate(`/patients/${patientId}/calls`)}
          >
            View All Calls
          </Button>
        </Box>
      )}
    </Box>
  );
};

export default PatientCallHistory;

