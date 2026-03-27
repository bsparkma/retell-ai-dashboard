/**
 * Live Call Card Component
 * 
 * Displays a single active call with real-time updates.
 */

import React, { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  Box,
  Typography,
  Avatar,
  Chip,
  IconButton,
  Collapse,
  LinearProgress,
  Tooltip,
  Badge,
  keyframes,
} from '@mui/material';
import {
  Phone as PhoneIcon,
  ExpandMore as ExpandIcon,
  ExpandLess as CollapseIcon,
  Warning as EmergencyIcon,
  Visibility as ViewIcon,
  SmartToy as AgentIcon,
} from '@mui/icons-material';
import SentimentGauge from './SentimentGauge';
import LiveTranscript from './LiveTranscript';

// Pulsing animation for live indicator
const pulse = keyframes`
  0% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.2); opacity: 0.7; }
  100% { transform: scale(1); opacity: 1; }
`;

const LiveIndicator = () => (
  <Box
    sx={{
      width: 10,
      height: 10,
      borderRadius: '50%',
      bgcolor: 'error.main',
      animation: `${pulse} 1.5s ease-in-out infinite`,
      boxShadow: '0 0 8px rgba(244, 67, 54, 0.6)',
    }}
  />
);

const LiveCallCard = ({ call, onSelect, isSelected = false }) => {
  const [expanded, setExpanded] = useState(false);
  const [duration, setDuration] = useState(call.duration || 0);

  // Update duration every second
  useEffect(() => {
    const interval = setInterval(() => {
      if (call.started_at) {
        const startTime = new Date(call.started_at);
        const now = Date.now();
        setDuration(Math.floor((now - startTime) / 1000));
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [call.started_at]);

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleExpandClick = (e) => {
    e.stopPropagation();
    setExpanded(!expanded);
  };

  const handleCardClick = () => {
    if (onSelect) {
      onSelect(call.call_id);
    }
  };

  return (
    <Card
      sx={{
        mb: 2,
        cursor: 'pointer',
        border: isSelected ? 2 : 1,
        borderColor: isSelected ? 'primary.main' : 'divider',
        transition: 'all 0.2s ease-in-out',
        '&:hover': {
          boxShadow: 4,
          transform: 'translateY(-2px)',
        },
        ...(call.is_emergency && {
          borderColor: 'error.main',
          borderWidth: 2,
          animation: `${pulse} 2s ease-in-out infinite`,
        }),
      }}
      onClick={handleCardClick}
    >
      <CardContent sx={{ pb: expanded ? 2 : '16px !important' }}>
        {/* Header Row */}
        <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
          <Box display="flex" alignItems="center" gap={2}>
            {/* Live Indicator */}
            <LiveIndicator />
            
            {/* Caller Avatar */}
            <Badge
              overlap="circular"
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              badgeContent={
                call.is_emergency ? (
                  <EmergencyIcon sx={{ fontSize: 14, color: 'error.main' }} />
                ) : null
              }
            >
              <Avatar
                sx={{
                  width: 48,
                  height: 48,
                  bgcolor: call.is_emergency ? 'error.main' : 'primary.main',
                }}
              >
                {call.caller_name?.charAt(0)?.toUpperCase() || 
                 <PhoneIcon sx={{ fontSize: 24 }} />}
              </Avatar>
            </Badge>

            {/* Caller Info */}
            <Box>
              <Typography variant="h6" fontWeight="bold">
                {call.caller_name || 'Unknown Caller'}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {call.caller_number}
              </Typography>
            </Box>
          </Box>

          {/* Right Side - Duration & Actions */}
          <Box display="flex" alignItems="center" gap={2}>
            {/* Duration */}
            <Chip
              icon={<PhoneIcon />}
              label={formatDuration(duration)}
              color="primary"
              variant="outlined"
              sx={{ fontWeight: 'bold', fontFamily: 'monospace' }}
            />

            {/* Sentiment */}
            <SentimentGauge sentiment={call.sentiment} size="small" />

            {/* Expand Button */}
            <IconButton 
              onClick={handleExpandClick}
              size="small"
            >
              {expanded ? <CollapseIcon /> : <ExpandIcon />}
            </IconButton>
          </Box>
        </Box>

        {/* Agent Info Row */}
        <Box display="flex" alignItems="center" gap={1} mb={1}>
          <Chip
            icon={<AgentIcon />}
            label={call.agent_name || 'AI Agent'}
            size="small"
            variant="outlined"
          />
          {call.is_emergency && (
            <Chip
              icon={<EmergencyIcon />}
              label="EMERGENCY"
              color="error"
              size="small"
            />
          )}
        </Box>

        {/* Preview of latest transcript */}
        {call.transcript?.length > 0 && !expanded && (
          <Box 
            sx={{ 
              mt: 1, 
              p: 1, 
              bgcolor: 'grey.50', 
              borderRadius: 1,
              borderLeft: 3,
              borderColor: 'primary.main',
            }}
          >
            <Typography 
              variant="body2" 
              color="text.secondary"
              sx={{ 
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {call.transcript[call.transcript.length - 1]?.content}
            </Typography>
          </Box>
        )}

        {/* Expanded Transcript View */}
        <Collapse in={expanded}>
          <Box mt={2}>
            <Typography variant="subtitle2" gutterBottom>
              Live Transcript
            </Typography>
            <LiveTranscript 
              transcript={call.transcript || []} 
              isTyping={true}
              maxHeight={300}
            />
          </Box>
        </Collapse>
      </CardContent>

      {/* Activity Indicator */}
      <LinearProgress 
        variant="indeterminate" 
        sx={{ 
          height: 2,
          bgcolor: 'grey.200',
        }} 
      />
    </Card>
  );
};

export default LiveCallCard;

