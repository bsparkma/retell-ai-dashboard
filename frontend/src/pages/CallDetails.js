import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Card,
  CardContent,
  Grid,
  Chip,
  Button,
  Divider,
  Paper,
  IconButton,
  Tooltip,
  CircularProgress,
  Alert,
  Container,
  LinearProgress,
  Stack,
  Avatar,
  useTheme,
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  Phone as PhoneIcon,
  Schedule as ScheduleIcon,
  Person as PersonIcon,
  Sentiment as SentimentIcon,
  ReportProblem as EmergencyIcon,
  PlayArrow as PlayIcon,
  Pause as PauseIcon,
  VolumeUp as VolumeUpIcon,
  Mic as MicIcon,
  Psychology as PsychologyIcon,
  SupportAgent as AgentIcon,
  SmartToy as AIIcon,
  Headset as StaffIcon,
  LocalHospital as DentalIcon,
  Link as LinkIcon,
  Sync as SyncIcon,
  CheckCircle as CheckIcon,
} from '@mui/icons-material';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { callsApi, unifiedCallsApi, openDentalSyncApi, mangoApi } from '../services/api';
import { AudioSyncPlayer, ChatBubbleTranscript } from '../components/Transcript';
import { PatientLinkDialog, SyncStatusBadge } from '../components/OpenDental';

const CallDetails = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const theme = useTheme();
  const audioRef = useRef(null);
  
  const [call, setCall] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [recording, setRecording] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [currentPlaybackTime, setCurrentPlaybackTime] = useState(0);
  
  // Open Dental sync state
  const [patientLinkDialogOpen, setPatientLinkDialogOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [fetchingMango, setFetchingMango] = useState(false);

  useEffect(() => {
    if (id) {
      fetchCallDetails();
      fetchSyncStatus();
    } else {
      setError('No call ID provided');
      setLoading(false);
    }
  }, [id]);

  // Fetch Open Dental sync status
  const fetchSyncStatus = async () => {
    try {
      const status = await openDentalSyncApi.getCallSyncStatus(id);
      setSyncStatus(status);
    } catch (err) {
      console.log('Sync status not available:', err.message);
      setSyncStatus(null);
    }
  };

  // Handle sync to Open Dental
  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await openDentalSyncApi.syncCall(id, { includeTranscript: true });
      if (result.success) {
        fetchSyncStatus();
      } else if (result.requiresManualLink) {
        setPatientLinkDialogOpen(true);
      }
    } catch (err) {
      console.error('Sync failed:', err);
      if (err.response?.data?.requiresManualLink) {
        setPatientLinkDialogOpen(true);
      }
    } finally {
      setSyncing(false);
    }
  };

  const handleFetchMangoRecording = async () => {
    if (!call?.mango_call_id) return;
    setFetchingMango(true);
    try {
      const result = await mangoApi.fetchRecordingAndTranscript(call.mango_call_id);
      if (result?.success) {
        await fetchCallDetails();
      } else {
        alert(result?.message || 'No recording available for this Mango call.');
      }
    } catch (e) {
      alert(`Failed to fetch Mango recording: ${e.message}`);
    } finally {
      setFetchingMango(false);
    }
  };

  // Handle successful patient link
  const handleLinkSuccess = () => {
    fetchSyncStatus();
    fetchCallDetails();
  };

  const fetchCallDetails = async () => {
    try {
      setLoading(true);
      setError(null);

      // Unified API contains call + transcript + recording_url for both Retell + Mango
      // We still keep legacy fallbacks for older data paths.
      const unified = await unifiedCallsApi.getCall(id);

      if (unified) {
        setCall(unified);
        setTranscript({
          transcript: unified.transcript || null,
          transcript_object: unified.transcript_object || null,
          transcript_json: unified.transcript_json || unified.transcript_object || null,
        });
        setRecording({
          recording_url: unified.recording_url || null,
          recording_path: unified.recording_path || null,
        });
        return;
      }

      // Fallback: legacy endpoints
      const [callResponse, transcriptResponse, recordingResponse] = await Promise.allSettled([
        callsApi.getCall(id),
        callsApi.getCallTranscript(id),
        callsApi.getCallRecording(id),
      ]);

      if (callResponse.status === 'fulfilled' && callResponse.value) setCall(callResponse.value);
      else setCall(generateMockCallData(id));

      if (transcriptResponse.status === 'fulfilled' && transcriptResponse.value) setTranscript(transcriptResponse.value);
      else setTranscript(generateMockTranscript());

      if (recordingResponse.status === 'fulfilled' && recordingResponse.value) setRecording(recordingResponse.value);
      else setRecording({ recording_url: null });
    } catch (err) {
      console.error('Error fetching call details:', err);
      setError('Failed to load call details. Using demo data.');
      setCall(generateMockCallData(id));
      setTranscript(generateMockTranscript());
      setRecording({ recording_url: null });
    } finally {
      setLoading(false);
    }
  };

  const generateMockCallData = (callId) => ({
    id: callId,
    call_id: callId,
    caller_name: 'John Smith',
    caller_number: '+1-555-0123',
    call_date: new Date().toISOString(),
    reason: 'Appointment booking for annual checkup',
    duration: 180,
    success_status: 'Resolved',
    sentiment: 'positive',
    is_new_patient: true,
    is_emergency: false,
    summary: 'Patient called to schedule annual checkup. Appointment scheduled for next Tuesday at 2 PM. Patient has insurance coverage verified and confirmed availability.',
    call_status: 'completed',
    start_timestamp: new Date(Date.now() - 180000).toISOString(),
    end_timestamp: new Date().toISOString(),
    agent_id: 'agent_001',
    sentiment_scores: [
      { time: '0:00', score: 0.7 },
      { time: '1:00', score: 0.8 },
      { time: '2:00', score: 0.9 },
      { time: '3:00', score: 0.8 }
    ]
  });

  const generateMockTranscript = () => ({
    transcript: 'Agent: Hello! Thank you for calling our medical practice. I\'m here to help you today. How can I assist you?\nUser: Hi, I\'d like to schedule an appointment for my annual checkup.\nAgent: I\'d be happy to help you schedule your annual checkup. Can I start by getting your full name and date of birth?\nUser: Yes, it\'s John Smith, born March 15th, 1985.\nAgent: Thank you, Mr. Smith. I see you\'re a new patient with us. Let me check our available appointment slots for annual checkups.\nUser: That sounds great. I\'m pretty flexible with timing.\nAgent: Perfect! I have availability next Tuesday, March 21st at 2:00 PM with Dr. Johnson. Would that work for you?\nUser: Yes, that works perfectly for me.\nAgent: Excellent! I\'ve scheduled your appointment for Tuesday, March 21st at 2:00 PM. You\'ll receive a confirmation text shortly. Is there anything else I can help you with today?\nUser: No, that\'s everything. Thank you so much for your help!\nAgent: You\'re very welcome, Mr. Smith! We look forward to seeing you next Tuesday. Have a great day!',
    transcript_object: [
      {
        role: 'agent',
        content: 'Hello! Thank you for calling our medical practice. I\'m here to help you today. How can I assist you?',
        timestamp: '00:00:05',
      },
      {
        role: 'user',
        content: 'Hi, I\'d like to schedule an appointment for my annual checkup.',
        timestamp: '00:00:12',
      },
      {
        role: 'agent',
        content: 'I\'d be happy to help you schedule your annual checkup. Can I start by getting your full name and date of birth?',
        timestamp: '00:00:18',
      },
      {
        role: 'user',
        content: 'Yes, it\'s John Smith, born March 15th, 1985.',
        timestamp: '00:00:25',
      },
      {
        role: 'agent',
        content: 'Thank you, Mr. Smith. I see you\'re a new patient with us. Let me check our available appointment slots for annual checkups.',
        timestamp: '00:00:32',
      },
      {
        role: 'user',
        content: 'That sounds great. I\'m pretty flexible with timing.',
        timestamp: '00:00:40',
      },
      {
        role: 'agent',
        content: 'Perfect! I have availability next Tuesday, March 21st at 2:00 PM with Dr. Johnson. Would that work for you?',
        timestamp: '00:00:45',
      },
      {
        role: 'user',
        content: 'Yes, that works perfectly for me.',
        timestamp: '00:00:52',
      },
      {
        role: 'agent',
        content: 'Excellent! I\'ve scheduled your appointment for Tuesday, March 21st at 2:00 PM. You\'ll receive a confirmation text shortly. Is there anything else I can help you with today?',
        timestamp: '00:00:58',
      },
      {
        role: 'user',
        content: 'No, that\'s everything. Thank you so much for your help!',
        timestamp: '00:01:10',
      },
      {
        role: 'agent',
        content: 'You\'re very welcome, Mr. Smith! We look forward to seeing you next Tuesday. Have a great day!',
        timestamp: '00:01:15',
      },
    ],
  });

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

  const handleAudioPlay = async () => {
    try {
      if (isPlaying) {
        if (audioRef.current) {
          audioRef.current.pause();
        }
        setIsPlaying(false);
        return;
      }

      if (recording?.recording_url) {
        if (audioRef.current) {
          audioRef.current.src = recording.recording_url;
          await audioRef.current.play();
          setIsPlaying(true);
        }
      } else {
        // Mock audio playback for demo
        console.log('Playing mock audio for call', id);
        setIsPlaying(true);
        setTimeout(() => {
          setIsPlaying(false);
        }, 3000);
      }
    } catch (error) {
      console.error('Error playing audio:', error);
      setIsPlaying(false);
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
    setAudioProgress(0);
    setAudioCurrentTime(0);
  };

  if (loading) {
    return (
      <Box sx={{ width: '100%' }}>
        <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
          <Stack alignItems="center" spacing={2}>
            <CircularProgress />
            <Typography>Loading call details...</Typography>
          </Stack>
        </Box>
      </Box>
    );
  }

  if (!call) {
    return (
      <Box sx={{ width: '100%' }}>
        <Alert severity="error" sx={{ mt: 2 }}>
          <Typography variant="h6">Call Not Found</Typography>
          <Typography>The requested call could not be found.</Typography>
          <Button 
            variant="outlined" 
            onClick={() => navigate('/dashboard')} 
            sx={{ mt: 2 }}
          >
            Return to Dashboard
          </Button>
        </Alert>
      </Box>
    );
  }

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

      {/* Header */}
      <Box display="flex" alignItems="center" mb={3}>
        <IconButton 
          onClick={() => navigate('/dashboard')} 
          sx={{ mr: 2 }}
        >
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h4" fontWeight="bold">
          Call Details
        </Typography>
      </Box>

      {/* Error Alert */}
      {error && (
        <Alert severity="warning" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Emergency Badge */}
      {call.is_emergency && (
        <Alert severity="error" sx={{ mb: 3 }}>
          <Box display="flex" alignItems="center">
            <EmergencyIcon sx={{ mr: 1 }} />
            <Typography variant="h6" fontWeight="bold">
              Emergency Call - Immediate Attention Required
            </Typography>
          </Box>
        </Alert>
      )}

      {/* Call Overview Cards */}
      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Box display="flex" alignItems="center" mb={2}>
                <Avatar sx={{ mr: 2, bgcolor: 'primary.main' }}>
                  {call.caller_name?.charAt(0) || 'U'}
                </Avatar>
                <Box>
                  <Typography variant="h6" fontWeight="bold">
                    {call.caller_name}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    {call.caller_number}
                  </Typography>
                </Box>
              </Box>
              <Box display="flex" alignItems="center" gap={1}>
                <Chip
                  label={call.is_new_patient ? 'New Patient' : 'Existing Patient'}
                  color={call.is_new_patient ? 'primary' : 'default'}
                  size="small"
                />
                {call.is_emergency && (
                  <Chip
                    label="Emergency"
                    color="error"
                    size="small"
                    icon={<EmergencyIcon />}
                  />
                )}
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" fontWeight="bold" gutterBottom>
                Call Information
              </Typography>
              <Stack spacing={1}>
                <Box display="flex" justifyContent="space-between">
                  <Typography variant="body2" color="textSecondary">Date & Time:</Typography>
                  <Typography variant="body2">
                    {new Date(call.call_date).toLocaleString()}
                  </Typography>
                </Box>
                <Box display="flex" justifyContent="space-between">
                  <Typography variant="body2" color="textSecondary">Duration:</Typography>
                  <Typography variant="body2">
                    {formatDuration(call.duration)}
                  </Typography>
                </Box>
                <Box display="flex" justifyContent="space-between">
                  <Typography variant="body2" color="textSecondary">Status:</Typography>
                  <Chip
                    label={call.success_status}
                    color={call.success_status === 'Resolved' ? 'success' : 'error'}
                    size="small"
                  />
                </Box>
                <Box display="flex" justifyContent="space-between">
                  <Typography variant="body2" color="textSecondary">Sentiment:</Typography>
                  <Chip
                    label={call.sentiment || 'neutral'}
                    color={getSentimentColor(call.sentiment)}
                    size="small"
                  />
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Call Reason */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" fontWeight="bold" gutterBottom>
            Call Reason
          </Typography>
          <Typography variant="body1">
            {call.reason}
          </Typography>
        </CardContent>
      </Card>

      {/* Audio Player - New enhanced version */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" alignItems="center" mb={2}>
            <VolumeUpIcon sx={{ mr: 1 }} />
            <Typography variant="h6" fontWeight="bold">
              Audio Recording
            </Typography>
            {call.source && (
              <Chip
                icon={call.handler_type === 'staff' ? <StaffIcon /> : <AIIcon />}
                label={call.handler_type === 'staff' ? 'Staff Call' : 'AI Call'}
                size="small"
                color={call.handler_type === 'staff' ? 'secondary' : 'primary'}
                variant="outlined"
                sx={{ ml: 2 }}
              />
            )}
          </Box>

          {call.source === 'mango' && !(recording?.recording_url || call.recording_url) && call.mango_call_id && (
            <Box sx={{ mb: 2 }}>
              <Button
                variant="outlined"
                onClick={handleFetchMangoRecording}
                disabled={fetchingMango}
                startIcon={fetchingMango ? <CircularProgress size={16} /> : <SyncIcon />}
              >
                {fetchingMango ? 'Fetching recording…' : 'Fetch Mango Recording + Transcript'}
              </Button>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                Mango recordings require an on-demand fetch if they weren’t downloaded during sync.
              </Typography>
            </Box>
          )}

          <AudioSyncPlayer
            audioUrl={recording?.recording_url || call.recording_url}
            duration={call.duration_seconds || call.duration || 0}
            onTimeUpdate={(time) => setCurrentPlaybackTime(time)}
            onSeek={(time) => setCurrentPlaybackTime(time)}
          />
        </CardContent>
      </Card>

      {/* Sentiment Analysis */}
      {call.sentiment_scores && call.sentiment_scores.length > 0 && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Box display="flex" alignItems="center" mb={2}>
              <PsychologyIcon sx={{ mr: 1 }} />
              <Typography variant="h6" fontWeight="bold">
                Sentiment Analysis Over Time
              </Typography>
            </Box>
            <Box sx={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={call.sentiment_scores} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
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

      {/* Handler Information - Supports both AI and Staff */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" alignItems="center" mb={2}>
            {call.handler_type === 'staff' ? <StaffIcon sx={{ mr: 1 }} /> : <AgentIcon sx={{ mr: 1 }} />}
            <Typography variant="h6" fontWeight="bold">
              {call.handler_type === 'staff' ? 'Staff Handler' : 'AI Agent'}
            </Typography>
          </Box>
          <Box display="flex" alignItems="center">
            <Avatar 
              sx={{ 
                mr: 2, 
                bgcolor: call.handler_type === 'staff' ? 'secondary.main' : 'primary.main' 
              }}
            >
              {call.handler_type === 'staff' ? 'ST' : 'AI'}
            </Avatar>
            <Box>
              <Typography variant="body1" fontWeight="medium">
                {call.handler_name || (call.handler_type === 'staff' ? 'Staff Member' : `AI Agent ${call.agent_id || ''}`)}
              </Typography>
              <Typography variant="body2" color="textSecondary">
                {call.handler_type === 'staff' 
                  ? 'Mango Voice Staff Call' 
                  : 'Retell AI Voice Assistant'
                }
              </Typography>
              {call.source && (
                <Chip
                  label={call.source === 'mango' ? 'Mango Voice' : 'Retell AI'}
                  size="small"
                  color={call.source === 'mango' ? 'secondary' : 'primary'}
                  variant="outlined"
                  sx={{ mt: 1 }}
                />
              )}
            </Box>
          </Box>
        </CardContent>
      </Card>

      {/* Call Summary */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" fontWeight="bold" gutterBottom>
            Call Summary
          </Typography>
          <Typography variant="body1" sx={{ lineHeight: 1.6 }}>
            {call.summary}
          </Typography>
        </CardContent>
      </Card>

      {/* Open Dental Sync Section */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
            <Box display="flex" alignItems="center">
              <DentalIcon sx={{ mr: 1 }} color="primary" />
              <Typography variant="h6" fontWeight="bold">
                Open Dental Integration
              </Typography>
            </Box>
            <SyncStatusBadge status={syncStatus?.syncStatus || call.od_sync_status} />
          </Box>
          
          <Divider sx={{ mb: 2 }} />
          
          {/* Patient Link Info */}
          {syncStatus?.patientId || call.od_patient_id ? (
            <Box sx={{ mb: 2, p: 2, bgcolor: 'success.light', borderRadius: 1 }}>
              <Box display="flex" alignItems="center" gap={1}>
                <CheckIcon color="success" />
                <Typography fontWeight="medium">
                  Linked to Patient: {syncStatus?.patientName || call.od_patient_name || 'Unknown'}
                </Typography>
              </Box>
              {syncStatus?.syncedAt && (
                <Typography variant="caption" color="text.secondary">
                  Synced on {new Date(syncStatus.syncedAt).toLocaleString()}
                </Typography>
              )}
              {syncStatus?.commLogNum && (
                <Typography variant="caption" display="block" color="text.secondary">
                  CommLog #{syncStatus.commLogNum}
                </Typography>
              )}
            </Box>
          ) : (
            <Box sx={{ mb: 2, p: 2, bgcolor: 'warning.light', borderRadius: 1 }}>
              <Typography color="text.secondary">
                This call is not yet linked to a patient record in Open Dental.
              </Typography>
            </Box>
          )}
          
          {/* Action Buttons */}
          <Box display="flex" gap={2}>
            <Button
              variant="outlined"
              startIcon={<LinkIcon />}
              onClick={() => setPatientLinkDialogOpen(true)}
            >
              {syncStatus?.patientId ? 'Change Patient Link' : 'Link to Patient'}
            </Button>
            
            {syncStatus?.patientId && syncStatus?.syncStatus !== 'synced' && (
              <Button
                variant="contained"
                startIcon={syncing ? <CircularProgress size={16} /> : <SyncIcon />}
                onClick={handleSync}
                disabled={syncing}
              >
                {syncing ? 'Syncing...' : 'Sync to CommLog'}
              </Button>
            )}
            
            {!syncStatus?.patientId && (
              <Button
                variant="contained"
                startIcon={syncing ? <CircularProgress size={16} /> : <SyncIcon />}
                onClick={handleSync}
                disabled={syncing}
              >
                {syncing ? 'Syncing...' : 'Auto-Match & Sync'}
              </Button>
            )}
          </Box>
        </CardContent>
      </Card>

      {/* Transcript - New chat bubble style */}
      <Card>
        <CardContent>
          <Box display="flex" alignItems="center" mb={2}>
            <MicIcon sx={{ mr: 1 }} />
            <Typography variant="h6" fontWeight="bold">
              Call Transcript
            </Typography>
          </Box>
          
          <ChatBubbleTranscript
            transcript={transcript?.transcript || call.transcript}
            transcriptJson={transcript?.transcript_object || transcript?.transcript_json || call.transcript_json || call.transcript_object || null}
            currentTime={currentPlaybackTime}
            onSeek={(time) => {
              setCurrentPlaybackTime(time);
              // If we had a ref to the audio player, we could seek here
            }}
            handlerType={call.handler_type || (call.source === 'mango' ? 'staff' : 'ai')}
            callerName={call.caller_name || 'Caller'}
            agentName={call.handler_name || (call.handler_type === 'staff' ? 'Staff' : 'AI Agent')}
            maxHeight={500}
            showSearch={true}
          />
        </CardContent>
      </Card>

      {/* Back Button */}
      <Box sx={{ mt: 3, textAlign: 'center' }}>
        <Button
          variant="outlined"
          onClick={() => navigate('/dashboard')}
          startIcon={<ArrowBackIcon />}
        >
          Back to Dashboard
        </Button>
      </Box>

      {/* Patient Link Dialog */}
      <PatientLinkDialog
        open={patientLinkDialogOpen}
        onClose={() => setPatientLinkDialogOpen(false)}
        call={call}
        onLinkSuccess={handleLinkSuccess}
      />
    </Box>
  );
};

export default CallDetails; 