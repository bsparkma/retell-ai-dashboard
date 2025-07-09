import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IconButton,
  Badge,
  Popover,
  Box,
  Typography,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  ListItemButton,
  Divider,
  Button,
  Chip,
  Tooltip,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import {
  Notifications as NotificationsIcon,
  Error as ErrorIcon,
  Warning as WarningIcon,
  Info as InfoIcon,
  MarkEmailRead as MarkReadIcon,
  Clear as ClearIcon,
  Delete as DeleteIcon,
  Circle as UnreadIcon,
} from '@mui/icons-material';
import { useNotifications } from '../../contexts/NotificationContext';

const NotificationCenter = () => {
  const [anchorEl, setAnchorEl] = useState(null);
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    removeNotification,
    clearAllNotifications,
  } = useNotifications();

  const open = Boolean(anchorEl);

  const handleClick = (event) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const getNotificationIcon = (type, severity) => {
    const iconProps = {
      fontSize: 'small',
      sx: { 
        color: getNotificationColor(type, severity),
      },
    };

    switch (type) {
      case 'error':
        return <ErrorIcon {...iconProps} />;
      case 'warning':
        return <WarningIcon {...iconProps} />;
      case 'info':
        return <InfoIcon {...iconProps} />;
      default:
        return <InfoIcon {...iconProps} />;
    }
  };

  const getNotificationColor = (type, severity) => {
    switch (type) {
      case 'error':
        return theme.palette.error.main;
      case 'warning':
        return theme.palette.warning.main;
      case 'info':
        return theme.palette.info.main;
      default:
        return theme.palette.grey[500];
    }
  };

  const formatTimeAgo = (timestamp) => {
    const now = new Date();
    const diff = now - new Date(timestamp);
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  const handleNotificationClick = (notification) => {
    markAsRead(notification.id);
    if (notification.action) {
      navigate(notification.action);
      handleClose();
    }
  };

  const handleMarkAllRead = () => {
    markAllAsRead();
  };

  const handleClearAll = () => {
    clearAllNotifications();
  };

  const recentNotifications = notifications.slice(0, 10); // Show last 10 notifications

  return (
    <>
      <Tooltip title="Notifications">
        <IconButton 
          color="inherit" 
          onClick={handleClick}
          sx={{
            position: 'relative',
            '&:hover': {
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
            },
          }}
        >
          <Badge 
            badgeContent={unreadCount} 
            color="error"
            max={99}
            sx={{
              '& .MuiBadge-badge': {
                animation: unreadCount > 0 ? 'pulse 2s infinite' : 'none',
                '@keyframes pulse': {
                  '0%': {
                    transform: 'scale(1)',
                  },
                  '50%': {
                    transform: 'scale(1.1)',
                  },
                  '100%': {
                    transform: 'scale(1)',
                  },
                },
              },
            }}
          >
            <NotificationsIcon />
          </Badge>
        </IconButton>
      </Tooltip>

      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
        sx={{
          mt: 1,
          '& .MuiPopover-paper': {
            width: isMobile ? '100vw' : 400,
            maxWidth: isMobile ? '100vw' : 400,
            maxHeight: 600,
            backgroundColor: theme.palette.background.paper,
            border: theme.palette.mode === 'dark' ? '1px solid rgba(255,255,255,0.12)' : 'none',
          },
        }}
      >
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="h6" component="h2">
              Notifications
            </Typography>
            <Chip 
              label={`${unreadCount} unread`} 
              size="small" 
              color={unreadCount > 0 ? 'error' : 'default'}
              variant={unreadCount > 0 ? 'filled' : 'outlined'}
            />
          </Box>
          
          {notifications.length > 0 && (
            <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
              <Button
                size="small"
                startIcon={<MarkReadIcon />}
                onClick={handleMarkAllRead}
                disabled={unreadCount === 0}
              >
                Mark all read
              </Button>
              <Button
                size="small"
                startIcon={<ClearIcon />}
                onClick={handleClearAll}
                color="secondary"
              >
                Clear all
              </Button>
            </Box>
          )}
        </Box>

        <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
          {recentNotifications.length === 0 ? (
            <Box sx={{ p: 3, textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                No notifications
              </Typography>
            </Box>
          ) : (
            <List disablePadding>
              {recentNotifications.map((notification, index) => (
                <React.Fragment key={notification.id}>
                  <ListItem disablePadding>
                    <ListItemButton
                      onClick={() => handleNotificationClick(notification)}
                      sx={{
                        py: 1.5,
                        backgroundColor: !notification.read 
                          ? theme.palette.action.hover 
                          : 'transparent',
                        '&:hover': {
                          backgroundColor: theme.palette.action.selected,
                        },
                      }}
                    >
                      <ListItemIcon sx={{ minWidth: 40 }}>
                        {getNotificationIcon(notification.type, notification.severity)}
                      </ListItemIcon>
                      
                      <ListItemText
                        primary={
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Typography variant="body2" fontWeight={!notification.read ? 600 : 400}>
                              {notification.title}
                            </Typography>
                            {!notification.read && (
                              <UnreadIcon sx={{ fontSize: 8, color: 'primary.main' }} />
                            )}
                          </Box>
                        }
                        secondary={
                          <Box>
                            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                              {notification.message}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {formatTimeAgo(notification.timestamp)}
                            </Typography>
                          </Box>
                        }
                        sx={{ pr: 1 }}
                      />
                      
                      <Tooltip title="Remove">
                        <IconButton
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeNotification(notification.id);
                          }}
                          sx={{ opacity: 0.7, '&:hover': { opacity: 1 } }}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </ListItemButton>
                  </ListItem>
                  {index < recentNotifications.length - 1 && <Divider />}
                </React.Fragment>
              ))}
            </List>
          )}
        </Box>

        {notifications.length > 10 && (
          <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider', textAlign: 'center' }}>
            <Button size="small" onClick={handleClose}>
              View all notifications
            </Button>
          </Box>
        )}
      </Popover>
    </>
  );
};

export default NotificationCenter; 