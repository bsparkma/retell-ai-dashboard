/**
 * Admin / Developer Dashboard
 * 
 * System monitoring, sync control, and service health status.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  CardHeader,
  Button,
  Chip,
  Alert,
  AlertTitle,
  IconButton,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Tooltip,
  CircularProgress,
  Switch,
  FormControlLabel,
} from '@mui/material';
import {
  Refresh as RefreshIcon,
  PlayArrow as StartIcon,
  Stop as StopIcon,
  Sync as SyncIcon,
  CheckCircle as HealthyIcon,
  Warning as WarningIcon,
  Error as ErrorIcon,
  Cloud as CloudIcon,
  Storage as StorageIcon,
  AttachMoney as CostIcon,
  Schedule as ScheduleIcon,
  History as HistoryIcon,
} from '@mui/icons-material';
import { useSocket } from '../contexts/SocketContext';
import config from '../config/env';

const Admin = () => {
  const { isConnected } = useSocket();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [health, setHealth] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [costs, setCosts] = useState(null);
  const [syncHistory, setSyncHistory] = useState([]);
  const [errors, setErrors] = useState([]);
  const [triggeringSyncronizing, setTriggeringSyncronizing] = useState(false);
  const [testingService, setTestingService] = useState(null);
  const [testResults, setTestResults] = useState({});

  // Fetch all admin data
  const fetchData = useCallback(async () => {
    try {
      const baseUrl = config.apiUrl;
      
      const [healthRes, syncRes, costsRes, historyRes, errorsRes] = await Promise.all([
        fetch(`${baseUrl}/admin/health`).then(r => r.json()),
        fetch(`${baseUrl}/admin/sync-status`).then(r => r.json()),
        fetch(`${baseUrl}/admin/costs`).then(r => r.json()),
        fetch(`${baseUrl}/admin/sync/history`).then(r => r.json()),
        fetch(`${baseUrl}/admin/errors`).then(r => r.json()),
      ]);

      setHealth(healthRes);
      setSyncStatus(syncRes);
      setCosts(costsRes.costs);
      setSyncHistory(historyRes.history || []);
      setErrors(errorsRes.errors || []);
      setLoading(false);
    } catch (error) {
      console.error('Failed to fetch admin data:', error);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  };

  const handleStartSync = async () => {
    try {
      await fetch(`${config.apiUrl}/admin/sync/start`, { method: 'POST' });
      await fetchData();
    } catch (error) {
      console.error('Failed to start sync:', error);
    }
  };

  const handleStopSync = async () => {
    try {
      await fetch(`${config.apiUrl}/admin/sync/stop`, { method: 'POST' });
      await fetchData();
    } catch (error) {
      console.error('Failed to stop sync:', error);
    }
  };

  const handleTriggerSync = async () => {
    setTriggeringSyncronizing(true);
    try {
      await fetch(`${config.apiUrl}/admin/sync/run`, { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await fetchData();
    } catch (error) {
      console.error('Failed to trigger sync:', error);
    }
    setTriggeringSyncronizing(false);
  };

  const handleTestConnection = async (service) => {
    setTestingService(service);
    try {
      const response = await fetch(`${config.apiUrl}/admin/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service }),
      });
      const result = await response.json();
      setTestResults(prev => ({ ...prev, [service]: result }));
      // Refresh health data after test
      await fetchData();
    } catch (error) {
      console.error(`Failed to test ${service}:`, error);
      setTestResults(prev => ({ 
        ...prev, 
        [service]: { success: false, message: error.message } 
      }));
    }
    setTestingService(null);
  };

  const getStatusColor = (status) => {
    switch (status?.toLowerCase()) {
      case 'healthy':
      case 'connected':
      case 'active':
      case 'available':
      case 'completed':
      case 'configured':
      case 'database':
      case 'api':
        return 'success';
      case 'degraded':
      case 'warning':
        return 'warning';
      case 'error':
      case 'disconnected':
      case 'unavailable':
      case 'failed':
      case 'not_configured':
        return 'error';
      default:
        return 'default';
    }
  };

  const getStatusIcon = (status) => {
    switch (status?.toLowerCase()) {
      case 'healthy':
      case 'connected':
      case 'active':
      case 'available':
      case 'completed':
      case 'configured':
      case 'database':
      case 'api':
        return <HealthyIcon color="success" />;
      case 'degraded':
      case 'warning':
        return <WarningIcon color="warning" />;
      case 'error':
      case 'disconnected':
      case 'unavailable':
      case 'failed':
      case 'not_configured':
        return <ErrorIcon color="error" />;
      default:
        return <WarningIcon color="disabled" />;
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString();
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%' }}>
      {/* Header */}
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Box>
          <Typography variant="h4" fontWeight="bold">
            🛠️ Developer Dashboard
          </Typography>
          <Typography variant="body2" color="text.secondary">
            System monitoring, sync control, and service health
          </Typography>
        </Box>
        <Box display="flex" gap={1}>
          <Chip
            icon={isConnected ? <HealthyIcon /> : <ErrorIcon />}
            label={isConnected ? 'WebSocket Connected' : 'WebSocket Disconnected'}
            color={isConnected ? 'success' : 'error'}
            variant="outlined"
          />
          <IconButton onClick={handleRefresh} disabled={refreshing}>
            <RefreshIcon className={refreshing ? 'rotating' : ''} />
          </IconButton>
        </Box>
      </Box>

      {/* System Health Overview */}
      <Card sx={{ mb: 3 }}>
        <CardHeader 
          title="System Health" 
          avatar={getStatusIcon(health?.status)}
          action={
            <Chip 
              label={health?.status?.toUpperCase() || 'UNKNOWN'} 
              color={getStatusColor(health?.status)}
            />
          }
        />
        <CardContent>
          <Grid container spacing={2}>
            {health?.services && Object.entries(health.services).map(([name, service]) => {
              // Determine if this service can be tested
              const testableServices = ['mango', 'opendental', 'deepgram', 'openai'];
              const serviceLower = name.toLowerCase().replace(/\s+/g, '');
              const canTest = testableServices.some(s => serviceLower.includes(s));
              const testServiceName = serviceLower.includes('mango') ? 'mango' 
                : serviceLower.includes('opendental') ? 'opendental'
                : serviceLower.includes('transcription') ? 'deepgram'
                : serviceLower.includes('callanalyzer') ? 'openai'
                : null;
              
              return (
                <Grid item xs={12} sm={6} md={4} key={name}>
                  <Card variant="outlined">
                    <CardContent>
                      <Box display="flex" alignItems="center" gap={1} mb={1}>
                        {getStatusIcon(service.status)}
                        <Typography variant="h6" sx={{ textTransform: 'capitalize' }}>
                          {name.replace(/([A-Z])/g, ' $1').trim()}
                        </Typography>
                      </Box>
                      <Chip 
                        label={service.status} 
                        size="small" 
                        color={getStatusColor(service.status)}
                      />
                      {service.connection_type && (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                          Type: {service.connection_type}
                        </Typography>
                      )}
                      {service.connected_clients !== undefined && (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                          {service.connected_clients} clients connected
                        </Typography>
                      )}
                      {service.active_calls !== undefined && (
                        <Typography variant="body2" color="text.secondary">
                          {service.active_calls} active calls
                        </Typography>
                      )}
                      {service.last_sync && (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                          Last sync: {formatDate(service.last_sync)}
                        </Typography>
                      )}
                      {/* Test Connection Button */}
                      {canTest && testServiceName && (
                        <Box sx={{ mt: 2 }}>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => handleTestConnection(testServiceName)}
                            disabled={testingService === testServiceName}
                            startIcon={testingService === testServiceName ? <CircularProgress size={14} /> : null}
                          >
                            {testingService === testServiceName ? 'Testing...' : 'Test Connection'}
                          </Button>
                          {testResults[testServiceName] && (
                            <Alert 
                              severity={testResults[testServiceName].success ? 'success' : 'error'} 
                              sx={{ mt: 1, py: 0 }}
                            >
                              {testResults[testServiceName].message}
                            </Alert>
                          )}
                        </Box>
                      )}
                    </CardContent>
                  </Card>
                </Grid>
              );
            })}
          </Grid>
        </CardContent>
      </Card>

      <Grid container spacing={3}>
        {/* Mango Sync Control */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardHeader 
              title="Mango Voice Sync"
              avatar={<SyncIcon />}
            />
            <CardContent>
              <Box display="flex" gap={2} mb={2}>
                <Button
                  variant="contained"
                  startIcon={syncStatus?.sync?.running ? <StopIcon /> : <StartIcon />}
                  color={syncStatus?.sync?.running ? 'error' : 'success'}
                  onClick={syncStatus?.sync?.running ? handleStopSync : handleStartSync}
                >
                  {syncStatus?.sync?.running ? 'Stop Scheduler' : 'Start Scheduler'}
                </Button>
                <Button
                  variant="outlined"
                  startIcon={triggeringSyncronizing ? <CircularProgress size={16} /> : <SyncIcon />}
                  onClick={handleTriggerSync}
                  disabled={triggeringSyncronizing || syncStatus?.sync?.syncing}
                >
                  Run Now
                </Button>
              </Box>

              <Box sx={{ bgcolor: 'grey.100', p: 2, borderRadius: 1 }}>
                <Grid container spacing={2}>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary">Status</Typography>
                    <Typography variant="body1">
                      {syncStatus?.sync?.syncing ? '🔄 Syncing...' : 
                       syncStatus?.sync?.running ? '✅ Scheduler Active' : '⏸️ Stopped'}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary">Schedule</Typography>
                    <Typography variant="body1">{syncStatus?.sync?.schedule || 'Not set'}</Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary">Last Sync</Typography>
                    <Typography variant="body1">{formatDate(syncStatus?.sync?.lastSync)}</Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary">Next Sync</Typography>
                    <Typography variant="body1">{formatDate(syncStatus?.sync?.nextSync)}</Typography>
                  </Grid>
                </Grid>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Cost Tracking */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardHeader 
              title="Cost Tracking"
              avatar={<CostIcon />}
            />
            <CardContent>
              {costs && (
                <Box>
                  <Grid container spacing={2}>
                    <Grid item xs={6}>
                      <Card variant="outlined">
                        <CardContent>
                          <Typography variant="caption" color="text.secondary">
                            Transcription (Deepgram)
                          </Typography>
                          <Typography variant="h5" color="primary">
                            {costs.transcription?.estimated_cost || '$0.00'}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {costs.transcription?.total_minutes || 0} minutes
                          </Typography>
                        </CardContent>
                      </Card>
                    </Grid>
                    <Grid item xs={6}>
                      <Card variant="outlined">
                        <CardContent>
                          <Typography variant="caption" color="text.secondary">
                            AI Analysis (OpenAI)
                          </Typography>
                          <Typography variant="h5" color="primary">
                            {costs.analysis?.estimated_cost || '$0.00'}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {costs.analysis?.total_analyses || 0} analyses
                          </Typography>
                        </CardContent>
                      </Card>
                    </Grid>
                  </Grid>
                  <Box sx={{ mt: 2, p: 2, bgcolor: 'success.light', borderRadius: 1, textAlign: 'center' }}>
                    <Typography variant="h6" color="success.dark">
                      Total: {costs.total_estimated || '$0.00'}
                    </Typography>
                  </Box>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Sync History */}
        <Grid item xs={12}>
          <Card>
            <CardHeader 
              title="Sync History"
              avatar={<HistoryIcon />}
            />
            <CardContent>
              {syncHistory.length === 0 ? (
                <Alert severity="info">No sync history yet. Run a sync to see results here.</Alert>
              ) : (
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Time</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell align="right">Found</TableCell>
                        <TableCell align="right">Imported</TableCell>
                        <TableCell align="right">Transcribed</TableCell>
                        <TableCell align="right">Analyzed</TableCell>
                        <TableCell align="right">Duration</TableCell>
                        <TableCell>Errors</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {syncHistory.slice(0, 10).map((sync) => (
                        <TableRow key={sync.id}>
                          <TableCell>{formatDate(sync.started_at)}</TableCell>
                          <TableCell>
                            <Chip 
                              label={sync.status} 
                              size="small" 
                              color={getStatusColor(sync.status)}
                            />
                          </TableCell>
                          <TableCell align="right">{sync.calls_found}</TableCell>
                          <TableCell align="right">{sync.calls_imported}</TableCell>
                          <TableCell align="right">{sync.calls_transcribed}</TableCell>
                          <TableCell align="right">{sync.calls_analyzed}</TableCell>
                          <TableCell align="right">
                            {sync.duration_ms ? `${(sync.duration_ms / 1000).toFixed(1)}s` : '-'}
                          </TableCell>
                          <TableCell>
                            {sync.errors?.length > 0 && (
                              <Tooltip title={sync.errors.join(', ')}>
                                <Chip label={sync.errors.length} size="small" color="error" />
                              </Tooltip>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Recent Errors */}
        {errors.length > 0 && (
          <Grid item xs={12}>
            <Card>
              <CardHeader 
                title="Recent Errors"
                avatar={<ErrorIcon color="error" />}
              />
              <CardContent>
                {errors.slice(0, 5).map((error, index) => (
                  <Alert severity="error" key={index} sx={{ mb: 1 }}>
                    <AlertTitle>{formatDate(error.timestamp)}</AlertTitle>
                    {error.error}
                  </Alert>
                ))}
              </CardContent>
            </Card>
          </Grid>
        )}
      </Grid>
    </Box>
  );
};

export default Admin;

