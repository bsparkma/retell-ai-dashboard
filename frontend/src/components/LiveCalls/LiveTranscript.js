/**
 * Live Transcript Component
 * 
 * Displays real-time transcript with chat-bubble style.
 */

import React, { useEffect, useRef } from 'react';
import {
  Box,
  Typography,
  Paper,
  Avatar,
  Chip,
  keyframes,
} from '@mui/material';
import {
  SmartToy as AgentIcon,
  Person as CallerIcon,
} from '@mui/icons-material';

// Typing animation
const pulse = keyframes`
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
`;

const TypingIndicator = () => (
  <Box display="flex" gap={0.5} alignItems="center" px={1}>
    {[0, 1, 2].map((i) => (
      <Box
        key={i}
        sx={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          bgcolor: 'primary.main',
          animation: `${pulse} 1.4s ease-in-out infinite`,
          animationDelay: `${i * 0.2}s`,
        }}
      />
    ))}
  </Box>
);

const TranscriptBubble = ({ utterance, isAgent }) => {
  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      second: '2-digit'
    });
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: isAgent ? 'row' : 'row-reverse',
        gap: 1,
        mb: 2,
        maxWidth: '85%',
        alignSelf: isAgent ? 'flex-start' : 'flex-end',
      }}
    >
      <Avatar
        sx={{
          width: 32,
          height: 32,
          bgcolor: isAgent ? 'primary.main' : 'secondary.main',
        }}
      >
        {isAgent ? <AgentIcon sx={{ fontSize: 18 }} /> : <CallerIcon sx={{ fontSize: 18 }} />}
      </Avatar>
      <Box>
        <Paper
          elevation={0}
          sx={{
            p: 1.5,
            bgcolor: isAgent ? 'primary.light' : 'grey.100',
            borderRadius: 2,
            borderTopLeftRadius: isAgent ? 0 : 2,
            borderTopRightRadius: isAgent ? 2 : 0,
          }}
        >
          <Typography 
            variant="body2" 
            sx={{ 
              color: isAgent ? 'primary.contrastText' : 'text.primary',
              whiteSpace: 'pre-wrap',
            }}
          >
            {utterance.content}
          </Typography>
        </Paper>
        <Typography 
          variant="caption" 
          color="text.secondary"
          sx={{ ml: 1, display: 'block', mt: 0.5 }}
        >
          {formatTime(utterance.timestamp)}
        </Typography>
      </Box>
    </Box>
  );
};

const LiveTranscript = ({ transcript = [], isTyping = false, maxHeight = 400 }) => {
  const scrollRef = useRef(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript]);

  if (transcript.length === 0 && !isTyping) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: 200,
          color: 'text.secondary',
        }}
      >
        <Typography variant="body2">
          Waiting for conversation to begin...
        </Typography>
        <TypingIndicator />
      </Box>
    );
  }

  return (
    <Box
      ref={scrollRef}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        maxHeight,
        overflowY: 'auto',
        p: 2,
        bgcolor: 'background.paper',
        borderRadius: 2,
        border: 1,
        borderColor: 'divider',
      }}
    >
      {transcript.map((utterance, index) => (
        <TranscriptBubble
          key={index}
          utterance={utterance}
          isAgent={utterance.role === 'agent'}
        />
      ))}
      
      {isTyping && (
        <Box
          sx={{
            display: 'flex',
            gap: 1,
            alignItems: 'center',
            mb: 2,
          }}
        >
          <Avatar
            sx={{
              width: 32,
              height: 32,
              bgcolor: 'grey.400',
            }}
          >
            <CallerIcon sx={{ fontSize: 18 }} />
          </Avatar>
          <Paper
            elevation={0}
            sx={{
              p: 1.5,
              bgcolor: 'grey.100',
              borderRadius: 2,
            }}
          >
            <TypingIndicator />
          </Paper>
        </Box>
      )}
    </Box>
  );
};

export default LiveTranscript;

