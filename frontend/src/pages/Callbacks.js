/**
 * Callbacks Page
 * 
 * Smart callback queue manager with priority sorting and SLA tracking.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  Button,
  Chip,
  IconButton,
  Avatar,
  Badge,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Alert,
  AlertTitle,
  CircularProgress,
  Divider,
} from '@mui/material';
import {
  Phone as PhoneIcon,
  PhoneCallback as CallbackIcon,
  Warning as WarningIcon,
  CheckCircle as CompleteIcon,
  Schedule as ScheduleIcon,
  Refresh as RefreshIcon,
  Add as AddIcon,
  Close as CloseIcon,
  AccessTime as TimeIcon,
  PersonOutline as PersonIcon,
  Notes as NotesIcon,
} from '@mui/icons-material';
import { useSocket } from '../contexts/SocketContext';
import config from '../config/env';

// Priority configuration
const PRIORITY_CONFIG = {
  emergency: {
    color: 'error',
    icon: '🚨',
    label: 'Emergency',
    bgColor: '#ffebee',
  },
  high: {
    color: 'warning',
    icon: '🔴',
    label: 'High',
    bgColor: '#fff3e0',
  },
  medium: {
    color: 'info',
    icon: '🟡',
    label: 'Medium',
    bgColor: '#e3f2fd',
  },
  low: {
    color: 'success',
    icon: '🟢',
    label: 'Low',
    bgColor: '#e8f5e9',
  },
};

/**
 * Single Callback Card Component
 */
const CallbackCard = ({ callback, onComplete, onAttempt }) => {
  const priorityConfig = PRIORITY_CONFIG[callback.priority] || PRIORITY_CONFIG.medium;
  const isOverdue = new Date(callback.due_at) < new Date();
  
  const formatTimeAgo = (dateStr) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    
    if (diffMins < 0) {
      // Future
      const futureMins = Math.abs(diffMins);
      if (futureMins < 60) return `in ${futureMins}m`;
      return `in ${Math.floor(futureMins / 60)}h`;
    }
    
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${Math.floor(diffHours / 24)}d ago`;
  };

  return (
    <Card
      sx={{
        mb: 2,
        borderLeft: 4,
        borderColor: `${priorityConfig.color}.main`,
        bgcolor: isOverdue ? '#fff5f5' : 'background.paper',
        transition: 'all 0.2s ease',
        '&:hover': {
          boxShadow: 4,
          transform: 'translateX(4px)',
        },
      }}
    >
      <CardContent>
        <Grid container spacing={2} alignItems="center">
          {/* Priority Badge & Avatar */}
          <Grid item>
            <Badge
              overlap="circular"
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              badgeContent={
                isOverdue ? (
                  <Tooltip title="Overdue!">
                    <WarningIcon sx={{ fontSize: 16, color: 'error.main' }} />
                  </Tooltip>
                ) : null
              }
            >
              <Avatar
                sx={{
                  width: 56,
                  height: 56,
                  bgcolor: `${priorityConfig.color}.light`,
                  color: `${priorityConfig.color}.dark`,
                  fontSize: 24,
                }}
              >
                {callback.caller_name?.charAt(0)?.toUpperCase() || '?'}
              </Avatar>
            </Badge>
          </Grid>

          {/* Caller Info */}
          <Grid item xs>
            <Box display="flex" alignItems="center" gap={1} mb={0.5}>
              <Typography variant="h6" fontWeight="bold">
                {callback.caller_name}
              </Typography>
              <Chip
                label={priorityConfig.label}
                size="small"
                color={priorityConfig.color}
                icon={<span>{priorityConfig.icon}</span>}
              />
              {isOverdue && (
                <Chip
                  label="OVERDUE"
                  size="small"
                  color="error"
                  variant="outlined"
                />
              )}
            </Box>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              {callback.caller_number}
            </Typography>
            <Typography variant="body2">
              {callback.reason}
            </Typography>
            {callback.notes && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                📝 {callback.notes}
              </Typography>
            )}
          </Grid>

          {/* Time & Status */}
          <Grid item>
            <Box textAlign="right">
              <Typography 
                variant="body2" 
                color={isOverdue ? 'error.main' : 'text.secondary'}
                fontWeight={isOverdue ? 'bold' : 'normal'}
              >
                <TimeIcon sx={{ fontSize: 14, verticalAlign: 'middle', mr: 0.5 }} />
                Due: {formatTimeAgo(callback.due_at)}
              </Typography>
              {callback.attempts > 0 && (
                <Typography variant="caption" color="text.secondary" display="block">
                  {callback.attempts} attempt{callback.attempts > 1 ? 's' : ''}
                </Typography>
              )}
            </Box>
          </Grid>

          {/* Actions */}
          <Grid item>
            <Box display="flex" gap={1}>
              <Tooltip title="Log attempt">
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => onAttempt(callback)}
                >
                  <PhoneIcon sx={{ fontSize: 18 }} />
                </Button>
              </Tooltip>
              <Tooltip title="Mark complete">
                <Button
                  variant="contained"
                  size="small"
                  color="success"
                  onClick={() => onComplete(callback)}
                >
                  <CompleteIcon sx={{ fontSize: 18 }} />
                </Button>
              </Tooltip>
            </Box>
          </Grid>
        </Grid>
      </CardContent>
    </Card>
  );
};

/**
 * Main Callbacks Page
 */
const Callbacks = () => {
  const { subscribe } = useSocket();
  const [callbacks, setCallbacks] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('pending');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedCallback, setSelectedCallback] = useState(null);
  const [attemptNotes, setAttemptNotes] = useState('');

  // Fetch callbacks
  const fetchCallbacks = useCallback(async () => {
    try {
      const [callbacksRes, statsRes] = await Promise.all([
        fetch(`${config.apiUrl}/callbacks?status=${filter}`).then(r => r.json()),
        fetch(`${config.apiUrl}/callbacks/stats`).then(r => r.json()),
      ]);
      
      setCallbacks(callbacksRes.callbacks || []);
      setStats(statsRes.stats);
      setLoading(false);
    } catch (error) {
      console.error('Failed to fetch callbacks:', error);
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchCallbacks();
  }, [fetchCallbacks]);

  // Subscribe to real-time updates
  useEffect(() => {
    const unsubscribeCreated = subscribe('callback:created', (callback) => {
      setCallbacks(prev => [callback, ...prev]);
    });
    
    const unsubscribeUpdated = subscribe('callback:updated', (callback) => {
      setCallbacks(prev => prev.map(cb => cb.id === callback.id ? callback : cb));
    });
    
    const unsubscribeDeleted = subscribe('callback:deleted', (id) => {
      setCallbacks(prev => prev.filter(cb => cb.id !== id));
    });
    
    const unsubscribeStats = subscribe('callbacks:stats-updated', (newStats) => {
      setStats(newStats);
    });
    
    return () => {
      unsubscribeCreated();
      unsubscribeUpdated();
      unsubscribeDeleted();
      unsubscribeStats();
    };
  }, [subscribe]);

  const handleComplete = async (callback) => {
    try {
      await fetch(`${config.apiUrl}/callbacks/${callback.id}/attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result: 'completed', notes: 'Callback completed' }),
      });
      fetchCallbacks();
    } catch (error) {
      console.error('Failed to complete callback:', error);
    }
  };

  const handleAttempt = (callback) => {
    setSelectedCallback(callback);
    setDialogOpen(true);
  };

  const submitAttempt = async (result) => {
    try {
      await fetch(`${config.apiUrl}/callbacks/${selectedCallback.id}/attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result, notes: attemptNotes }),
      });
      setDialogOpen(false);
      setSelectedCallback(null);
      setAttemptNotes('');
      fetchCallbacks();
    } catch (error) {
      console.error('Failed to log attempt:', error);
    }
  };

  const overdueCount = callbacks.filter(cb => 
    cb.status === 'pending' && new Date(cb.due_at) < new Date()
  ).length;

  const emergencyCount = callbacks.filter(cb => 
    cb.priority === 'emergency' && cb.status === 'pending'
  ).length;

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%' }}>
      {/* Emergency Alert */}
      {emergencyCount > 0 && (
        <Alert 
          severity="error" 
          sx={{ 
            mb: 3, 
            border: 2, 
            borderColor: 'error.main',
          }}
        >
          <AlertTitle sx={{ fontWeight: 'bold' }}>
            🚨 {emergencyCount} Emergency Callback{emergencyCount > 1 ? 's' : ''} Pending
          </AlertTitle>
          These require immediate attention!
        </Alert>
      )}

      {/* Header */}
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Box>
          <Typography variant="h4" fontWeight="bold">
            📞 Callback Queue
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Manage and track pending callbacks
          </Typography>
        </Box>
        <Box display="flex" gap={1}>
          <IconButton onClick={fetchCallbacks}>
            <RefreshIcon />
          </IconButton>
        </Box>
      </Box>

      {/* Stats Cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={6} sm={3}>
          <Card sx={{ bgcolor: 'primary.light' }}>
            <CardContent sx={{ textAlign: 'center', py: 2 }}>
              <Typography variant="h3" fontWeight="bold" color="primary.dark">
                {stats?.pending || 0}
              </Typography>
              <Typography variant="body2" color="primary.dark">
                Pending
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={6} sm={3}>
          <Card sx={{ bgcolor: overdueCount > 0 ? 'error.light' : 'grey.100' }}>
            <CardContent sx={{ textAlign: 'center', py: 2 }}>
              <Typography 
                variant="h3" 
                fontWeight="bold" 
                color={overdueCount > 0 ? 'error.dark' : 'text.primary'}
              >
                {overdueCount}
              </Typography>
              <Typography variant="body2" color={overdueCount > 0 ? 'error.dark' : 'text.secondary'}>
                Overdue
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={6} sm={3}>
          <Card sx={{ bgcolor: 'warning.light' }}>
            <CardContent sx={{ textAlign: 'center', py: 2 }}>
              <Typography variant="h3" fontWeight="bold" color="warning.dark">
                {stats?.by_priority?.emergency || 0}
              </Typography>
              <Typography variant="body2" color="warning.dark">
                Emergency
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={6} sm={3}>
          <Card sx={{ bgcolor: 'success.light' }}>
            <CardContent sx={{ textAlign: 'center', py: 2 }}>
              <Typography variant="h3" fontWeight="bold" color="success.dark">
                {stats?.completed || 0}
              </Typography>
              <Typography variant="body2" color="success.dark">
                Completed Today
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Filter */}
      <Box display="flex" gap={1} mb={3}>
        {['pending', 'completed', 'failed'].map((status) => (
          <Chip
            key={status}
            label={status.charAt(0).toUpperCase() + status.slice(1)}
            onClick={() => setFilter(status)}
            color={filter === status ? 'primary' : 'default'}
            variant={filter === status ? 'filled' : 'outlined'}
          />
        ))}
      </Box>

      {/* Callbacks List */}
      {callbacks.length === 0 ? (
        <Card sx={{ textAlign: 'center', py: 6 }}>
          <CardContent>
            <CallbackIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
            <Typography variant="h6" color="text.secondary">
              No {filter} callbacks
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {filter === 'pending' 
                ? 'Great job! All callbacks have been handled.'
                : `No callbacks with status "${filter}" found.`
              }
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Box>
          {callbacks.map((callback) => (
            <CallbackCard
              key={callback.id}
              callback={callback}
              onComplete={handleComplete}
              onAttempt={handleAttempt}
            />
          ))}
        </Box>
      )}

      {/* Attempt Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          Log Callback Attempt
          <IconButton
            onClick={() => setDialogOpen(false)}
            sx={{ position: 'absolute', right: 8, top: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          {selectedCallback && (
            <Box>
              <Typography variant="h6" gutterBottom>
                {selectedCallback.caller_name}
              </Typography>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                {selectedCallback.caller_number}
              </Typography>
              <Divider sx={{ my: 2 }} />
              <TextField
                fullWidth
                multiline
                rows={3}
                label="Notes (optional)"
                value={attemptNotes}
                onChange={(e) => setAttemptNotes(e.target.value)}
                sx={{ mb: 2 }}
              />
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2, gap: 1 }}>
          <Button
            variant="outlined"
            color="warning"
            onClick={() => submitAttempt('no_answer')}
          >
            No Answer
          </Button>
          <Button
            variant="outlined"
            color="info"
            onClick={() => submitAttempt('voicemail')}
          >
            Left Voicemail
          </Button>
          <Button
            variant="contained"
            color="success"
            onClick={() => submitAttempt('completed')}
          >
            Completed
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Callbacks;

