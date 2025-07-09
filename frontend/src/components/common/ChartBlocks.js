import React from 'react';
import {
  Card,
  CardContent,
  Typography,
  Box,
  IconButton,
  Tooltip,
  Menu,
  MenuItem,
} from '@mui/material';
import {
  MoreVert as MoreIcon,
  FileDownload as ExportIcon,
  Refresh as RefreshIcon,
  Fullscreen as FullscreenIcon,
} from '@mui/icons-material';
import { ResponsiveContainer } from 'recharts';
import { ChartSkeleton } from './SkeletonLoaders';

export const ChartBlock = ({
  title,
  subtitle,
  children,
  loading = false,
  height = 300,
  onExport,
  onRefresh,
  onFullscreen,
  actions = true,
  className,
  ...props
}) => {
  const [anchorEl, setAnchorEl] = React.useState(null);
  const open = Boolean(anchorEl);

  const handleMenuClick = (event) => {
    setAnchorEl(event.currentTarget);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
  };

  const handleAction = (action) => {
    handleMenuClose();
    switch (action) {
      case 'export':
        onExport?.();
        break;
      case 'refresh':
        onRefresh?.();
        break;
      case 'fullscreen':
        onFullscreen?.();
        break;
      default:
        break;
    }
  };

  if (loading) {
    return <ChartSkeleton height={height} title={!!title} />;
  }

  return (
    <Card className={className} {...props}>
      <CardContent>
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            mb: 2,
          }}
        >
          <Box>
            {title && (
              <Typography variant="h6" component="h2" gutterBottom>
                {title}
              </Typography>
            )}
            {subtitle && (
              <Typography variant="body2" color="text.secondary">
                {subtitle}
              </Typography>
            )}
          </Box>
          
          {actions && (
            <Box>
              <IconButton
                size="small"
                onClick={handleMenuClick}
                aria-label="chart actions"
              >
                <MoreIcon />
              </IconButton>
              <Menu
                anchorEl={anchorEl}
                open={open}
                onClose={handleMenuClose}
                transformOrigin={{ horizontal: 'right', vertical: 'top' }}
                anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
              >
                {onRefresh && (
                  <MenuItem onClick={() => handleAction('refresh')}>
                    <RefreshIcon sx={{ mr: 1, fontSize: 16 }} />
                    Refresh
                  </MenuItem>
                )}
                {onExport && (
                  <MenuItem onClick={() => handleAction('export')}>
                    <ExportIcon sx={{ mr: 1, fontSize: 16 }} />
                    Export
                  </MenuItem>
                )}
                {onFullscreen && (
                  <MenuItem onClick={() => handleAction('fullscreen')}>
                    <FullscreenIcon sx={{ mr: 1, fontSize: 16 }} />
                    Fullscreen
                  </MenuItem>
                )}
              </Menu>
            </Box>
          )}
        </Box>
        
        <Box sx={{ height: height, width: '100%' }}>
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        </Box>
      </CardContent>
    </Card>
  );
};

export const StatsCard = ({
  title,
  value,
  subtitle,
  icon,
  trend,
  trendValue,
  color = 'primary',
  loading = false,
  onClick,
  className,
  ...props
}) => {
  if (loading) {
    return <ChartSkeleton height={120} title={false} />;
  }

  const getTrendColor = (trend) => {
    switch (trend) {
      case 'up':
        return 'success.main';
      case 'down':
        return 'error.main';
      default:
        return 'text.secondary';
    }
  };

  const getTrendIcon = (trend) => {
    switch (trend) {
      case 'up':
        return '↗';
      case 'down':
        return '↘';
      default:
        return '→';
    }
  };

  return (
    <Card
      className={className}
      sx={{
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all 0.2s ease-in-out',
        '&:hover': onClick ? {
          transform: 'translateY(-2px)',
          boxShadow: 4,
        } : {},
        background: `linear-gradient(135deg, ${color === 'primary' ? '#1976d2' : '#9c27b0'}15, transparent)`,
      }}
      onClick={onClick}
      {...props}
    >
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              {title}
            </Typography>
            <Typography variant="h4" component="div" sx={{ fontWeight: 'bold', mb: 1 }}>
              {value}
            </Typography>
            {subtitle && (
              <Typography variant="body2" color="text.secondary">
                {subtitle}
              </Typography>
            )}
            {trend && trendValue && (
              <Box sx={{ display: 'flex', alignItems: 'center', mt: 1 }}>
                <Typography
                  variant="body2"
                  sx={{
                    color: getTrendColor(trend),
                    display: 'flex',
                    alignItems: 'center',
                    fontWeight: 500,
                  }}
                >
                  {getTrendIcon(trend)} {trendValue}
                </Typography>
              </Box>
            )}
          </Box>
          
          {icon && (
            <Box
              sx={{
                p: 1.5,
                borderRadius: 2,
                bgcolor: `${color}.main`,
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {icon}
            </Box>
          )}
        </Box>
      </CardContent>
    </Card>
  );
};

export const MetricCard = ({
  title,
  children,
  loading = false,
  className,
  ...props
}) => {
  if (loading) {
    return <ChartSkeleton height={200} title={!!title} />;
  }

  return (
    <Card className={className} {...props}>
      <CardContent>
        {title && (
          <Typography variant="h6" component="h2" gutterBottom>
            {title}
          </Typography>
        )}
        {children}
      </CardContent>
    </Card>
  );
}; 