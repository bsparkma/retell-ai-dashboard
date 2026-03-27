/**
 * Sentiment Gauge Component
 * 
 * Visual indicator for real-time call sentiment.
 */

import React from 'react';
import { Box, Typography, Chip } from '@mui/material';
import {
  SentimentSatisfiedAlt as PositiveIcon,
  SentimentNeutral as NeutralIcon,
  SentimentDissatisfied as NegativeIcon,
} from '@mui/icons-material';

const SentimentGauge = ({ sentiment, size = 'medium', showLabel = true }) => {
  const getSentimentConfig = () => {
    switch (sentiment?.toLowerCase()) {
      case 'positive':
        return {
          icon: <PositiveIcon />,
          color: 'success',
          bgColor: 'success.light',
          label: 'Positive',
          value: 75,
        };
      case 'negative':
        return {
          icon: <NegativeIcon />,
          color: 'error',
          bgColor: 'error.light',
          label: 'Negative',
          value: 25,
        };
      case 'neutral':
      default:
        return {
          icon: <NeutralIcon />,
          color: 'warning',
          bgColor: 'warning.light',
          label: 'Neutral',
          value: 50,
        };
    }
  };

  const config = getSentimentConfig();

  if (size === 'small') {
    return (
      <Chip
        icon={config.icon}
        label={config.label}
        color={config.color}
        size="small"
        sx={{ fontWeight: 'medium' }}
      />
    );
  }

  return (
    <Box display="flex" alignItems="center" gap={1}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size === 'large' ? 48 : 36,
          height: size === 'large' ? 48 : 36,
          borderRadius: '50%',
          bgcolor: config.bgColor,
          color: `${config.color}.main`,
        }}
      >
        {React.cloneElement(config.icon, { 
          sx: { fontSize: size === 'large' ? 28 : 20 } 
        })}
      </Box>
      {showLabel && (
        <Typography
          variant={size === 'large' ? 'body1' : 'body2'}
          fontWeight="medium"
          color={`${config.color}.main`}
        >
          {config.label}
        </Typography>
      )}
    </Box>
  );
};

export default SentimentGauge;

