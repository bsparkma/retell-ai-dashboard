/**
 * ChatBubbleTranscript Component
 * 
 * Displays call transcripts in an iMessage-style chat bubble format with:
 * - Distinct colors for agent vs caller
 * - Timestamps
 * - Click-to-seek (syncs with audio player)
 * - Auto-scroll to current position
 * - Search/highlight functionality
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Box,
  Typography,
  Paper,
  Avatar,
  TextField,
  InputAdornment,
  IconButton,
  Chip,
  useTheme,
} from '@mui/material';
import {
  Search as SearchIcon,
  SmartToy as AIIcon,
  Person as PersonIcon,
  Headset as StaffIcon,
  Close as CloseIcon,
} from '@mui/icons-material';

const formatTimestamp = (timestamp) => {
  if (!timestamp) return '';
  
  // Handle various timestamp formats
  if (typeof timestamp === 'number') {
    const mins = Math.floor(timestamp / 60);
    const secs = Math.floor(timestamp % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
  
  // Handle HH:MM:SS or MM:SS format
  if (typeof timestamp === 'string') {
    if (timestamp.includes(':')) {
      const parts = timestamp.split(':');
      if (parts.length === 3) {
        return `${parseInt(parts[0]) * 60 + parseInt(parts[1])}:${parts[2].padStart(2, '0')}`;
      }
      return timestamp;
    }
    return timestamp;
  }
  
  return '';
};

const parseTranscriptToMessages = (transcript, transcriptJson = null) => {
  // If we have structured transcript data, use it
  if (transcriptJson && Array.isArray(transcriptJson)) {
    // Deepgram-style "words" arrays: [{ word, start, end, speaker? }, ...]
    const looksLikeWords = transcriptJson.length > 0 && (
      Object.prototype.hasOwnProperty.call(transcriptJson[0], 'word') ||
      Object.prototype.hasOwnProperty.call(transcriptJson[0], 'start')
    );

    if (looksLikeWords) {
      const words = transcriptJson
        .filter(w => w && (w.word || w.punctuated_word))
        .map(w => ({
          word: w.punctuated_word || w.word,
          start: typeof w.start === 'number' ? w.start : (typeof w.start_time === 'number' ? w.start_time : null),
          speaker: w.speaker,
        }))
        .filter(w => w.word);

      if (words.length === 0) return [];

      // Group words into chunks to show as chat bubbles (best-effort)
      const messages = [];
      const chunkSeconds = 12;
      let current = { start: words[0].start ?? 0, speaker: words[0].speaker, text: [] };

      const flush = () => {
        const content = current.text.join(' ').trim();
        if (!content) return;
        messages.push({
          id: messages.length,
          role: current.speaker === 1 ? 'agent' : 'user', // heuristic: speaker 1 = agent, else user
          content,
          timestamp: typeof current.start === 'number' ? current.start : null,
        });
      };

      for (const w of words) {
        const start = typeof w.start === 'number' ? w.start : current.start;
        const speakerChanged = w.speaker !== undefined && current.speaker !== undefined && w.speaker !== current.speaker;
        const timeExceeded = typeof start === 'number' && typeof current.start === 'number' && (start - current.start) >= chunkSeconds;

        if (speakerChanged || timeExceeded) {
          flush();
          current = { start: start ?? 0, speaker: w.speaker, text: [w.word] };
          continue;
        }

        current.text.push(w.word);
      }

      flush();
      return messages;
    }

    return transcriptJson.map((item, index) => ({
      id: index,
      role: item.role?.toLowerCase() || 'unknown',
      content: item.content || item.text || '',
      timestamp: item.timestamp || item.start_time || null,
    }));
  }

  // Parse plain text transcript
  if (!transcript || typeof transcript !== 'string') {
    return [];
  }

  const messages = [];
  const lines = transcript.split(/(?=(?:Agent:|User:|Staff:|Caller:|AI:))/gi);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let role = 'unknown';
    let content = trimmed;

    // Detect role from prefix
    const roleMatch = trimmed.match(/^(Agent|User|Staff|Caller|AI):\s*/i);
    if (roleMatch) {
      const roleLabel = roleMatch[1].toLowerCase();
      role = ['agent', 'ai', 'staff'].includes(roleLabel) ? 'agent' : 'user';
      content = trimmed.substring(roleMatch[0].length).trim();
    }

    // Extract timestamp if present (e.g., "[0:30]" or "(00:30)")
    const timestampMatch = content.match(/^[\[\(]?(\d{1,2}:\d{2}(?::\d{2})?)[\]\)]?\s*/);
    let timestamp = null;
    if (timestampMatch) {
      timestamp = timestampMatch[1];
      content = content.substring(timestampMatch[0].length).trim();
    }

    if (content) {
      messages.push({
        id: index,
        role,
        content,
        timestamp,
      });
    }
  });

  return messages;
};

const ChatBubbleTranscript = ({
  transcript,
  transcriptJson = null,
  currentTime = 0, // Current audio playback time in seconds
  onSeek, // Callback when user clicks a message to seek
  handlerType = 'ai', // 'ai' or 'staff' - affects agent bubble styling
  callerName = 'Caller',
  agentName = 'Agent',
  maxHeight = 400,
  showSearch = true,
}) => {
  const theme = useTheme();
  const containerRef = useRef(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMessageId, setActiveMessageId] = useState(null);

  const messages = parseTranscriptToMessages(transcript, transcriptJson);

  // Auto-scroll to active message based on currentTime
  useEffect(() => {
    if (currentTime === 0 || !messages.length) return;

    // Find the message closest to current time
    const activeMsg = messages.reduce((closest, msg) => {
      if (!msg.timestamp) return closest;
      
      // Parse timestamp to seconds
      const msgTime = parseTimestampToSeconds(msg.timestamp);
      if (msgTime <= currentTime && (!closest || msgTime > parseTimestampToSeconds(closest.timestamp))) {
        return msg;
      }
      return closest;
    }, null);

    if (activeMsg && activeMsg.id !== activeMessageId) {
      setActiveMessageId(activeMsg.id);
      
      // Scroll to active message
      const element = document.getElementById(`transcript-msg-${activeMsg.id}`);
      if (element && containerRef.current) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [currentTime, messages, activeMessageId]);

  const parseTimestampToSeconds = (timestamp) => {
    if (typeof timestamp === 'number') return timestamp;
    if (!timestamp || typeof timestamp !== 'string') return 0;
    
    const parts = timestamp.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return 0;
  };

  const handleMessageClick = (message) => {
    if (message.timestamp && onSeek) {
      const seconds = parseTimestampToSeconds(message.timestamp);
      onSeek(seconds);
    }
  };

  const highlightSearchTerm = (text) => {
    if (!searchQuery) return text;
    
    const parts = text.split(new RegExp(`(${searchQuery})`, 'gi'));
    return parts.map((part, index) => 
      part.toLowerCase() === searchQuery.toLowerCase() ? (
        <Box 
          component="span" 
          key={index}
          sx={{ 
            bgcolor: 'warning.light', 
            color: 'warning.contrastText',
            borderRadius: 0.5,
            px: 0.5,
          }}
        >
          {part}
        </Box>
      ) : part
    );
  };

  const filteredMessages = searchQuery
    ? messages.filter(msg => 
        msg.content.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : messages;

  const getAgentIcon = () => {
    return handlerType === 'staff' ? <StaffIcon /> : <AIIcon />;
  };

  const getAgentColor = () => {
    return handlerType === 'staff' ? 'secondary.main' : 'primary.main';
  };

  if (!messages.length) {
    return (
      <Paper 
        sx={{ 
          p: 3, 
          textAlign: 'center', 
          bgcolor: theme.palette.mode === 'dark' ? 'grey.900' : 'grey.50',
        }}
      >
        <Typography color="textSecondary">
          No transcript available for this call.
        </Typography>
      </Paper>
    );
  }

  return (
    <Box>
      {/* Search bar */}
      {showSearch && (
        <TextField
          fullWidth
          size="small"
          placeholder="Search transcript..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          sx={{ mb: 2 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
            endAdornment: searchQuery && (
              <InputAdornment position="end">
                <IconButton size="small" onClick={() => setSearchQuery('')}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ),
          }}
        />
      )}

      {/* Search results count */}
      {searchQuery && (
        <Typography variant="caption" color="textSecondary" sx={{ mb: 1, display: 'block' }}>
          {filteredMessages.length} {filteredMessages.length === 1 ? 'result' : 'results'} found
        </Typography>
      )}

      {/* Chat bubbles container */}
      <Box
        ref={containerRef}
        sx={{
          maxHeight,
          overflowY: 'auto',
          p: 2,
          bgcolor: theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100',
          borderRadius: 2,
          '&::-webkit-scrollbar': {
            width: 8,
          },
          '&::-webkit-scrollbar-thumb': {
            bgcolor: 'action.disabled',
            borderRadius: 4,
          },
        }}
      >
        {filteredMessages.map((message) => {
          const isAgent = message.role === 'agent';
          const isActive = message.id === activeMessageId;

          return (
            <Box
              key={message.id}
              id={`transcript-msg-${message.id}`}
              sx={{
                display: 'flex',
                flexDirection: isAgent ? 'row' : 'row-reverse',
                mb: 2,
                alignItems: 'flex-end',
              }}
            >
              {/* Avatar */}
              <Avatar
                sx={{
                  width: 32,
                  height: 32,
                  bgcolor: isAgent ? getAgentColor() : 'grey.500',
                  mx: 1,
                }}
              >
                {isAgent ? getAgentIcon() : <PersonIcon />}
              </Avatar>

              {/* Message bubble */}
              <Box
                onClick={() => handleMessageClick(message)}
                sx={{
                  maxWidth: '70%',
                  cursor: message.timestamp ? 'pointer' : 'default',
                  '&:hover': message.timestamp ? {
                    filter: 'brightness(0.95)',
                  } : {},
                }}
              >
                {/* Speaker label and timestamp */}
                <Box
                  display="flex"
                  alignItems="center"
                  gap={1}
                  mb={0.5}
                  sx={{ 
                    flexDirection: isAgent ? 'row' : 'row-reverse',
                  }}
                >
                  <Typography variant="caption" color="textSecondary">
                    {isAgent ? agentName : callerName}
                  </Typography>
                  {message.timestamp && (
                    <Chip
                      label={formatTimestamp(message.timestamp)}
                      size="small"
                      sx={{
                        height: 18,
                        fontSize: '0.65rem',
                        bgcolor: isActive ? 'primary.light' : 'transparent',
                        color: isActive ? 'primary.contrastText' : 'text.secondary',
                      }}
                    />
                  )}
                </Box>

                {/* Message content */}
                <Paper
                  elevation={0}
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    borderTopLeftRadius: isAgent ? 0.5 : 2,
                    borderTopRightRadius: isAgent ? 2 : 0.5,
                    bgcolor: isAgent
                      ? (handlerType === 'staff' 
                          ? (theme.palette.mode === 'dark' ? 'secondary.dark' : 'secondary.light')
                          : (theme.palette.mode === 'dark' ? 'primary.dark' : 'primary.light'))
                      : (theme.palette.mode === 'dark' ? 'grey.800' : 'white'),
                    color: isAgent
                      ? (theme.palette.mode === 'dark' ? 'white' : 'primary.contrastText')
                      : 'text.primary',
                    boxShadow: isActive ? `0 0 0 2px ${theme.palette.primary.main}` : 1,
                    transition: 'box-shadow 0.2s ease',
                  }}
                >
                  <Typography variant="body2">
                    {highlightSearchTerm(message.content)}
                  </Typography>
                </Paper>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Scroll hint */}
      {messages.length > 5 && (
        <Typography 
          variant="caption" 
          color="textSecondary" 
          sx={{ mt: 1, display: 'block', textAlign: 'center', opacity: 0.6 }}
        >
          {messages.length} messages • Click timestamps to seek audio
        </Typography>
      )}
    </Box>
  );
};

export default ChatBubbleTranscript;
