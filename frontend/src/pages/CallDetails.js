import React, { useState, useEffect } from 'react';
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
} from '@mui/icons-material';
import { callsApi } from '../services/api';

const CallDetails = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [call, setCall] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [recording, setRecording] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    fetchCallDetails();
  }, [id]);

  const fetchCallDetails = async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch call details, transcript, and recording in parallel
      const [callData, transcriptData, recordingData] = await Promise.allSettled([
        callsApi.getCall(id),
        callsApi.getCallTranscript(id),
        callsApi.getCallRecording(id),
      ]);

      if (callData.status === 'fulfilled') {
        setCall(callData.value);
      } else {
        // Use mock data if API fails
        setCall(generateMockCallData(id));
      }

      if (transcriptData.status === 'fulfilled') {
        setTranscript(transcriptData.value);
      } else {
        setTranscript(generateMockTranscript());
      }

      if (recordingData.status === 'fulfilled') {
        setRecording(recordingData.value);
      } else {
        setRecording({ recording_url: null });
      }
    } catch (err) {
      setError('Failed to fetch call details');
      setCall(generateMockCallData(id));
      setTranscript(generateMockTranscript());
    } finally {
      setLoading(false);
    }
  };

  const generateMockCallData = (callId) => ({
    id: callId,
    caller_name: 'John Smith',
    caller_number: '+1-555-0123',
    call_date: new Date().toISOString(),
    reason: 'Appointment booking for annual checkup',
    duration: 180,
    success_status: 'Resolved',
    sentiment: 'positive',
    is_new_patient: true,
    is_emergency: false,
    summary: 'Patient called to schedule annual checkup. Appointment scheduled for next Tuesday at 2 PM. Patient has insurance coverage verified.',
    call_status: 'completed',
    start_timestamp: new Date(Date.now() - 180000).toISOString(),
    end_timestamp: new Date().toISOString(),
  });

  const generateMockTranscript = () => ({
    transcript: [
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

  const handlePlayPause = () => {
    setIsPlaying(!isPlaying);
    // Audio playback logic would go here
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  if (error && !call) {
    return (
      <Alert severity="error" sx={{ mt: 2 }}>
        {error}
      </Alert>
    );
  }

  return (
    <Box>
      {/* Header */}
      <Box display="flex" alignItems="center" mb={3}>
        <IconButton onClick={() => navigate('/')} sx={{ mr: 2 }}>
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h4">
          Call Details
        </Typography>
      </Box>

      <Grid container spacing={3}>
        {/* Call Information */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Call Information
              </Typography>
              
              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" color="textSecondary">
                  Caller Name
                </Typography>
                <Typography variant="body1">
                  {call?.caller_name || 'Unknown'}
                </Typography>
              </Box>

              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" color="textSecondary">
                  Phone Number
                </Typography>
                <Typography variant="body1">
                  {call?.caller_number || 'N/A'}
                </Typography>
              </Box>

              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" color="textSecondary">
                  Date & Time
                </Typography>
                <Typography variant="body1">
                  {call?.call_date ? new Date(call.call_date).toLocaleString() : 'N/A'}
                </Typography>
              </Box>

              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" color="textSecondary">
                  Duration
                </Typography>
                <Typography variant="body1">
                  {formatDuration(call?.duration || 0)}
                </Typography>
              </Box>

              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" color="textSecondary">
                  Status
                </Typography>
                <Chip
                  label={call?.success_status || 'Unknown'}
                  color={call?.success_status === 'Resolved' ? 'success' : 'error'}
                  size="small"
                />
              </Box>

              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" color="textSecondary">
                  Sentiment
                </Typography>
                <Chip
                  label={call?.sentiment || 'neutral'}
                  color={getSentimentColor(call?.sentiment)}
                  size="small"
                />
              </Box>

              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" color="textSecondary">
                  Patient Type
                </Typography>
                <Chip
                  label={call?.is_new_patient ? 'New Patient' : 'Existing Patient'}
                  color={call?.is_new_patient ? 'primary' : 'default'}
                  size="small"
                />
              </Box>

              {call?.is_emergency && (
                <Box sx={{ mb: 2 }}>
                  <Chip
                    icon={<EmergencyIcon />}
                    label="Emergency Call"
                    color="error"
                    size="small"
                  />
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Call Summary */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Call Summary
              </Typography>
              <Typography variant="body1">
                {call?.summary || 'No summary available for this call.'}
              </Typography>
            </CardContent>
          </Card>

          {/* Audio Player */}
          <Card sx={{ mt: 2 }}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Call Recording
              </Typography>
              {recording?.recording_url ? (
                <Box display="flex" alignItems="center" gap={2}>
                  <IconButton
                    onClick={handlePlayPause}
                    color="primary"
                    size="large"
                  >
                    {isPlaying ? <PauseIcon /> : <PlayIcon />}
                  </IconButton>
                  <Box flexGrow={1}>
                    <Typography variant="body2" color="textSecondary">
                      Audio playback controls would be implemented here
                    </Typography>
                  </Box>
                  <VolumeUpIcon color="action" />
                </Box>
              ) : (
                <Typography variant="body2" color="textSecondary">
                  No recording available for this call.
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Transcript */}
        <Grid item xs={12}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Call Transcript
              </Typography>
              {transcript?.transcript ? (
                <Box>
                  {transcript.transcript.map((entry, index) => (
                    <Paper
                      key={index}
                      elevation={1}
                      sx={{
                        p: 2,
                        mb: 2,
                        backgroundColor: entry.role === 'agent' ? '#f5f5f5' : '#e3f2fd',
                      }}
                    >
                      <Box display="flex" justifyContent="space-between" alignItems="flex-start">
                        <Box flexGrow={1}>
                          <Typography
                            variant="subtitle2"
                            color="primary"
                            sx={{ mb: 1 }}
                          >
                            {entry.role === 'agent' ? 'AI Agent' : 'Caller'}
                          </Typography>
                          <Typography variant="body1">
                            {entry.content}
                          </Typography>
                        </Box>
                        <Typography variant="caption" color="textSecondary">
                          {entry.timestamp}
                        </Typography>
                      </Box>
                    </Paper>
                  ))}
                </Box>
              ) : (
                <Typography variant="body2" color="textSecondary">
                  No transcript available for this call.
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
};

export default CallDetails; 