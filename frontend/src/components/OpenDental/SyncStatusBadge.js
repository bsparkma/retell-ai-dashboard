/**
 * Sync Status Badge
 * 
 * Shows the Open Dental sync status for a call with appropriate icons and colors.
 */

import React from 'react';
import { Chip, Tooltip, Box } from '@mui/material';
import {
  CheckCircle as SyncedIcon,
  Sync as PendingIcon,
  LinkOff as UnlinkedIcon,
  Error as ErrorIcon,
  PersonSearch as MatchingIcon,
  CloudOff as NotSyncedIcon,
} from '@mui/icons-material';

const SyncStatusBadge = ({ status, compact = false, onClick }) => {
  const getStatusConfig = () => {
    switch (status) {
      case 'synced':
        return {
          label: 'Synced',
          color: 'success',
          icon: <SyncedIcon fontSize="small" />,
          tooltip: 'Synced to Open Dental CommLog'
        };
      case 'pending':
        return {
          label: 'Pending',
          color: 'warning',
          icon: <PendingIcon fontSize="small" />,
          tooltip: 'Waiting to sync'
        };
      case 'pending_match':
        return {
          label: 'Needs Link',
          color: 'info',
          icon: <MatchingIcon fontSize="small" />,
          tooltip: 'Needs manual patient linking'
        };
      case 'matched':
        return {
          label: 'Matched',
          color: 'primary',
          icon: <MatchingIcon fontSize="small" />,
          tooltip: 'Patient matched, ready to sync'
        };
      case 'error':
        return {
          label: 'Error',
          color: 'error',
          icon: <ErrorIcon fontSize="small" />,
          tooltip: 'Sync failed - click to retry'
        };
      case 'unlinked':
        return {
          label: 'Unlinked',
          color: 'default',
          icon: <UnlinkedIcon fontSize="small" />,
          tooltip: 'Patient link removed'
        };
      default:
        return {
          label: 'Not Synced',
          color: 'default',
          icon: <NotSyncedIcon fontSize="small" />,
          tooltip: 'Not yet synced to Open Dental'
        };
    }
  };

  const config = getStatusConfig();

  if (compact) {
    return (
      <Tooltip title={config.tooltip}>
        <Box 
          sx={{ 
            display: 'inline-flex',
            cursor: onClick ? 'pointer' : 'default'
          }}
          onClick={onClick}
        >
          {React.cloneElement(config.icon, { 
            color: config.color === 'default' ? 'disabled' : config.color 
          })}
        </Box>
      </Tooltip>
    );
  }

  return (
    <Tooltip title={config.tooltip}>
      <Chip
        size="small"
        label={config.label}
        color={config.color}
        icon={config.icon}
        variant="outlined"
        onClick={onClick}
        sx={{ cursor: onClick ? 'pointer' : 'default' }}
      />
    </Tooltip>
  );
};

export default SyncStatusBadge;

