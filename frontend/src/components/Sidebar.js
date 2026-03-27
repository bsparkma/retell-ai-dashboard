import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Divider,
  Box,
  Toolbar,
  Typography,
  Badge,
  useTheme,
  useMediaQuery,
  keyframes,
} from '@mui/material';
import {
  Dashboard as DashboardIcon,
  Phone as PhoneIcon,
  Person as PersonIcon,
  Analytics as AnalyticsIcon,
  Settings as SettingsIcon,
  CalendarToday as CalendarIcon,
  FiberManualRecord as LiveIcon,
  Build as AdminIcon,
  PhoneCallback as CallbackIcon,
} from '@mui/icons-material';
import config from '../config/env';
import { useLiveCalls } from '../hooks/useLiveCalls';

const drawerWidth = 240;

// Pulsing animation for live indicator
const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
`;

const menuItems = [
  { text: 'Dashboard', icon: <DashboardIcon />, path: '/' },
  { text: 'Live Monitor', icon: <LiveIcon />, path: '/live', isLive: true },
  { text: 'Callbacks', icon: <CallbackIcon />, path: '/callbacks' },
  { text: 'Calendar', icon: <CalendarIcon />, path: '/calendar' },
  { text: 'Agents', icon: <PersonIcon />, path: '/agents' },
  { text: 'Analytics', icon: <AnalyticsIcon />, path: '/analytics' },
  { text: 'Admin', icon: <AdminIcon />, path: '/admin' },
];

const Sidebar = ({ open, onToggle }) => {
  const navigate = useNavigate();
  const location = useLocation();
  
  // Get live call count for badge
  let activeCount = 0;
  let emergencyCount = 0;
  try {
    const liveCallsHook = useLiveCalls();
    activeCount = liveCallsHook.activeCount || 0;
    emergencyCount = liveCallsHook.emergencyCount || 0;
  } catch (e) {
    // Socket not connected yet, ignore
  }

  const handleNavigation = (path) => {
    navigate(path);
  };

  return (
    <Drawer
      variant="persistent"
      anchor="left"
      open={open}
      sx={{
        width: open ? drawerWidth : 56,
        flexShrink: 0,
        transition: 'width 0.3s ease',
        '& .MuiDrawer-paper': {
          width: open ? drawerWidth : 56,
          boxSizing: 'border-box',
          transition: 'width 0.3s ease',
          overflowX: 'hidden',
        },
      }}
    >
      <Toolbar />
      <Box sx={{ overflow: 'auto' }}>
        <List>
          {menuItems.map((item) => (
            <ListItem key={item.text} disablePadding>
              <ListItemButton
                onClick={() => handleNavigation(item.path)}
                selected={location.pathname === item.path}
                sx={{
                  minHeight: 48,
                  justifyContent: open ? 'initial' : 'center',
                  px: 2.5,
                  ...(item.isLive && activeCount > 0 && {
                    bgcolor: emergencyCount > 0 ? 'error.light' : 'primary.light',
                    '&:hover': {
                      bgcolor: emergencyCount > 0 ? 'error.main' : 'primary.main',
                    },
                  }),
                }}
              >
                <ListItemIcon
                  sx={{
                    minWidth: 0,
                    mr: open ? 3 : 'auto',
                    justifyContent: 'center',
                    ...(item.isLive && activeCount > 0 && {
                      color: emergencyCount > 0 ? 'error.main' : 'primary.main',
                      animation: `${pulse} 1.5s ease-in-out infinite`,
                    }),
                  }}
                >
                  {item.isLive && activeCount > 0 ? (
                    <Badge 
                      badgeContent={activeCount} 
                      color={emergencyCount > 0 ? 'error' : 'primary'}
                      max={99}
                    >
                      {item.icon}
                    </Badge>
                  ) : (
                    item.icon
                  )}
                </ListItemIcon>
                <ListItemText 
                  primary={item.isLive && activeCount > 0 
                    ? `${item.text} (${activeCount})`
                    : item.text
                  } 
                  sx={{ 
                    opacity: open ? 1 : 0,
                    '& .MuiListItemText-primary': {
                      fontWeight: item.isLive && activeCount > 0 ? 'bold' : 'normal',
                    },
                  }} 
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
        
        <Divider />
        
        <List>
          <ListItem disablePadding>
            <ListItemButton
              sx={{
                minHeight: 48,
                justifyContent: open ? 'initial' : 'center',
                px: 2.5,
              }}
            >
              <ListItemIcon
                sx={{
                  minWidth: 0,
                  mr: open ? 3 : 'auto',
                  justifyContent: 'center',
                }}
              >
                <SettingsIcon />
              </ListItemIcon>
              <ListItemText 
                primary="Settings" 
                sx={{ opacity: open ? 1 : 0 }} 
              />
            </ListItemButton>
          </ListItem>
        </List>
      </Box>
    </Drawer>
  );
};

export default Sidebar; 