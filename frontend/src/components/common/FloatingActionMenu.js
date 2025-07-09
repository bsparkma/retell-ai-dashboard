import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  SpeedDial,
  SpeedDialAction,
  SpeedDialIcon,
  Backdrop,
  useTheme,
  useMediaQuery,
  Tooltip,
} from '@mui/material';
import {
  Add as AddIcon,
  Close as CloseIcon,
  PersonAdd as PersonAddIcon,
  Analytics as AnalyticsIcon,
  Warning as WarningIcon,
} from '@mui/icons-material';

const FloatingActionMenu = () => {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const handleOpen = () => setOpen(true);
  const handleClose = () => setOpen(false);

  const actions = [
    {
      icon: <PersonAddIcon />,
      name: 'Add New Agent',
      tooltip: 'Create a new AI agent',
      action: () => {
        navigate('/agents');
        // In a real app, this might open a creation modal
        handleClose();
      },
      color: 'primary',
    },
    {
      icon: <AnalyticsIcon />,
      name: 'Download Analytics',
      tooltip: 'Export analytics data',
      action: () => {
        // Simulate analytics download
        const csvContent = "data:text/csv;charset=utf-8,Date,Calls,Sentiment\n" +
          "2024-01-15,24,Positive\n" +
          "2024-01-16,31,Neutral\n" +
          "2024-01-17,18,Positive";
        
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `analytics-${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        handleClose();
      },
      color: 'secondary',
    },
    {
      icon: <WarningIcon />,
      name: 'Review Unresolved',
      tooltip: 'View unresolved calls that need attention',
      action: () => {
        navigate('/?filter=unresolved');
        handleClose();
      },
      color: 'error',
    },
  ];

  // Don't show on certain pages or if mobile and keyboard is open
  const shouldHide = location.pathname.includes('/calls/') || 
                   (isMobile && window.innerHeight < 500);

  if (shouldHide) {
    return null;
  }

  return (
    <>
      <Backdrop 
        open={open} 
        sx={{ 
          zIndex: theme.zIndex.speedDial - 1,
          backgroundColor: 'rgba(0, 0, 0, 0.1)',
        }} 
      />
      <SpeedDial
        ariaLabel="Quick Actions"
        sx={{
          position: 'fixed',
          bottom: isMobile ? 16 : 24,
          right: isMobile ? 16 : 24,
          zIndex: theme.zIndex.speedDial,
          '& .MuiSpeedDial-fab': {
            backgroundColor: theme.palette.primary.main,
            color: 'white',
            '&:hover': {
              backgroundColor: theme.palette.primary.dark,
              transform: 'scale(1.1)',
            },
            transition: 'all 0.2s ease-in-out',
          },
        }}
        icon={<SpeedDialIcon icon={<AddIcon />} openIcon={<CloseIcon />} />}
        onClose={handleClose}
        onOpen={handleOpen}
        open={open}
        direction="up"
      >
        {actions.map((action) => (
          <SpeedDialAction
            key={action.name}
            icon={action.icon}
            tooltipTitle={
              <Tooltip title={action.tooltip} placement="left">
                <span>{action.name}</span>
              </Tooltip>
            }
            tooltipOpen={!isMobile}
            onClick={action.action}
            sx={{
              '& .MuiSpeedDialAction-fab': {
                backgroundColor: theme.palette[action.color]?.main || theme.palette.grey[600],
                color: 'white',
                '&:hover': {
                  backgroundColor: theme.palette[action.color]?.dark || theme.palette.grey[700],
                  transform: 'scale(1.05)',
                },
                transition: 'all 0.2s ease-in-out',
                boxShadow: theme.shadows[6],
              },
            }}
          />
        ))}
      </SpeedDial>
    </>
  );
};

export default FloatingActionMenu; 