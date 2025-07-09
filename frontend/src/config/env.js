// Environment configuration
const config = {
  // API Configuration
  apiUrl: process.env.REACT_APP_API_URL || 'http://localhost:5000/api',
  
  // Application Configuration
  appName: process.env.REACT_APP_APP_NAME || 'Retell AI Dashboard',
  version: process.env.REACT_APP_VERSION || '1.0.0',
  environment: process.env.REACT_APP_ENVIRONMENT || 'development',
  
  // Feature Flags
  enableDarkMode: process.env.REACT_APP_ENABLE_DARK_MODE !== 'false',
  enableAnalytics: process.env.REACT_APP_ENABLE_ANALYTICS !== 'false',
  enableExports: process.env.REACT_APP_ENABLE_EXPORTS !== 'false',
  
  // Development Configuration
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',
  
  // API Endpoints
  endpoints: {
    calls: '/calls',
    agents: '/agents',
    analytics: '/analytics',
    health: '/health',
  },
  
  // UI Configuration
  ui: {
    itemsPerPage: 25,
    animationDuration: 200,
    toastDuration: 4000,
    drawerWidth: 240,
    headerHeight: 64,
  },
  
  // Chart Configuration
  charts: {
    colors: {
      primary: '#1976d2',
      secondary: '#9c27b0',
      success: '#4caf50',
      error: '#f44336',
      warning: '#ff9800',
      info: '#2196f3',
    },
    animations: {
      enabled: true,
      duration: 300,
    },
  },
};

// Helper functions
export const getApiUrl = (endpoint = '') => {
  const baseUrl = config.apiUrl.replace(/\/+$/, ''); // Remove trailing slashes
  const path = endpoint.replace(/^\/+/, ''); // Remove leading slashes
  return path ? `${baseUrl}/${path}` : baseUrl;
};

export const isFeatureEnabled = (feature) => {
  return config[feature] === true;
};

export const getChartColor = (colorName) => {
  return config.charts.colors[colorName] || config.charts.colors.primary;
};

export default config; 