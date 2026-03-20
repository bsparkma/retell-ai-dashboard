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
  CheckCircle as CheckCircleIcon,
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
  SwapHoriz as TransferIcon,
  CallMade as CallbackIcon,
  CheckCircleOutline as SuccessIcon,
  ErrorOutline as FailedIcon,
  Voicemail as VoicemailIcon,
  SmartToy as AIIcon,
  Headset as StaffIcon,
  Cloud as RetellIcon,
  PhoneInTalk as MangoIcon,
} from '@mui/icons-material';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, AreaChart, Area } from 'recharts';
import { callsApi, agentsApi, unifiedCallsApi } from '../services/api';
import { getAllOfficeConfigs } from '../config/officeConfig';

const Dashboard = () => {
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const isTablet = useMediaQuery(theme.breakpoints.down('lg'));
  const audioRef = useRef(null);
  
  // State management
  const [calls, setCalls] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [sentimentFilter, setSentimentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [patientTypeFilter, setPatientTypeFilter] = useState('');
  const [emergencyFilter, setEmergencyFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [transferFilter, setTransferFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState(''); // 'retell', 'mango', or '' for all
  const [handlerTypeFilter, setHandlerTypeFilter] = useState(''); // 'ai', 'staff', or '' for all
  const [useUnifiedApi, setUseUnifiedApi] = useState(true); // Use new unified API
  const [officeId, setOfficeId] = useState('default'); // Office configuration
  const [officeConfigs] = useState(getAllOfficeConfigs());
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
    const resolvedCalls = calls.filter(call => call.success_status === 'Resolved' || call.outcome === 'resolved').length;
    const totalDuration = calls.reduce((sum, call) => sum + (call.duration || call.duration_seconds || 0), 0);
    const averageDuration = totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0;
    const emergencyCalls = calls.filter(call => call.is_emergency).length;
    const resolvedRate = totalCalls > 0 ? Math.round((resolvedCalls / totalCalls) * 100) : 0;
    
    // Transfer statistics
    const transferAttempted = calls.filter(call => call.transfer_attempted).length;
    const successfulTransfers = calls.filter(call => call.transfer_status === 'successful').length;
    const failedTransfers = calls.filter(call => call.transfer_status === 'failed').length;
    const voicemailTransfers = calls.filter(call => call.transfer_status === 'voicemail').length;
    const callbackRequired = calls.filter(call => call.callback_required).length;
    const transferSuccessRate = transferAttempted > 0 ? Math.round((successfulTransfers / transferAttempted) * 100) : 0;
    
    // Source breakdown (unified API)
    const retellCalls = calls.filter(call => call.source === 'retell' || call.handler_type === 'ai').length;
    const mangoCalls = calls.filter(call => call.source === 'mango' || call.handler_type === 'staff').length;
    const aiCalls = calls.filter(call => call.handler_type === 'ai').length;
    const staffCalls = calls.filter(call => call.handler_type === 'staff').length;
    
    return {
      totalCalls,
      resolvedCalls,
      averageDuration,
      emergencyCalls,
      resolvedRate,
      transferAttempted,
      successfulTransfers,
      failedTransfers,
      voicemailTransfers,
      callbackRequired,
      transferSuccessRate,
      // Source breakdown
      retellCalls,
      mangoCalls,
      aiCalls,
      staffCalls,
    };
  }, [calls]);

  // Emergency calls for floating alert - using REAL data
  const activeEmergencyCalls = useMemo(() => 
    calls.filter(call => call.is_emergency && call.success_status !== 'Resolved'), [calls]
  );

  // Available agents based on office configuration
  const availableAgents = useMemo(() => {
    if (officeId === 'default') {
      return agents; // Show all agents for default office
    }
    
    // Get current office config
    const currentOffice = officeConfigs.find(config => config.id === officeId);
    if (!currentOffice?.allowedAgents) {
      return agents; // Fallback to all agents if no config found
    }
    
    // Filter agents based on office configuration
    return agents.filter(agent => 
      currentOffice.allowedAgents.includes(agent.agent_id)
    );
  }, [agents, officeId, officeConfigs]);

  // Filtered calls
  const filteredCalls = useMemo(() => {
    return calls.filter(call => {
      const matchesSearch = !searchQuery || 
        call.caller_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        call.caller_number?.includes(searchQuery) ||
        call.summary?.toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesSentiment = !sentimentFilter || call.sentiment === sentimentFilter;
      const matchesStatus = !statusFilter || 
        call.success_status === statusFilter || 
        (statusFilter === 'Resolved' && call.outcome === 'resolved') ||
        (statusFilter === 'Unresolved' && call.outcome !== 'resolved');
      const matchesPatientType = !patientTypeFilter || 
        (patientTypeFilter === 'new' ? call.is_new_patient : !call.is_new_patient);
      const matchesEmergency = !emergencyFilter ||
        (emergencyFilter === 'emergency' ? call.is_emergency : !call.is_emergency);
      const matchesAgent = !agentFilter || call.agent_id === agentFilter || call.handler_id === agentFilter;
      
      // Transfer filter
      const matchesTransfer = !transferFilter || 
        (transferFilter === 'successful' ? call.transfer_status === 'successful' :
         transferFilter === 'failed' ? call.transfer_status === 'failed' :
         transferFilter === 'voicemail' ? call.transfer_status === 'voicemail' :
         transferFilter === 'callback_needed' ? call.callback_required :
         transferFilter === 'no_transfer' ? !call.transfer_attempted : true);

      // Source filter (Retell AI vs Mango Voice)
      const matchesSource = !sourceFilter || call.source === sourceFilter;
      
      // Handler type filter (AI vs Staff)
      const matchesHandlerType = !handlerTypeFilter || call.handler_type === handlerTypeFilter;

      // Additional filter: only show calls from available agents for this office (for AI calls)
      const isAgentAllowed = call.source === 'mango' || call.handler_type === 'staff' || 
        availableAgents.some(agent => agent.agent_id === call.agent_id || agent.agent_id === call.handler_id);

      return matchesSearch && matchesSentiment && matchesStatus && matchesPatientType && 
             matchesEmergency && matchesAgent && matchesTransfer && matchesSource && 
             matchesHandlerType && isAgentAllowed;
    });
  }, [calls, searchQuery, sentimentFilter, statusFilter, patientTypeFilter, emergencyFilter, agentFilter, transferFilter, sourceFilter, handlerTypeFilter, availableAgents]);

  useEffect(() => {
    fetchCalls();
    fetchAgents();
    generateTodayActivity();
  }, [officeId]); // Re-fetch when office changes

  const fetchCalls = async () => {
    try {
      setLoading(true);
      
      let response;
      if (useUnifiedApi) {
        // Use the new unified API that combines Retell + Mango calls
        response = await unifiedCallsApi.getCalls({ 
          office_id: officeId,
          limit: 100,
        });
      } else {
        // Fallback to legacy API
        response = await callsApi.getCalls({ office_id: officeId });
      }
      
      // The backend now handles name extraction and patient identification
      const processedCalls = (response.calls || []).map(call => ({
        ...call,
        // Ensure we have proper IDs
        id: call.id || call.call_id || call.external_id,
        // Normalize duration field
        duration: call.duration || call.duration_seconds || 0,
        // Normalize status field
        success_status: call.success_status || (call.outcome === 'resolved' ? 'Resolved' : 'Unresolved'),
      }));
      
      setCalls(processedCalls);
    } catch (error) {
      console.error('Failed to fetch calls:', error);
      // Use enhanced mock data if API fails
      const mockCalls = generateEnhancedMockCalls();
      setCalls(mockCalls);
    } finally {
      setLoading(false);
    }
  };

  const fetchAgents = async () => {
    try {
      const response = await agentsApi.getAgents();
      setAgents(response.agents || []);
    } catch (error) {
      console.error('Failed to fetch agents:', error);
      // Use fallback agents if API fails
      setAgents([
        { agent_id: '1', agent_name: 'Medical Receptionist' },
        { agent_id: '2', agent_name: 'Emergency Triage' },
        { agent_id: '3', agent_name: 'Billing Support' },
        { agent_id: '4', agent_name: 'Appointment Scheduler' }
      ]);
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
    // AI-handled calls (Retell)
    {
      id: '1',
      call_id: '1',
      source: 'retell',
      handler_type: 'ai',
      caller_name: 'John Smith',
      caller_number: '+1-555-0123',
      call_date: new Date().toISOString(),
      reason: 'Appointment booking',
      summary: 'Patient called to schedule a routine checkup appointment for next week. Successfully transferred to appointment desk and appointment scheduled.',
      duration: 180,
      success_status: 'Resolved',
      sentiment: 'positive',
      is_new_patient: true,
      is_emergency: false,
      transfer_status: 'successful',
      transfer_attempted: true,
      transfer_destination: 'Appointment Desk',
      transfer_timestamp: new Date(Date.now() + 120000).toISOString(),
      callback_required: false,
      transcript: 'Agent: Hello, thank you for calling. User: Hi, my name is John Smith, I need to schedule an appointment. Agent: I\'d be happy to help you schedule that appointment, Mr. Smith. Let me transfer you to our appointment desk.',
      agent_id: 'agent_001',
      handler_name: 'AI Receptionist',
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
      source: 'retell',
      handler_type: 'ai',
      caller_name: 'Sarah Johnson',
      caller_number: '+1-555-0456',
      call_date: new Date(Date.now() - 86400000).toISOString(),
      reason: 'Emergency consultation',
      summary: 'URGENT: Emergency call regarding severe chest pain. Transfer to emergency line failed - patient disconnected. REQUIRES IMMEDIATE CALLBACK.',
      duration: 420,
      success_status: 'Unresolved',
      sentiment: 'negative',
      is_new_patient: false,
      is_emergency: true,
      transfer_status: 'failed',
      transfer_attempted: true,
      transfer_destination: 'Emergency Line',
      transfer_timestamp: new Date(Date.now() - 86400000 + 300000).toISOString(),
      callback_required: true,
      callback_reason: 'Transfer to emergency line failed - patient disconnected',
      transcript: 'Agent: Emergency line, how can I help? User: This is Sarah Johnson, I\'m having severe chest pain and trouble breathing. Agent: I understand this is urgent, Sarah. Let me transfer you immediately. User: Please hurry... [call disconnected]',
      agent_id: 'agent_002',
      handler_name: 'AI Emergency Triage',
      recording_url: 'https://example.com/recordings/call2.mp3',
      sentiment_scores: [
        { time: '0:00', score: -0.8 },
        { time: '1:00', score: -0.6 },
        { time: '2:00', score: -0.7 },
        { time: '3:00', score: -0.5 }
      ]
    },
    // Staff-handled calls (Mango Voice)
    {
      id: '3',
      call_id: '3',
      source: 'mango',
      handler_type: 'staff',
      caller_name: 'Mike Williams',
      caller_number: '+1-555-0789',
      call_date: new Date(Date.now() - 172800000).toISOString(),
      reason: 'Prescription refill',
      summary: 'Patient requested prescription refill for ongoing medication. Staff member processed request and confirmed with pharmacy.',
      duration: 150,
      success_status: 'Resolved',
      sentiment: 'neutral',
      is_new_patient: false,
      is_emergency: false,
      transfer_status: 'none',
      transfer_attempted: false,
      callback_required: false,
      transcript: 'Staff: Good morning, dental office. How can I help? Caller: Hi, I\'m Mike Williams and I need a prescription refill for my pain medication. Staff: Of course, let me pull up your file and verify with the doctor. I\'ll have this ready for you shortly.',
      handler_id: 'staff_001',
      handler_name: 'Maria Garcia',
      recording_url: 'https://example.com/recordings/mango_call3.mp3',
      sentiment_scores: [
        { time: '0:00', score: 0.1 },
        { time: '1:00', score: 0.2 },
        { time: '2:00', score: 0.3 }
      ]
    },
    {
      id: '4',
      call_id: '4',
      source: 'mango',
      handler_type: 'staff',
      caller_name: 'Lisa Chen',
      caller_number: '+1-555-1234',
      call_date: new Date(Date.now() - 259200000).toISOString(),
      reason: 'Insurance inquiry',
      summary: 'Patient called about insurance coverage for upcoming procedure. Staff provided detailed explanation and scheduled follow-up.',
      duration: 240,
      success_status: 'Resolved',
      sentiment: 'positive',
      is_new_patient: false,
      is_emergency: false,
      transfer_status: 'none',
      transfer_attempted: false,
      callback_required: false,
      transcript: 'Staff: Thank you for calling. How may I assist you? Caller: Hi, I\'m Lisa Chen and I have questions about my insurance coverage for a root canal. Staff: I\'d be happy to help you with that. Let me check your coverage details.',
      handler_id: 'staff_002',
      handler_name: 'Jessica Taylor',
      recording_url: 'https://example.com/recordings/mango_call4.mp3',
      sentiment_scores: [
        { time: '0:00', score: 0.2 },
        { time: '1:00', score: 0.3 },
        { time: '2:00', score: 0.4 },
        { time: '3:00', score: 0.5 }
      ]
    },
    {
      id: '5',
      call_id: '5',
      source: 'mango',
      handler_type: 'staff',
      caller_name: 'Robert Brown',
      caller_number: '+1-555-5678',
      call_date: new Date(Date.now() - 43200000).toISOString(),
      reason: 'Appointment confirmation',
      summary: 'Existing patient called to confirm tomorrow\'s appointment. Staff confirmed time and reminded patient of required documents.',
      duration: 90,
      success_status: 'Resolved',
      sentiment: 'positive',
      is_new_patient: false,
      is_emergency: false,
      transfer_status: 'none',
      transfer_attempted: false,
      callback_required: false,
      transcript: 'Staff: Good afternoon, dental office. Caller: Hi, this is Robert Brown. I just wanted to confirm my appointment for tomorrow at 2pm. Staff: Yes, Mr. Brown, you\'re all set for 2pm tomorrow with Dr. Smith. Please bring your insurance card.',
      handler_id: 'staff_001',
      handler_name: 'Maria Garcia',
      recording_url: 'https://example.com/recordings/mango_call5.mp3',
      sentiment_scores: [
        { time: '0:00', score: 0.3 },
        { time: '1:00', score: 0.5 }
      ]
    },
    {
      id: '6',
      call_id: '6',
      source: 'retell',
      handler_type: 'ai',
      caller_name: 'Emily Davis',
      caller_number: '+1-555-9999',
      call_date: new Date(Date.now() - 3600000).toISOString(),
      reason: 'New patient inquiry',
      summary: 'New patient inquiring about services and availability. AI provided information and scheduled initial consultation.',
      duration: 300,
      success_status: 'Resolved',
      sentiment: 'positive',
      is_new_patient: true,
      is_emergency: false,
      transfer_status: 'none',
      transfer_attempted: false,
      callback_required: false,
      transcript: 'Agent: Thank you for calling our dental office. How can I help you today? User: Hi, I\'m Emily Davis and I\'m looking for a new dentist. Can you tell me about your services? Agent: Absolutely! We offer comprehensive dental care including...',
      agent_id: 'agent_001',
      handler_name: 'AI Receptionist',
      recording_url: 'https://example.com/recordings/call6.mp3',
      sentiment_scores: [
        { time: '0:00', score: 0.4 },
        { time: '1:00', score: 0.5 },
        { time: '2:00', score: 0.6 },
        { time: '3:00', score: 0.7 }
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
    setAgentFilter('');
    setTransferFilter('');
    setSourceFilter('');
    setHandlerTypeFilter('');
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

  const getTransferStatusColor = (status) => {
    switch (status) {
      case 'successful': return 'success';
      case 'failed': return 'error';
      case 'voicemail': return 'warning';
      case 'none': return 'default';
      default: return 'default';
    }
  };

  const getTransferStatusIcon = (status) => {
    switch (status) {
      case 'successful': return <SuccessIcon />;
      case 'failed': return <FailedIcon />;
      case 'voicemail': return <VoicemailIcon />;
      default: return <TransferIcon />;
    }
  };

  // Enhanced DataGrid columns with audio playback
  const columns = [
    {
      field: 'caller_name',
      headerName: 'Caller',
      width: 240,
      renderCell: (params) => {
        const isPhoneNumber = params.value?.startsWith('+') || /^\d+$/.test(params.value?.replace(/[-\s()]/g, ''));
        const patientInfo = params.row.patient_match_info;
        
        return (
          <Box display="flex" alignItems="center">
            <Avatar sx={{ 
              width: 32, 
              height: 32, 
              mr: 1, 
              fontSize: '0.875rem',
              bgcolor: params.row.is_new_patient ? 'primary.main' : 'success.main'
            }}>
              {isPhoneNumber ? 'U' : params.value?.charAt(0)?.toUpperCase() || 'U'}
            </Avatar>
            <Box flex={1}>
              <Box display="flex" alignItems="center" gap={0.5}>
                <Typography variant="body2" fontWeight="medium">
                  {isPhoneNumber ? 'Unknown Caller' : params.value}
                </Typography>
                {patientInfo?.matchedBy && (
                  <Tooltip title={`Matched by ${patientInfo.matchedBy === 'phone' ? 'phone number' : 'name'}`}>
                    <CheckCircleIcon sx={{ fontSize: 12, color: 'success.main' }} />
                  </Tooltip>
                )}
              </Box>
              <Typography variant="caption" color="textSecondary">
                {params.row.caller_number}
              </Typography>
              {isPhoneNumber && (
                <Typography variant="caption" color="warning.main" display="block">
                  Name not identified
                </Typography>
              )}
            </Box>
          </Box>
        );
      },
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
      field: 'transfer_status',
      headerName: 'Transfer Status',
      width: 150,
      renderCell: (params) => {
        const status = params.value || 'none';
        const showCallbackBadge = params.row.callback_required;
        
        if (!params.row.transfer_attempted) {
          return (
            <Chip
              label="No Transfer"
              color="default"
              size="small"
              variant="outlined"
            />
          );
        }
        
        return (
          <Box display="flex" alignItems="center" gap={0.5}>
            <Chip
              icon={getTransferStatusIcon(status)}
              label={status === 'successful' ? 'Success' : 
                     status === 'failed' ? 'Failed' : 
                     status === 'voicemail' ? 'Voicemail' : 'Unknown'}
              color={getTransferStatusColor(status)}
              size="small"
            />
            {showCallbackBadge && (
              <Tooltip title="Callback Required">
                <CallbackIcon sx={{ color: 'error.main', fontSize: 16 }} />
              </Tooltip>
            )}
          </Box>
        );
      },
    },
    {
      field: 'source',
      headerName: 'Source',
      width: 120,
      renderCell: (params) => {
        const source = params.value || (params.row.handler_type === 'staff' ? 'mango' : 'retell');
        const handlerType = params.row.handler_type || (source === 'mango' ? 'staff' : 'ai');
        
        return (
          <Box display="flex" alignItems="center" gap={0.5}>
            <Chip
              icon={handlerType === 'ai' ? <AIIcon sx={{ fontSize: 16 }} /> : <StaffIcon sx={{ fontSize: 16 }} />}
              label={handlerType === 'ai' ? 'AI' : 'Staff'}
              size="small"
              color={handlerType === 'ai' ? 'primary' : 'secondary'}
              variant="outlined"
              sx={{ 
                '& .MuiChip-icon': { marginLeft: '4px' },
                minWidth: 70,
              }}
            />
          </Box>
        );
      },
    },
    {
      field: 'handler_name',
      headerName: 'Handler',
      width: 150,
      renderCell: (params) => {
        const handlerType = params.row.handler_type || 'ai';
        const handlerName = params.value || params.row.handler_id;
        const agent = agents.find(a => a.agent_id === params.row.agent_id || a.agent_id === params.row.handler_id);
        
        return (
          <Box display="flex" alignItems="center">
            <Avatar 
              sx={{ 
                width: 24, 
                height: 24, 
                mr: 1, 
                fontSize: '0.7rem',
                bgcolor: handlerType === 'ai' ? 'primary.main' : 'secondary.main'
              }}
            >
              {handlerType === 'ai' ? 'AI' : 'ST'}
            </Avatar>
            <Typography variant="body2" noWrap>
              {agent?.agent_name || handlerName || (handlerType === 'ai' ? 'AI Agent' : 'Staff')}
            </Typography>
          </Box>
        );
      },
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
      width: 140,
      renderCell: (params) => {
        const patientInfo = params.row.patient_match_info;
        const isNew = params.value;
        
        let tooltipText = isNew ? 'New Patient' : 'Existing Patient';
        if (patientInfo && !isNew) {
          tooltipText += patientInfo.hasAppointmentHistory 
            ? ' (Has appointment history)' 
            : ' (In system, no appointments)';
        }
        
        return (
          <Tooltip title={tooltipText}>
            <Chip
              label={isNew ? 'New' : 'Existing'}
              color={isNew ? 'primary' : 'success'}
              size="small"
              variant={patientInfo?.patientId ? 'filled' : 'outlined'}
            />
          </Tooltip>
        );
      },
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
    <Box sx={{ width: '100%' }}>
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
              boxShadow: 3,
              maxWidth: '1200px'
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

      <Typography variant="h4" gutterBottom sx={{ mb: 3, fontWeight: 'bold', textAlign: 'left' }}>
        Call Management Dashboard
      </Typography>

      {/* Enhanced Statistics Cards with Transfer Metrics */}
      <Grid container spacing={2} sx={{ mb: 3, justifyContent: 'flex-start' }}>
        {/* Row 1: Core Metrics */}
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
          <Card sx={{ height: '100%', background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)' }}>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box sx={{ color: 'white' }}>
                  <Typography color="inherit" variant="body2" gutterBottom>
                    Transfer Success
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.transferSuccessRate}%
                  </Typography>
                  <Typography variant="caption" color="inherit">
                    {stats.successfulTransfers}/{stats.transferAttempted} transfers
                  </Typography>
                </Box>
                <SuccessIcon sx={{ color: 'white', fontSize: 40, opacity: 0.8 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={2.4}>
          <Card sx={{ height: '100%', background: stats.callbackRequired > 0 ? 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box sx={{ color: 'white' }}>
                  <Typography color="inherit" variant="body2" gutterBottom>
                    Callbacks Needed
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.callbackRequired}
                  </Typography>
                  <Typography variant="caption" color="inherit">
                    Failed transfers & voicemails
                  </Typography>
                </Box>
                <CallbackIcon sx={{ color: 'white', fontSize: 40, opacity: 0.8 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={2.4}>
          <Card sx={{ height: '100%', background: stats.emergencyCalls > 0 ? 'linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%)' : 'linear-gradient(135deg, #a8e6cf 0%, #88d8a3 100%)' }}>
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

        {/* Row 2: Transfer Breakdown */}
        <Grid item xs={12} sm={6} lg={2.4}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Box display="flex" alignItems="center" mb={1}>
                <SuccessIcon color="success" sx={{ mr: 1 }} />
                <Typography variant="body2" color="textSecondary">
                  Successful Transfers
                </Typography>
              </Box>
              <Typography variant="h5" fontWeight="bold" color="success.main">
                {stats.successfulTransfers}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={2.4}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Box display="flex" alignItems="center" mb={1}>
                <FailedIcon color="error" sx={{ mr: 1 }} />
                <Typography variant="body2" color="textSecondary">
                  Failed Transfers
                </Typography>
              </Box>
              <Typography variant="h5" fontWeight="bold" color="error.main">
                {stats.failedTransfers}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={2.4}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Box display="flex" alignItems="center" mb={1}>
                <VoicemailIcon color="warning" sx={{ mr: 1 }} />
                <Typography variant="body2" color="textSecondary">
                  Voicemails Left
                </Typography>
              </Box>
              <Typography variant="h5" fontWeight="bold" color="warning.main">
                {stats.voicemailTransfers}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={2.4}>
          <Card sx={{ height: '100%', background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' }}>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box sx={{ color: 'white' }}>
                  <Typography color="inherit" variant="body2" gutterBottom>
                    AI Handled
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.aiCalls}
                  </Typography>
                  <Typography variant="caption" color="inherit">
                    Retell AI calls
                  </Typography>
                </Box>
                <AIIcon sx={{ color: 'white', fontSize: 40, opacity: 0.8 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={2.4}>
          <Card sx={{ height: '100%', background: 'linear-gradient(135deg, #ec4899 0%, #f472b6 100%)' }}>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box sx={{ color: 'white' }}>
                  <Typography color="inherit" variant="body2" gutterBottom>
                    Staff Handled
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.staffCalls}
                  </Typography>
                  <Typography variant="caption" color="inherit">
                    Mango Voice calls
                  </Typography>
                </Box>
                <StaffIcon sx={{ color: 'white', fontSize: 40, opacity: 0.8 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={2.4}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Box display="flex" alignItems="center" mb={1}>
                <ScheduleIcon color="primary" sx={{ mr: 1 }} />
                <Typography variant="body2" color="textSecondary">
                  Avg Duration
                </Typography>
              </Box>
              <Typography variant="h5" fontWeight="bold" color="primary.main">
                {formatDuration(stats.averageDuration)}
              </Typography>
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

      {/* Enhanced Search and Filter Controls - COMPACT */}
      <Card sx={{ mb: 3 }}>
        <CardContent sx={{ pl: 2, pr: 2 }}>
          <Grid container spacing={2} alignItems="center" justifyContent="flex-start">
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



            <Grid item xs={6} md={1.5}>
              <FormControl fullWidth size="small">
                <InputLabel>Transfer</InputLabel>
                <Select
                  value={transferFilter}
                  label="Transfer"
                  onChange={(e) => setTransferFilter(e.target.value)}
                >
                  <MenuItem value="">All</MenuItem>
                  <MenuItem value="successful">Successful</MenuItem>
                  <MenuItem value="failed">Failed</MenuItem>
                  <MenuItem value="voicemail">Voicemail</MenuItem>
                  <MenuItem value="callback_needed">Callback Needed</MenuItem>
                  <MenuItem value="no_transfer">No Transfer</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={6} md={1.5}>
              <FormControl fullWidth size="small">
                <InputLabel>Handler</InputLabel>
                <Select
                  value={handlerTypeFilter}
                  label="Handler"
                  onChange={(e) => setHandlerTypeFilter(e.target.value)}
                >
                  <MenuItem value="">All Handlers</MenuItem>
                  <MenuItem value="ai">
                    <Box display="flex" alignItems="center" gap={1}>
                      <AIIcon fontSize="small" color="primary" />
                      AI Agents
                    </Box>
                  </MenuItem>
                  <MenuItem value="staff">
                    <Box display="flex" alignItems="center" gap={1}>
                      <StaffIcon fontSize="small" color="secondary" />
                      Staff
                    </Box>
                  </MenuItem>
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

      {/* Enhanced Calls Table - LEFT ALIGNED */}
      <Box display="flex" justifyContent="flex-start" mb={3}>
        <Card sx={{ width: '100%', maxWidth: '1200px' }}>
          <CardContent sx={{ pl: 2, pr: 2 }}>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h6">
                Call History ({filteredCalls.length} {filteredCalls.length === 1 ? 'call' : 'calls'})
              </Typography>
              
              {/* Primary Agent & Office Filters */}
              <Box display="flex" gap={2} alignItems="center">
                {/* Agent Filter - Now Primary */}
                <FormControl size="small" sx={{ minWidth: 180 }}>
                  <InputLabel>Filter by Agent</InputLabel>
                  <Select
                    value={agentFilter}
                    label="Filter by Agent"
                    onChange={(e) => setAgentFilter(e.target.value)}
                  >
                    <MenuItem value="">All Available Agents</MenuItem>
                    {availableAgents.map((agent) => (
                      <MenuItem key={agent.agent_id} value={agent.agent_id}>
                        {agent.agent_name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                {/* Office Configuration */}
                <FormControl size="small" sx={{ minWidth: 150 }}>
                  <InputLabel>Office</InputLabel>
                  <Select
                    value={officeId}
                    label="Office"
                    onChange={(e) => setOfficeId(e.target.value)}
                  >
                    {officeConfigs.map((config) => (
                      <MenuItem key={config.id} value={config.id}>
                        {config.name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Box>
            </Box>
            
            <Box sx={{ height: 600, width: '100%', ml: 0 }}>
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

            {/* Transfer Information */}
            {selectedCall.transfer_attempted && (
              <Card sx={{ mb: 3 }}>
                <CardContent>
                  <Box display="flex" alignItems="center" mb={2}>
                    <TransferIcon sx={{ mr: 1 }} />
                    <Typography variant="h6">Transfer Details</Typography>
                  </Box>
                  <Grid container spacing={2}>
                    <Grid item xs={12} sm={6}>
                      <Typography variant="subtitle2" color="textSecondary">Transfer Status</Typography>
                      <Box display="flex" alignItems="center" gap={1} mt={1}>
                        <Chip
                          icon={getTransferStatusIcon(selectedCall.transfer_status)}
                          label={selectedCall.transfer_status === 'successful' ? 'Successful' : 
                                 selectedCall.transfer_status === 'failed' ? 'Failed' : 
                                 selectedCall.transfer_status === 'voicemail' ? 'Voicemail Left' : 'Unknown'}
                          color={getTransferStatusColor(selectedCall.transfer_status)}
                        />
                        {selectedCall.callback_required && (
                          <Chip
                            icon={<CallbackIcon />}
                            label="Callback Required"
                            color="error"
                            variant="outlined"
                          />
                        )}
                      </Box>
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <Typography variant="subtitle2" color="textSecondary">Destination</Typography>
                      <Typography variant="body1" sx={{ mt: 1 }}>
                        {selectedCall.transfer_destination || 'Not specified'}
                      </Typography>
                    </Grid>
                    {selectedCall.transfer_timestamp && (
                      <Grid item xs={12}>
                        <Typography variant="subtitle2" color="textSecondary">Transfer Time</Typography>
                        <Typography variant="body2" sx={{ mt: 1 }}>
                          {new Date(selectedCall.transfer_timestamp).toLocaleString()}
                        </Typography>
                      </Grid>
                    )}
                    {selectedCall.callback_reason && (
                      <Grid item xs={12}>
                        <Typography variant="subtitle2" color="textSecondary">Callback Reason</Typography>
                        <Typography variant="body2" sx={{ mt: 1, color: 'error.main' }}>
                          {selectedCall.callback_reason}
                        </Typography>
                      </Grid>
                    )}
                  </Grid>
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
    </Box>
  );
};

export default Dashboard; 