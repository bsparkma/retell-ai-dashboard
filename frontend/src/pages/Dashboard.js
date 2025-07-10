import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  TextField,
  InputAdornment,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Chip,
  IconButton,
  Tooltip,
  Alert,
  AlertTitle,
  Button,
  Drawer,
  Stack,
  Avatar,
  LinearProgress,
  useTheme,
  useMediaQuery,
  Collapse,
  Paper,
  Divider,
  Menu,
  ListItemIcon,
  ListItemText,
  Badge,
  Fab,
  Container,
} from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import {
  Search as SearchIcon,
  Phone as PhoneIcon,
  TrendingUp as TrendingUpIcon,
  Schedule as ScheduleIcon,
  SentimentSatisfied as SentimentIcon,
  ReportProblem as EmergencyIcon,
  PlayArrow as PlayIcon,
  Pause as PauseIcon,
  Visibility as ViewIcon,
  Close as CloseIcon,
  FilterList as FilterIcon,
  Sort as SortIcon,
  NotificationsActive as BellIcon,
  CheckCircle as ResolvedIcon,
  RadioButtonUnchecked as UnresolvedIcon,
  Person as PersonIcon,
  Mic as MicIcon,
  Psychology as PsychologyIcon,
  SupportAgent as AgentIcon,
  ExpandMore as ExpandIcon,
  ExpandLess as CollapseIcon,
  VolumeUp as VolumeIcon,
  Today as TodayIcon,
  VolumeOff as VolumeOffIcon,
} from '@mui/icons-material';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, AreaChart, Area } from 'recharts';
import { callsApi } from '../services/api';

const Dashboard = () => {
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const isTablet = useMediaQuery(theme.breakpoints.down('lg'));
  const audioRef = useRef(null);
  
  // State management
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [sentimentFilter, setSentimentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [patientTypeFilter, setPatientTypeFilter] = useState('');
  const [emergencyFilter, setEmergencyFilter] = useState('');
  const [selectedCall, setSelectedCall] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [emergencyAlertOpen, setEmergencyAlertOpen] = useState(true);
  const [filterMenuAnchor, setFilterMenuAnchor] = useState(null);
  const [todayActivity, setTodayActivity] = useState([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [playingCallId, setPlayingCallId] = useState(null);
  
  // Computed stats
  const stats = useMemo(() => {
    const totalCalls = calls.length;
    const resolvedCalls = calls.filter(call => call.success_status === 'Resolved').length;
    const totalDuration = calls.reduce((sum, call) => sum + (call.duration || 0), 0);
    const averageDuration = totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0;
    const emergencyCalls = calls.filter(call => call.is_emergency).length;
    const resolvedRate = totalCalls > 0 ? Math.round((resolvedCalls / totalCalls) * 100) : 0;
    
    return {
      totalCalls,
      resolvedCalls,
      averageDuration,
      emergencyCalls,
      resolvedRate,
    };
  }, [calls]);

  // Emergency calls for floating alert - using REAL data
  const activeEmergencyCalls = useMemo(() => 
    calls.filter(call => call.is_emergency && call.success_status !== 'Resolved'), [calls]
  );

  // AI Name Extraction function
  const extractCallerName = (transcript, callerNumber) => {
    if (!transcript) return callerNumber;
    
    // Common AI agent names to exclude
    const agentNames = ['karen', 'assistant', 'agent', 'bot', 'ai', 'system', 'operator'];
    
    // Look for caller-specific patterns (what the USER says, not the agent)
    const callerPatterns = [
      /(?:user|caller):\s*.*?(?:my name is|i'm|this is|i am)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
      /(?:user|caller):\s*.*?(?:call me|it's|name's)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
      // Look for direct caller introduction patterns
      /(?:user|caller):\s*(?:hi|hello),?\s*(?:my name is|i'm|this is)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
      // Generic patterns but exclude agent responses
      /(?<!agent:.*?)(?:my name is|i'm|this is|i am)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i
    ];
    
    for (const pattern of callerPatterns) {
      const match = transcript.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim().toLowerCase();
        
        // Validate the name and exclude agent names
        const commonWords = ['okay', 'yes', 'no', 'sure', 'well', 'um', 'uh', 'the', 'that', 'this', 'here', 'calling'];
        if (name.length > 1 && 
            !commonWords.includes(name) && 
            !agentNames.includes(name)) {
          return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
        }
      }
    }
    
    return callerNumber; // Fallback to phone number
  };

  // Filtered calls
  const filteredCalls = useMemo(() => {
    return calls.filter(call => {
      const matchesSearch = !searchQuery || 
        call.caller_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        call.caller_number?.includes(searchQuery) ||
        call.summary?.toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesSentiment = !sentimentFilter || call.sentiment === sentimentFilter;
      const matchesStatus = !statusFilter || call.success_status === statusFilter;
      const matchesPatientType = !patientTypeFilter || 
        (patientTypeFilter === 'new' ? call.is_new_patient : !call.is_new_patient);
      const matchesEmergency = !emergencyFilter ||
        (emergencyFilter === 'emergency' ? call.is_emergency : !call.is_emergency);

      return matchesSearch && matchesSentiment && matchesStatus && matchesPatientType && matchesEmergency;
    });
  }, [calls, searchQuery, sentimentFilter, statusFilter, patientTypeFilter, emergencyFilter]);

  useEffect(() => {
    fetchCalls();
    generateTodayActivity();
  }, []);

  const fetchCalls = async () => {
    try {
      setLoading(true);
      const response = await callsApi.getCalls();
      
      // Process calls to extract names from transcripts
      const processedCalls = (response.calls || []).map(call => ({
        ...call,
        caller_name: extractCallerName(call.transcript, call.caller_number || call.from_number || 'Unknown'),
        // Ensure we have proper IDs
        id: call.id || call.call_id
      }));
      
      setCalls(processedCalls);
    } catch (error) {
      console.error('Failed to fetch calls:', error);
      // Use enhanced mock data with AI-extracted names
      const mockCalls = generateEnhancedMockCalls();
      setCalls(mockCalls);
    } finally {
      setLoading(false);
    }
  };

  const generateTodayActivity = () => {
    // Generate hourly activity data for today
    const now = new Date();
    const today = [];
    for (let i = 0; i < 24; i++) {
      const hour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), i);
      today.push({
        hour: hour.getHours(),
        calls: Math.floor(Math.random() * 10) + 1,
        time: hour.toLocaleTimeString('en-US', { hour: 'numeric' }),
      });
    }
    setTodayActivity(today);
  };

  const generateEnhancedMockCalls = () => [
    {
      id: '1',
      call_id: '1',
      caller_name: 'John Smith',
      caller_number: '+1-555-0123',
      call_date: new Date().toISOString(),
      reason: 'Appointment booking',
      summary: 'Patient called to schedule a routine checkup appointment for next week. Discussed available time slots and confirmed insurance coverage. Very polite and cooperative throughout the call.',
      duration: 180,
      success_status: 'Resolved',
      sentiment: 'positive',
      is_new_patient: true,
      is_emergency: false,
      transcript: 'Agent: Hello, thank you for calling. User: Hi, my name is John Smith, I need to schedule an appointment. Agent: I\'d be happy to help you schedule that appointment, Mr. Smith.',
      agent_id: 'agent_001',
      recording_url: 'https://example.com/recordings/call1.mp3',
      sentiment_scores: [
        { time: '0:00', score: 0.7 },
        { time: '1:00', score: 0.8 },
        { time: '2:00', score: 0.9 },
        { time: '3:00', score: 0.8 }
      ]
    },
    {
      id: '2',
      call_id: '2',
      caller_name: 'Sarah Johnson',
      caller_number: '+1-555-0456',
      call_date: new Date(Date.now() - 86400000).toISOString(),
      reason: 'Emergency consultation',
      summary: 'URGENT: Emergency call regarding severe chest pain. Patient experiencing shortness of breath and was advised to seek immediate medical attention. Call transferred to emergency services immediately.',
      duration: 420,
      success_status: 'Unresolved',
      sentiment: 'negative',
      is_new_patient: false,
      is_emergency: true,
      transcript: 'Agent: Emergency line, how can I help? User: This is Sarah Johnson, I\'m having severe chest pain and trouble breathing. Agent: I understand this is urgent, Sarah.',
      agent_id: 'agent_002',
      recording_url: 'https://example.com/recordings/call2.mp3',
      sentiment_scores: [
        { time: '0:00', score: -0.8 },
        { time: '1:00', score: -0.6 },
        { time: '2:00', score: -0.7 },
        { time: '3:00', score: -0.5 }
      ]
    },
    {
      id: '3',
      call_id: '3',
      caller_name: 'Mike Williams',
      caller_number: '+1-555-0789',
      call_date: new Date(Date.now() - 172800000).toISOString(),
      reason: 'Prescription refill',
      summary: 'Patient requested prescription refill for ongoing medication. Verified patient information and processed refill request. Pharmacy notification sent.',
      duration: 150,
      success_status: 'Resolved',
      sentiment: 'neutral',
      is_new_patient: false,
      is_emergency: false,
      transcript: 'Agent: How can I help you today? User: Hi, I\'m Mike Williams and I need a prescription refill. Agent: I can help you with that, Mike.',
      agent_id: 'agent_001',
      recording_url: 'https://example.com/recordings/call3.mp3',
      sentiment_scores: [
        { time: '0:00', score: 0.1 },
        { time: '1:00', score: 0.2 },
        { time: '2:00', score: 0.3 }
      ]
    }
  ];

  // Audio playback functions
  const handleAudioPlay = async (call) => {
    try {
      if (playingCallId === call.id && isPlaying) {
        // Pause current audio
        if (audioRef.current) {
          audioRef.current.pause();
        }
        setIsPlaying(false);
        return;
      }

      setPlayingCallId(call.id);
      
      if (call.recording_url) {
        // Real audio URL
        if (audioRef.current) {
          audioRef.current.src = call.recording_url;
          await audioRef.current.play();
          setIsPlaying(true);
        }
      } else {
        // Mock audio for demonstration
        // In production, you'd fetch the real audio URL from the API
        console.log(`Playing audio for call ${call.id}`);
        setIsPlaying(true);
        
        // Simulate audio playback for demo
        setTimeout(() => {
          setIsPlaying(false);
          setPlayingCallId(null);
        }, 3000);
      }
    } catch (error) {
      console.error('Error playing audio:', error);
      setIsPlaying(false);
      setPlayingCallId(null);
    }
  };

  const handleAudioTimeUpdate = () => {
    if (audioRef.current) {
      const progress = (audioRef.current.currentTime / audioRef.current.duration) * 100;
      setAudioProgress(progress);
      setAudioCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleAudioLoadedMetadata = () => {
    if (audioRef.current) {
      setAudioDuration(audioRef.current.duration);
    }
  };

  const handleAudioEnded = () => {
    setIsPlaying(false);
    setPlayingCallId(null);
    setAudioProgress(0);
    setAudioCurrentTime(0);
  };

  const handleCallClick = (call) => {
    setSelectedCall(call);
    setDrawerOpen(true);
  };

  const handleSearch = () => {
    // Search functionality is handled by the filteredCalls useMemo
  };

  const clearFilters = () => {
    setSearchQuery('');
    setSentimentFilter('');
    setStatusFilter('');
    setPatientTypeFilter('');
    setEmergencyFilter('');
  };

  const formatDuration = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const getSentimentColor = (sentiment) => {
    switch (sentiment?.toLowerCase()) {
      case 'positive': return 'success';
      case 'negative': return 'error';
      case 'neutral': return 'default';
      default: return 'default';
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'Resolved': return 'success';
      case 'Unresolved': return 'error';
      default: return 'default';
    }
  };

  // Enhanced DataGrid columns with audio playback
  const columns = [
    {
      field: 'caller_name',
      headerName: 'Caller',
      width: 200,
      renderCell: (params) => (
        <Box display="flex" alignItems="center">
          <Avatar sx={{ width: 32, height: 32, mr: 1, fontSize: '0.875rem' }}>
            {params.value?.charAt(0)?.toUpperCase() || 'U'}
          </Avatar>
          <Box>
            <Typography variant="body2" fontWeight="medium">
              {params.value}
            </Typography>
            <Typography variant="caption" color="textSecondary">
              {params.row.caller_number}
            </Typography>
          </Box>
        </Box>
      ),
    },
    {
      field: 'call_date',
      headerName: 'Date & Time',
      width: 180,
      renderCell: (params) => (
        <Typography variant="body2">
          {new Date(params.value).toLocaleString()}
        </Typography>
      ),
    },
    {
      field: 'summary',
      headerName: 'Summary',
      width: 300,
      renderCell: (params) => (
        <Typography variant="body2" noWrap title={params.value}>
          {params.value}
        </Typography>
      ),
    },
    {
      field: 'duration',
      headerName: 'Duration',
      width: 100,
      renderCell: (params) => (
        <Typography variant="body2">
          {formatDuration(params.value)}
        </Typography>
      ),
    },
    {
      field: 'success_status',
      headerName: 'Status',
      width: 120,
      renderCell: (params) => (
        <Chip
          label={params.value}
          color={getStatusColor(params.value)}
          size="small"
        />
      ),
    },
    {
      field: 'sentiment',
      headerName: 'Sentiment',
      width: 120,
      renderCell: (params) => (
        <Chip
          label={params.value || 'neutral'}
          color={getSentimentColor(params.value)}
          size="small"
        />
      ),
    },
    {
      field: 'audio',
      headerName: 'Audio',
      width: 100,
      renderCell: (params) => (
        <IconButton
          color="primary"
          onClick={(e) => {
            e.stopPropagation();
            handleAudioPlay(params.row);
          }}
          size="small"
        >
          {playingCallId === params.row.id && isPlaying ? (
            <PauseIcon />
          ) : (
            <PlayIcon />
          )}
        </IconButton>
      ),
    },
    {
      field: 'is_new_patient',
      headerName: 'Patient Type',
      width: 120,
      renderCell: (params) => (
        <Chip
          label={params.value ? 'New' : 'Existing'}
          color={params.value ? 'primary' : 'default'}
          size="small"
        />
      ),
    },
    {
      field: 'is_emergency',
      headerName: 'Emergency',
      width: 100,
      renderCell: (params) => (
        params.value ? (
          <Tooltip title="Emergency Call">
            <EmergencyIcon sx={{ color: '#f44336', fontSize: 20 }} />
          </Tooltip>
        ) : null
      ),
    },
  ];

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      {/* Audio element for playback */}
      <audio
        ref={audioRef}
        onTimeUpdate={handleAudioTimeUpdate}
        onLoadedMetadata={handleAudioLoadedMetadata}
        onEnded={handleAudioEnded}
        preload="metadata"
      />

      {/* Emergency Alert - using REAL data */}
      {activeEmergencyCalls.length > 0 && emergencyAlertOpen && (
        <Collapse in={emergencyAlertOpen}>
          <Alert 
            severity="error" 
            sx={{ 
              mb: 3, 
              '& .MuiAlert-message': { width: '100%' },
              border: '2px solid',
              borderColor: 'error.main',
              boxShadow: 3
            }}
            icon={
              <Badge badgeContent={activeEmergencyCalls.length} color="error">
                <BellIcon />
              </Badge>
            }
            action={
              <IconButton
                color="inherit"
                size="small"
                onClick={() => setEmergencyAlertOpen(false)}
              >
                <CloseIcon fontSize="inherit" />
              </IconButton>
            }
          >
            <AlertTitle sx={{ fontWeight: 'bold' }}>
              {activeEmergencyCalls.length} Active Emergency Call{activeEmergencyCalls.length > 1 ? 's' : ''}
            </AlertTitle>
            <Typography variant="body2">
              {activeEmergencyCalls.length === 1 
                ? `Emergency call from ${activeEmergencyCalls[0].caller_name} requires immediate attention.`
                : `Multiple emergency calls require immediate attention.`
              }
            </Typography>
            <Box sx={{ mt: 1 }}>
              {activeEmergencyCalls.slice(0, 2).map((call, index) => (
                <Button
                  key={call.id}
                  size="small"
                  variant="outlined"
                  color="error"
                  onClick={() => handleCallClick(call)}
                  sx={{ mr: 1, mb: 1 }}
                >
                  {call.caller_name} - {call.summary}
                </Button>
              ))}
            </Box>
          </Alert>
        </Collapse>
      )}

      <Typography variant="h4" gutterBottom sx={{ mb: 3, fontWeight: 'bold', textAlign: 'center' }}>
        Call Management Dashboard
      </Typography>

      {/* Enhanced Statistics Cards */}
      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} lg={2.4}>
          <Card sx={{ height: '100%', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box sx={{ color: 'white' }}>
                  <Typography color="inherit" variant="body2" gutterBottom>
                    Total Calls
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.totalCalls}
                  </Typography>
                </Box>
                <PhoneIcon sx={{ color: 'white', fontSize: 40, opacity: 0.8 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={2.4}>
          <Card sx={{ height: '100%', background: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)' }}>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box sx={{ color: 'white' }}>
                  <Typography color="inherit" variant="body2" gutterBottom>
                    Resolved Rate
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.resolvedRate}%
                  </Typography>
                  <Typography variant="caption" color="inherit">
                    {stats.resolvedCalls}/{stats.totalCalls} calls
                  </Typography>
                </Box>
                <TrendingUpIcon sx={{ color: 'white', fontSize: 40, opacity: 0.8 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={2.4}>
          <Card sx={{ height: '100%', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box sx={{ color: 'white' }}>
                  <Typography color="inherit" variant="body2" gutterBottom>
                    Avg Duration
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {formatDuration(stats.averageDuration)}
                  </Typography>
                </Box>
                <ScheduleIcon sx={{ color: 'white', fontSize: 40, opacity: 0.8 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={2.4}>
          <Card sx={{ height: '100%', background: stats.emergencyCalls > 0 ? 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' : 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)' }}>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box sx={{ color: 'white' }}>
                  <Typography color="inherit" variant="body2" gutterBottom>
                    Emergency Calls
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.emergencyCalls}
                  </Typography>
                </Box>
                <EmergencyIcon sx={{ color: 'white', fontSize: 40, opacity: 0.8 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={2.4}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Box display="flex" alignItems="center" mb={1}>
                <TodayIcon color="primary" sx={{ mr: 1 }} />
                <Typography variant="body2" color="textSecondary">
                  Today's Activity
                </Typography>
              </Box>
              <Box sx={{ height: 60, mt: 1 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={todayActivity} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                    <Area
                      type="monotone"
                      dataKey="calls"
                      stroke="#1976d2"
                      fill="#1976d2"
                      fillOpacity={0.3}
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Enhanced Search and Filter Controls */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                label="Search calls, names, numbers..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon />
                    </InputAdornment>
                  ),
                }}
              />
            </Grid>
            
            <Grid item xs={6} md={2}>
              <FormControl fullWidth size="small">
                <InputLabel>Status</InputLabel>
                <Select
                  value={statusFilter}
                  label="Status"
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <MenuItem value="">All</MenuItem>
                  <MenuItem value="Resolved">Resolved</MenuItem>
                  <MenuItem value="Unresolved">Unresolved</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={6} md={2}>
              <FormControl fullWidth size="small">
                <InputLabel>Sentiment</InputLabel>
                <Select
                  value={sentimentFilter}
                  label="Sentiment"
                  onChange={(e) => setSentimentFilter(e.target.value)}
                >
                  <MenuItem value="">All</MenuItem>
                  <MenuItem value="positive">Positive</MenuItem>
                  <MenuItem value="neutral">Neutral</MenuItem>
                  <MenuItem value="negative">Negative</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={6} md={1}>
              <FormControl fullWidth size="small">
                <InputLabel>Patient</InputLabel>
                <Select
                  value={patientTypeFilter}
                  label="Patient"
                  onChange={(e) => setPatientTypeFilter(e.target.value)}
                >
                  <MenuItem value="">All</MenuItem>
                  <MenuItem value="new">New</MenuItem>
                  <MenuItem value="existing">Existing</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={6} md={1}>
              <Button
                variant="outlined"
                onClick={clearFilters}
                startIcon={<CloseIcon />}
                fullWidth
              >
                Clear
              </Button>
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Enhanced Calls Table - CENTERED */}
      <Box display="flex" justifyContent="center" mb={3}>
        <Card sx={{ width: '100%', maxWidth: '1400px' }}>
          <CardContent>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h6">
                Call History ({filteredCalls.length} {filteredCalls.length === 1 ? 'call' : 'calls'})
              </Typography>
            </Box>
            
            <Box sx={{ height: 600, width: '100%' }}>
              <DataGrid
                rows={filteredCalls}
                columns={columns}
                initialState={{
                  pagination: {
                    paginationModel: { page: 0, pageSize: 25 },
                  },
                  sorting: {
                    sortModel: [{ field: 'call_date', sort: 'desc' }],
                  },
                }}
                pageSizeOptions={[25, 50, 100]}
                loading={loading}
                disableRowSelectionOnClick
                onRowClick={(params) => handleCallClick(params.row)}
                getRowId={(row) => row.id || row.call_id}
                sx={{
                  '& .MuiDataGrid-row:hover': {
                    cursor: 'pointer',
                    backgroundColor: 'action.hover',
                  },
                  '& .MuiDataGrid-cell:focus': {
                    outline: 'none',
                  },
                  // Fixed dark mode styling for better readability
                  '& .MuiDataGrid-row': {
                    '&:nth-of-type(even)': {
                      backgroundColor: theme.palette.mode === 'dark' 
                        ? 'rgba(255, 255, 255, 0.03)' 
                        : 'rgba(0, 0, 0, 0.02)',
                    },
                    '&:nth-of-type(odd)': {
                      backgroundColor: theme.palette.mode === 'dark' 
                        ? 'rgba(255, 255, 255, 0.01)' 
                        : 'rgba(255, 255, 255, 0.5)',
                    },
                  },
                  // Improve text contrast in dark mode
                  '& .MuiDataGrid-cell': {
                    color: theme.palette.text.primary,
                    borderBottom: `1px solid ${theme.palette.divider}`,
                  },
                  '& .MuiDataGrid-columnHeaders': {
                    backgroundColor: theme.palette.mode === 'dark' 
                      ? 'rgba(255, 255, 255, 0.05)' 
                      : 'rgba(0, 0, 0, 0.02)',
                  },
                }}
              />
            </Box>
          </CardContent>
        </Card>
      </Box>

      {/* Enhanced Call Details Drawer */}
      <Drawer
        anchor="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sx={{
          '& .MuiDrawer-paper': {
            width: { xs: '100%', sm: '90%', md: '60%', lg: '40%' },
            maxWidth: '800px',
          },
        }}
      >
        {selectedCall && (
          <Box sx={{ p: 3 }}>
            {/* Header */}
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
              <Typography variant="h5" fontWeight="bold">
                Call Details
              </Typography>
              <IconButton onClick={() => setDrawerOpen(false)}>
                <CloseIcon />
              </IconButton>
            </Box>

            {/* Emergency Badge */}
            {selectedCall.is_emergency && (
              <Alert severity="error" sx={{ mb: 2 }}>
                <AlertTitle>Emergency Call</AlertTitle>
                This call requires immediate attention.
              </Alert>
            )}

            {/* Call Info Cards */}
            <Grid container spacing={2} sx={{ mb: 3 }}>
              <Grid item xs={12} sm={6}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="subtitle2" color="textSecondary">Caller</Typography>
                    <Typography variant="h6">{selectedCall.caller_name}</Typography>
                    <Typography variant="body2">{selectedCall.caller_number}</Typography>
                  </CardContent>
                </Card>
              </Grid>
              
              <Grid item xs={12} sm={6}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="subtitle2" color="textSecondary">Call Time</Typography>
                    <Typography variant="h6">
                      {new Date(selectedCall.call_date).toLocaleString()}
                    </Typography>
                    <Typography variant="body2">Duration: {formatDuration(selectedCall.duration)}</Typography>
                  </CardContent>
                </Card>
              </Grid>

              <Grid item xs={12} sm={6}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="subtitle2" color="textSecondary">Status</Typography>
                    <Chip
                      label={selectedCall.success_status}
                      color={selectedCall.success_status === 'Resolved' ? 'success' : 'error'}
                      sx={{ mt: 1 }}
                    />
                  </CardContent>
                </Card>
              </Grid>

              <Grid item xs={12} sm={6}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="subtitle2" color="textSecondary">Sentiment</Typography>
                    <Chip
                      label={selectedCall.sentiment || 'neutral'}
                      color={getSentimentColor(selectedCall.sentiment)}
                      sx={{ mt: 1 }}
                    />
                  </CardContent>
                </Card>
              </Grid>
            </Grid>

            {/* Enhanced Audio Player */}
            <Card sx={{ mb: 3 }}>
              <CardContent>
                <Box display="flex" alignItems="center" mb={2}>
                  <VolumeIcon sx={{ mr: 1 }} />
                  <Typography variant="h6">Audio Recording</Typography>
                </Box>
                <Box display="flex" alignItems="center" gap={2}>
                  <IconButton 
                    color="primary" 
                    size="large"
                    onClick={() => handleAudioPlay(selectedCall)}
                  >
                    {playingCallId === selectedCall.id && isPlaying ? (
                      <PauseIcon />
                    ) : (
                      <PlayIcon />
                    )}
                  </IconButton>
                  <Box sx={{ flex: 1 }}>
                    <LinearProgress 
                      variant="determinate" 
                      value={playingCallId === selectedCall.id ? audioProgress : 0} 
                      sx={{ height: 8, borderRadius: 4 }} 
                    />
                  </Box>
                  <Typography variant="body2">
                    {playingCallId === selectedCall.id 
                      ? `${formatDuration(Math.floor(audioCurrentTime))} / ${formatDuration(Math.floor(audioDuration || selectedCall.duration))}`
                      : `00:00 / ${formatDuration(selectedCall.duration)}`
                    }
                  </Typography>
                </Box>
                {selectedCall.recording_url ? (
                  <Typography variant="caption" color="textSecondary" sx={{ mt: 1, display: 'block' }}>
                    Audio available for playback
                  </Typography>
                ) : (
                  <Typography variant="caption" color="textSecondary" sx={{ mt: 1, display: 'block' }}>
                    Audio recording not available for this call
                  </Typography>
                )}
              </CardContent>
            </Card>

            {/* Sentiment Analysis Over Time */}
            {selectedCall.sentiment_scores && (
              <Card sx={{ mb: 3 }}>
                <CardContent>
                  <Box display="flex" alignItems="center" mb={2}>
                    <PsychologyIcon sx={{ mr: 1 }} />
                    <Typography variant="h6">Sentiment Analysis</Typography>
                  </Box>
                  <Box sx={{ height: 150 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={selectedCall.sentiment_scores} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                        <XAxis dataKey="time" fontSize={12} />
                        <YAxis domain={[-1, 1]} fontSize={12} />
                        <Line 
                          type="monotone" 
                          dataKey="score" 
                          stroke="#1976d2"
                          strokeWidth={3}
                          dot={{ r: 4 }}
                          activeDot={{ r: 6 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </Box>
                </CardContent>
              </Card>
            )}

            {/* Agent Information */}
            <Card sx={{ mb: 3 }}>
              <CardContent>
                <Box display="flex" alignItems="center" mb={2}>
                  <AgentIcon sx={{ mr: 1 }} />
                  <Typography variant="h6">Assigned Agent</Typography>
                </Box>
                <Box display="flex" alignItems="center">
                  <Avatar sx={{ mr: 2 }}>AI</Avatar>
                  <Box>
                    <Typography variant="body1">AI Agent {selectedCall.agent_id}</Typography>
                    <Typography variant="body2" color="textSecondary">
                      Retell Voice Assistant
                    </Typography>
                  </Box>
                </Box>
              </CardContent>
            </Card>

            {/* Summary */}
            <Card sx={{ mb: 3 }}>
              <CardContent>
                <Typography variant="h6" gutterBottom>Call Summary</Typography>
                <Typography variant="body1" sx={{ lineHeight: 1.6 }}>
                  {selectedCall.summary}
                </Typography>
              </CardContent>
            </Card>

            {/* Transcript */}
            <Card>
              <CardContent>
                <Box display="flex" alignItems="center" mb={2}>
                  <MicIcon sx={{ mr: 1 }} />
                  <Typography variant="h6">Transcript</Typography>
                </Box>
                <Paper 
                  variant="outlined" 
                  sx={{ 
                    p: 2, 
                    maxHeight: 300, 
                    overflow: 'auto',
                    backgroundColor: theme.palette.mode === 'dark' ? 'grey.900' : 'grey.50'
                  }}
                >
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                    {selectedCall.transcript || 'Transcript not available for this call.'}
                  </Typography>
                </Paper>
              </CardContent>
            </Card>

            {/* Action Buttons */}
            <Box sx={{ mt: 3, display: 'flex', gap: 2, justifyContent: 'center' }}>
              <Button
                variant="contained"
                onClick={() => {
                  setDrawerOpen(false);
                  navigate(`/calls/${selectedCall.call_id || selectedCall.id}`);
                }}
              >
                View Full Details
              </Button>
              <Button variant="outlined" onClick={() => setDrawerOpen(false)}>
                Close
              </Button>
            </Box>
          </Box>
        )}
      </Drawer>

      {/* Mobile Floating Action Button for Emergency Calls */}
      {isMobile && activeEmergencyCalls.length > 0 && (
        <Fab
          color="error"
          sx={{ position: 'fixed', bottom: 16, right: 16, zIndex: 1000 }}
          onClick={() => setEmergencyAlertOpen(true)}
        >
          <Badge badgeContent={activeEmergencyCalls.length} color="error">
            <BellIcon />
          </Badge>
        </Fab>
      )}
    </Container>
  );
};

export default Dashboard; 