/**
 * Live Monitor Page
 * 
 * Real-time dashboard for monitoring active AI calls.
 */

import React, { useState } from 'react';
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  Alert,
  AlertTitle,
  Chip,
  IconButton,
  Button,
  Drawer,
  Divider,
  Stack,
  Skeleton,
  Badge,
  Tooltip,
  useTheme,
} from '@mui/material';
import {
  Phone as PhoneIcon,
  PhoneInTalk as ActiveCallIcon,
  Warning as EmergencyIcon,
  Refresh as RefreshIcon,
  Close as CloseIcon,
  Wifi as ConnectedIcon,
  WifiOff as DisconnectedIcon,
  PlayArrow as PlayIcon,
} from '@mui/icons-material';
import { useLiveCalls } from '../hooks/useLiveCalls';
import { useSocket } from '../contexts/SocketContext';
import LiveCallCard from '../components/LiveCalls/LiveCallCard';
import LiveTranscript from '../components/LiveCalls/LiveTranscript';
import SentimentGauge from '../components/LiveCalls/SentimentGauge';

const LiveMonitor = () => {
  const theme = useTheme();
  const { isConnected, connectionError } = useSocket();
  const {
    liveCalls,
    activeCount,
    emergencyCount,
    selectedCall,
    selectCall,
    clearSelection,
    loading,
    refresh,
  } = useLiveCalls();

  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleCallSelect = (callId) => {
    selectCall(callId);
    setDrawerOpen(true);
  };

  const handleDrawerClose = () => {
    setDrawerOpen(false);
    clearSelection();
  };

  const formatDuration = (seconds) => {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Sort calls: emergencies first, then by start time
  const sortedCalls = [...liveCalls].sort((a, b) => {
    if (a.is_emergency && !b.is_emergency) return -1;
    if (!a.is_emergency && b.is_emergency) return 1;
    return new Date(b.started_at) - new Date(a.started_at);
  });

  return (
    <Box sx={{ width: '100%' }}>
      {/* Connection Status */}
      {!isConnected && (
        <Alert 
          severity="warning" 
          sx={{ mb: 3 }}
          icon={<DisconnectedIcon />}
        >
          <AlertTitle>Connection Lost</AlertTitle>
          {connectionError || 'Attempting to reconnect to server...'}
        </Alert>
      )}

      {/* Emergency Alert */}
      {emergencyCount > 0 && (
        <Alert 
          severity="error" 
          sx={{ 
            mb: 3, 
            border: 2, 
            borderColor: 'error.main',
            animation: 'pulse 2s infinite',
            '@keyframes pulse': {
              '0%, 100%': { opacity: 1 },
              '50%': { opacity: 0.8 },
            },
          }}
          icon={
            <Badge badgeContent={emergencyCount} color="error">
              <EmergencyIcon />
            </Badge>
          }
        >
          <AlertTitle sx={{ fontWeight: 'bold' }}>
            🚨 {emergencyCount} Emergency Call{emergencyCount > 1 ? 's' : ''} in Progress
          </AlertTitle>
          <Typography variant="body2">
            Immediate attention required. Click on the call to view details.
          </Typography>
        </Alert>
      )}

      {/* Header */}
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Box>
          <Typography variant="h4" fontWeight="bold">
            🔴 Live Call Monitor
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Real-time view of active AI-handled calls
          </Typography>
        </Box>

        <Box display="flex" alignItems="center" gap={2}>
          {/* Connection Status */}
          <Chip
            icon={isConnected ? <ConnectedIcon /> : <DisconnectedIcon />}
            label={isConnected ? 'Connected' : 'Disconnected'}
            color={isConnected ? 'success' : 'error'}
            variant="outlined"
          />

          {/* Refresh Button */}
          <Tooltip title="Refresh">
            <IconButton onClick={refresh} disabled={loading}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Stats Cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Card sx={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box sx={{ color: 'white' }}>
                  <Typography color="inherit" variant="body2" gutterBottom>
                    Active Calls
                  </Typography>
                  <Typography variant="h3" fontWeight="bold">
                    {activeCount}
                  </Typography>
                </Box>
                <ActiveCallIcon sx={{ color: 'white', fontSize: 48, opacity: 0.8 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card sx={{ 
            background: emergencyCount > 0 
              ? 'linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%)'
              : 'linear-gradient(135deg, #a8e6cf 0%, #88d8a3 100%)'
          }}>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box sx={{ color: 'white' }}>
                  <Typography color="inherit" variant="body2" gutterBottom>
                    Emergency Calls
                  </Typography>
                  <Typography variant="h3" fontWeight="bold">
                    {emergencyCount}
                  </Typography>
                </Box>
                <EmergencyIcon sx={{ color: 'white', fontSize: 48, opacity: 0.8 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Avg Duration
                  </Typography>
                  <Typography variant="h4" fontWeight="bold" color="primary">
                    {liveCalls.length > 0 
                      ? formatDuration(
                          Math.round(
                            liveCalls.reduce((sum, c) => sum + (c.duration || 0), 0) / liveCalls.length
                          )
                        )
                      : '--:--'}
                  </Typography>
                </Box>
                <PhoneIcon sx={{ fontSize: 48, opacity: 0.3 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Positive Sentiment
                  </Typography>
                  <Typography variant="h4" fontWeight="bold" color="success.main">
                    {liveCalls.length > 0 
                      ? Math.round(
                          (liveCalls.filter(c => c.sentiment === 'positive').length / liveCalls.length) * 100
                        ) + '%'
                      : '--%'}
                  </Typography>
                </Box>
                <SentimentGauge sentiment="positive" size="small" showLabel={false} />
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Live Calls List */}
      <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <ActiveCallIcon color="error" />
        Active Calls ({activeCount})
      </Typography>

      {loading ? (
        <Box>
          {[1, 2, 3].map((i) => (
            <Card key={i} sx={{ mb: 2 }}>
              <CardContent>
                <Skeleton variant="rectangular" height={100} />
              </CardContent>
            </Card>
          ))}
        </Box>
      ) : sortedCalls.length === 0 ? (
        <Card sx={{ textAlign: 'center', py: 6 }}>
          <CardContent>
            <PhoneIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No Active Calls
            </Typography>
            <Typography variant="body2" color="text.secondary">
              When AI agents handle incoming calls, they will appear here in real-time.
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Box>
          {sortedCalls.map((call) => (
            <LiveCallCard
              key={call.call_id}
              call={call}
              onSelect={handleCallSelect}
              isSelected={selectedCall?.call_id === call.call_id}
            />
          ))}
        </Box>
      )}

      {/* Call Details Drawer */}
      <Drawer
        anchor="right"
        open={drawerOpen}
        onClose={handleDrawerClose}
        sx={{
          '& .MuiDrawer-paper': {
            width: { xs: '100%', sm: '500px', md: '600px' },
          },
        }}
      >
        {selectedCall && (
          <Box sx={{ p: 3, height: '100%', display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
              <Box display="flex" alignItems="center" gap={2}>
                <Box
                  sx={{
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    bgcolor: 'error.main',
                    animation: 'pulse 1.5s infinite',
                    '@keyframes pulse': {
                      '0%, 100%': { transform: 'scale(1)', opacity: 1 },
                      '50%': { transform: 'scale(1.2)', opacity: 0.7 },
                    },
                  }}
                />
                <Typography variant="h5" fontWeight="bold">
                  Live Call Details
                </Typography>
              </Box>
              <IconButton onClick={handleDrawerClose}>
                <CloseIcon />
              </IconButton>
            </Box>

            {/* Emergency Badge */}
            {selectedCall.is_emergency && (
              <Alert severity="error" sx={{ mb: 2 }}>
                <AlertTitle>🚨 Emergency Call</AlertTitle>
                This call has been flagged as an emergency based on conversation content.
              </Alert>
            )}

            {/* Call Info */}
            <Card variant="outlined" sx={{ mb: 2 }}>
              <CardContent>
                <Grid container spacing={2}>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary">
                      Caller
                    </Typography>
                    <Typography variant="body1" fontWeight="bold">
                      {selectedCall.caller_name || 'Unknown'}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {selectedCall.caller_number}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary">
                      Duration
                    </Typography>
                    <Typography variant="h5" fontWeight="bold" color="primary">
                      {formatDuration(selectedCall.duration)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary">
                      Agent
                    </Typography>
                    <Typography variant="body1">
                      {selectedCall.agent_name || 'AI Agent'}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary">
                      Sentiment
                    </Typography>
                    <Box mt={0.5}>
                      <SentimentGauge sentiment={selectedCall.sentiment} size="medium" />
                    </Box>
                  </Grid>
                </Grid>
              </CardContent>
            </Card>

            {/* Live Transcript */}
            <Typography variant="h6" gutterBottom>
              📝 Live Transcript
            </Typography>
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <LiveTranscript
                transcript={selectedCall.transcript || []}
                isTyping={true}
                maxHeight="calc(100vh - 450px)"
              />
            </Box>
          </Box>
        )}
      </Drawer>
    </Box>
  );
};

export default LiveMonitor;

