import React from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Breadcrumbs as MuiBreadcrumbs,
  Link,
  Typography,
  Box,
  Chip,
} from '@mui/material';
import {
  Home as HomeIcon,
  Dashboard as DashboardIcon,
  Person as PersonIcon,
  Analytics as AnalyticsIcon,
  Phone as PhoneIcon,
  NavigateNext as NavigateNextIcon,
} from '@mui/icons-material';

const pathConfig = {
  '/': {
    label: 'Dashboard',
    icon: <DashboardIcon sx={{ fontSize: 16 }} />,
  },
  '/agents': {
    label: 'Agent Management',
    icon: <PersonIcon sx={{ fontSize: 16 }} />,
  },
  '/analytics': {
    label: 'Analytics',
    icon: <AnalyticsIcon sx={{ fontSize: 16 }} />,
  },
  '/calls': {
    label: 'Call Details',
    icon: <PhoneIcon sx={{ fontSize: 16 }} />,
  },
};

const Breadcrumbs = ({ showIcons = true, variant = 'default' }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();

  const pathnames = location.pathname.split('/').filter((x) => x);
  
  // Generate breadcrumb items
  const breadcrumbItems = [
    // Always include home/dashboard
    {
      path: '/',
      label: 'Dashboard',
      icon: <HomeIcon sx={{ fontSize: 16 }} />,
      isActive: location.pathname === '/',
    },
  ];

  // Build breadcrumb path
  let currentPath = '';
  
  pathnames.forEach((pathname, index) => {
    currentPath += `/${pathname}`;
    const isLast = index === pathnames.length - 1;
    
    // Handle dynamic routes
    let config = pathConfig[currentPath];
    let label = pathname;
    let icon = null;
    
    if (config) {
      label = config.label;
      icon = config.icon;
    } else {
      // Handle dynamic routes like /calls/:id
      const baseRoute = `/${pathname}`;
      if (pathConfig[baseRoute]) {
        label = `${pathConfig[baseRoute].label}`;
        icon = pathConfig[baseRoute].icon;
        
        // Add specific item identifier if available
        if (params.id) {
          label += ` #${params.id.slice(0, 8)}`;
        }
      } else {
        // Capitalize and format unknown routes
        label = pathname.charAt(0).toUpperCase() + pathname.slice(1).replace(/-/g, ' ');
      }
    }

    breadcrumbItems.push({
      path: currentPath,
      label,
      icon,
      isActive: isLast,
    });
  });

  const handleBreadcrumbClick = (path) => {
    navigate(path);
  };

  if (variant === 'compact') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
        <Chip
          icon={breadcrumbItems[breadcrumbItems.length - 1]?.icon}
          label={breadcrumbItems[breadcrumbItems.length - 1]?.label}
          variant="outlined"
          size="small"
          color="primary"
        />
      </Box>
    );
  }

  return (
    <Box sx={{ mb: 3 }}>
      <MuiBreadcrumbs
        separator={<NavigateNextIcon fontSize="small" />}
        aria-label="breadcrumb"
        sx={{
          '& .MuiBreadcrumbs-separator': {
            color: 'text.secondary',
          },
        }}
      >
        {breadcrumbItems.map((item, index) => {
          const isLast = index === breadcrumbItems.length - 1;
          
          if (isLast) {
            return (
              <Typography
                key={item.path}
                color="text.primary"
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  fontWeight: 600,
                }}
              >
                {showIcons && item.icon}
                {item.label}
              </Typography>
            );
          }

          return (
            <Link
              key={item.path}
              underline="hover"
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                cursor: 'pointer',
                color: 'text.secondary',
                '&:hover': {
                  color: 'primary.main',
                },
              }}
              onClick={() => handleBreadcrumbClick(item.path)}
            >
              {showIcons && item.icon}
              {item.label}
            </Link>
          );
        })}
      </MuiBreadcrumbs>
    </Box>
  );
};

export default Breadcrumbs; 