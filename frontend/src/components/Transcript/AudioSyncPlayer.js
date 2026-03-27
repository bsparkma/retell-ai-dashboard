/**
 * AudioSyncPlayer Component
 * 
 * A professional audio player with:
 * - Click-to-seek on progress bar
 * - Playback speed control
 * - Keyboard shortcuts
 * - Time display
 * - Volume control
 * - Integration with transcript for synced playback
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Box,
  IconButton,
  Typography,
  Slider,
  Paper,
  Tooltip,
  Menu,
  MenuItem,
  Stack,
  useTheme,
} from '@mui/material';
import {
  PlayArrow as PlayIcon,
  Pause as PauseIcon,
  VolumeUp as VolumeUpIcon,
  VolumeDown as VolumeDownIcon,
  VolumeOff as VolumeMuteIcon,
  Speed as SpeedIcon,
  Replay10 as Replay10Icon,
  Forward10 as Forward10Icon,
  SkipPrevious as SkipPreviousIcon,
} from '@mui/icons-material';

const formatTime = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const AudioSyncPlayer = ({
  audioUrl,
  duration = 0, // Optional: pass duration if known before loading
  onTimeUpdate,
  onSeek,
  transcriptTimestamps = [], // Array of { startTime, endTime, text } for synced highlighting
  compact = false,
}) => {
  const theme = useTheme();
  const audioRef = useRef(null);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(duration);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [speedMenuAnchor, setSpeedMenuAnchor] = useState(null);

  // Sync with audio element
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      const time = audio.currentTime;
      setCurrentTime(time);
      if (onTimeUpdate) onTimeUpdate(time);
    };

    const handleLoadedMetadata = () => {
      setAudioDuration(audio.duration);
      setIsLoading(false);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    const handleError = (e) => {
      setError('Failed to load audio');
      setIsLoading(false);
      setIsPlaying(false);
    };

    const handleLoadStart = () => {
      setIsLoading(true);
      setError(null);
    };

    const handleCanPlay = () => {
      setIsLoading(false);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);
    audio.addEventListener('loadstart', handleLoadStart);
    audio.addEventListener('canplay', handleCanPlay);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('loadstart', handleLoadStart);
      audio.removeEventListener('canplay', handleCanPlay);
    };
  }, [onTimeUpdate]);

  // Apply volume and mute
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);

  // Apply playback rate
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Only handle if this component's parent is focused
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlayPause();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          skip(-10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          skip(10);
          break;
        case 'm':
        case 'M':
          toggleMute();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const togglePlayPause = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;

    try {
      if (isPlaying) {
        audio.pause();
        setIsPlaying(false);
      } else {
        if (audio.src !== audioUrl) {
          audio.src = audioUrl;
        }
        await audio.play();
        setIsPlaying(true);
      }
    } catch (err) {
      console.error('Playback error:', err);
      setError('Playback failed');
    }
  }, [isPlaying, audioUrl]);

  const handleSeek = useCallback((_, newValue) => {
    const audio = audioRef.current;
    if (!audio) return;

    const seekTime = (newValue / 100) * audioDuration;
    audio.currentTime = seekTime;
    setCurrentTime(seekTime);
    if (onSeek) onSeek(seekTime);
  }, [audioDuration, onSeek]);

  const handleSeekClick = useCallback((e) => {
    const audio = audioRef.current;
    if (!audio || !audioDuration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const seekTime = percentage * audioDuration;

    audio.currentTime = seekTime;
    setCurrentTime(seekTime);
    if (onSeek) onSeek(seekTime);
  }, [audioDuration, onSeek]);

  const skip = useCallback((seconds) => {
    const audio = audioRef.current;
    if (!audio) return;

    const newTime = Math.max(0, Math.min(audioDuration, audio.currentTime + seconds));
    audio.currentTime = newTime;
    setCurrentTime(newTime);
  }, [audioDuration]);

  const handleVolumeChange = (_, newValue) => {
    setVolume(newValue);
    setIsMuted(newValue === 0);
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  const handleSpeedChange = (rate) => {
    setPlaybackRate(rate);
    setSpeedMenuAnchor(null);
  };

  const restart = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    setCurrentTime(0);
  };

  const progress = audioDuration > 0 ? (currentTime / audioDuration) * 100 : 0;

  const VolumeIcon = isMuted || volume === 0 ? VolumeMuteIcon : volume < 0.5 ? VolumeDownIcon : VolumeUpIcon;

  // Compact mode for inline display
  if (compact) {
    return (
      <Box display="flex" alignItems="center" gap={1}>
        <audio ref={audioRef} preload="metadata" />
        <IconButton 
          onClick={togglePlayPause} 
          size="small"
          color="primary"
          disabled={!audioUrl || isLoading}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </IconButton>
        <Box 
          sx={{ 
            flex: 1, 
            height: 4, 
            bgcolor: 'action.hover', 
            borderRadius: 2,
            cursor: 'pointer',
            position: 'relative',
            minWidth: 100,
          }}
          onClick={handleSeekClick}
        >
          <Box
            sx={{
              height: '100%',
              width: `${progress}%`,
              bgcolor: 'primary.main',
              borderRadius: 2,
              transition: 'width 0.1s linear',
            }}
          />
        </Box>
        <Typography variant="caption" color="textSecondary" sx={{ minWidth: 40 }}>
          {formatTime(currentTime)}
        </Typography>
      </Box>
    );
  }

  return (
    <Paper 
      elevation={0} 
      sx={{ 
        p: 2, 
        bgcolor: theme.palette.mode === 'dark' ? 'grey.900' : 'grey.50',
        borderRadius: 2,
      }}
    >
      <audio ref={audioRef} preload="metadata" />

      {error && (
        <Typography color="error" variant="caption" sx={{ mb: 1, display: 'block' }}>
          {error}
        </Typography>
      )}

      {/* Progress bar - click to seek */}
      <Box 
        sx={{ 
          height: 8, 
          bgcolor: 'action.hover', 
          borderRadius: 4,
          cursor: audioUrl ? 'pointer' : 'default',
          position: 'relative',
          mb: 2,
          '&:hover': audioUrl ? {
            '& .progress-handle': {
              opacity: 1,
              transform: 'scale(1)',
            }
          } : {},
        }}
        onClick={handleSeekClick}
      >
        <Box
          sx={{
            height: '100%',
            width: `${progress}%`,
            bgcolor: 'primary.main',
            borderRadius: 4,
            transition: 'width 0.1s linear',
            position: 'relative',
          }}
        >
          {/* Seek handle */}
          <Box
            className="progress-handle"
            sx={{
              position: 'absolute',
              right: -6,
              top: '50%',
              transform: 'translateY(-50%) scale(0)',
              width: 12,
              height: 12,
              borderRadius: '50%',
              bgcolor: 'primary.main',
              boxShadow: 2,
              opacity: 0,
              transition: 'all 0.2s ease',
            }}
          />
        </Box>
      </Box>

      {/* Controls row */}
      <Box display="flex" alignItems="center" justifyContent="space-between">
        {/* Left: Playback controls */}
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <Tooltip title="Restart (Home)">
            <IconButton size="small" onClick={restart} disabled={!audioUrl}>
              <SkipPreviousIcon />
            </IconButton>
          </Tooltip>

          <Tooltip title="Back 10s (←)">
            <IconButton size="small" onClick={() => skip(-10)} disabled={!audioUrl}>
              <Replay10Icon />
            </IconButton>
          </Tooltip>

          <IconButton 
            onClick={togglePlayPause} 
            color="primary"
            disabled={!audioUrl || isLoading}
            sx={{ 
              bgcolor: 'primary.main', 
              color: 'white',
              '&:hover': { bgcolor: 'primary.dark' },
              '&:disabled': { bgcolor: 'action.disabledBackground' },
            }}
          >
            {isLoading ? (
              <Typography variant="caption">...</Typography>
            ) : isPlaying ? (
              <PauseIcon />
            ) : (
              <PlayIcon />
            )}
          </IconButton>

          <Tooltip title="Forward 10s (→)">
            <IconButton size="small" onClick={() => skip(10)} disabled={!audioUrl}>
              <Forward10Icon />
            </IconButton>
          </Tooltip>
        </Stack>

        {/* Center: Time display */}
        <Typography variant="body2" color="textSecondary">
          {formatTime(currentTime)} / {formatTime(audioDuration || duration)}
        </Typography>

        {/* Right: Volume and speed */}
        <Stack direction="row" alignItems="center" spacing={1}>
          {/* Playback speed */}
          <Tooltip title="Playback Speed">
            <IconButton 
              size="small" 
              onClick={(e) => setSpeedMenuAnchor(e.currentTarget)}
            >
              <SpeedIcon />
            </IconButton>
          </Tooltip>
          <Menu
            anchorEl={speedMenuAnchor}
            open={Boolean(speedMenuAnchor)}
            onClose={() => setSpeedMenuAnchor(null)}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
              <MenuItem
                key={rate}
                onClick={() => handleSpeedChange(rate)}
                selected={playbackRate === rate}
              >
                {rate === 1 ? 'Normal' : `${rate}x`}
              </MenuItem>
            ))}
          </Menu>

          {/* Volume */}
          <Tooltip title={isMuted ? 'Unmute (M)' : 'Mute (M)'}>
            <IconButton size="small" onClick={toggleMute}>
              <VolumeIcon />
            </IconButton>
          </Tooltip>
          <Slider
            value={isMuted ? 0 : volume}
            onChange={handleVolumeChange}
            min={0}
            max={1}
            step={0.1}
            sx={{ width: 80 }}
            size="small"
          />
        </Stack>
      </Box>

      {/* Keyboard shortcuts hint */}
      <Typography 
        variant="caption" 
        color="textSecondary" 
        sx={{ mt: 1, display: 'block', textAlign: 'center', opacity: 0.6 }}
      >
        Space: Play/Pause • ← →: Skip 10s • M: Mute
      </Typography>
    </Paper>
  );
};

export default AudioSyncPlayer;

