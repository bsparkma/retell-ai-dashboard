import React, { createContext, useContext, useState, useEffect } from 'react';
import { ThemeProvider as MuiThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';

const ThemeContext = createContext();

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

const getTheme = (mode) => createTheme({
  palette: {
    mode,
    primary: {
      main: mode === 'dark' ? '#90caf9' : '#1976d2',
      light: mode === 'dark' ? '#e3f2fd' : '#42a5f5',
      dark: mode === 'dark' ? '#42a5f5' : '#1565c0',
    },
    secondary: {
      main: mode === 'dark' ? '#ce93d8' : '#9c27b0',
      light: mode === 'dark' ? '#f3e5f5' : '#ba68c8',
      dark: mode === 'dark' ? '#ba68c8' : '#7b1fa2',
    },
    success: {
      main: mode === 'dark' ? '#81c784' : '#4caf50',
      light: mode === 'dark' ? '#c8e6c9' : '#81c784',
      dark: mode === 'dark' ? '#4caf50' : '#388e3c',
    },
    error: {
      main: mode === 'dark' ? '#f48fb1' : '#f44336',
      light: mode === 'dark' ? '#fce4ec' : '#e57373',
      dark: mode === 'dark' ? '#e91e63' : '#d32f2f',
    },
    warning: {
      main: mode === 'dark' ? '#ffb74d' : '#ff9800',
      light: mode === 'dark' ? '#fff3e0' : '#ffb74d',
      dark: mode === 'dark' ? '#ff9800' : '#f57c00',
    },
    background: {
      default: mode === 'dark' ? '#121212' : '#f5f5f5',
      paper: mode === 'dark' ? '#1e1e1e' : '#ffffff',
    },
    text: {
      primary: mode === 'dark' ? '#ffffff' : '#1a1a1a',
      secondary: mode === 'dark' ? '#b3b3b3' : '#666666',
    },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h1: {
      fontWeight: 700,
      fontSize: '2.125rem',
      lineHeight: 1.2,
    },
    h2: {
      fontWeight: 700,
      fontSize: '1.875rem',
      lineHeight: 1.2,
    },
    h3: {
      fontWeight: 600,
      fontSize: '1.5rem',
      lineHeight: 1.3,
    },
    h4: {
      fontWeight: 600,
      fontSize: '1.25rem',
      lineHeight: 1.4,
    },
    h5: {
      fontWeight: 600,
      fontSize: '1.125rem',
      lineHeight: 1.4,
    },
    h6: {
      fontWeight: 600,
      fontSize: '1rem',
      lineHeight: 1.5,
    },
    body1: {
      fontSize: '0.875rem',
      lineHeight: 1.5,
    },
    body2: {
      fontSize: '0.75rem',
      lineHeight: 1.5,
    },
    button: {
      fontWeight: 500,
      fontSize: '0.875rem',
      textTransform: 'none',
    },
  },
  spacing: 8, // Base spacing unit (8px)
  shape: {
    borderRadius: 12,
  },
  components: {
    MuiCard: {
      styleOverrides: {
        root: {
          boxShadow: mode === 'dark' 
            ? '0 4px 12px rgba(0,0,0,0.3)' 
            : '0 2px 8px rgba(0,0,0,0.1)',
          borderRadius: 16,
          border: mode === 'dark' ? '1px solid rgba(255,255,255,0.12)' : 'none',
          transition: 'all 0.2s ease-in-out',
          '&:hover': {
            transform: 'translateY(-2px)',
            boxShadow: mode === 'dark' 
              ? '0 8px 20px rgba(0,0,0,0.4)' 
              : '0 4px 16px rgba(0,0,0,0.15)',
          },
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          textTransform: 'none',
          fontWeight: 500,
          padding: '8px 16px',
          boxShadow: 'none',
          '&:hover': {
            boxShadow: 'none',
            transform: 'translateY(-1px)',
          },
        },
        contained: {
          boxShadow: mode === 'dark' 
            ? '0 2px 8px rgba(0,0,0,0.3)' 
            : '0 2px 8px rgba(0,0,0,0.15)',
          '&:hover': {
            boxShadow: mode === 'dark' 
              ? '0 4px 12px rgba(0,0,0,0.4)' 
              : '0 4px 12px rgba(0,0,0,0.2)',
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          fontWeight: 500,
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            borderRadius: 8,
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          border: mode === 'dark' ? '1px solid rgba(255,255,255,0.12)' : 'none',
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          boxShadow: mode === 'dark' 
            ? '0 4px 12px rgba(0,0,0,0.3)' 
            : '0 2px 8px rgba(0,0,0,0.1)',
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          border: 'none',
          boxShadow: mode === 'dark' 
            ? '4px 0 12px rgba(0,0,0,0.3)' 
            : '4px 0 12px rgba(0,0,0,0.1)',
        },
      },
    },
    MuiTableContainer: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          border: mode === 'dark' ? '1px solid rgba(255,255,255,0.12)' : 'none',
        },
      },
    },
  },
});

export const ThemeProvider = ({ children }) => {
  const [mode, setMode] = useState(() => {
    const saved = localStorage.getItem('theme-mode');
    return saved || 'light';
  });

  useEffect(() => {
    localStorage.setItem('theme-mode', mode);
  }, [mode]);

  const toggleTheme = () => {
    setMode(prev => prev === 'light' ? 'dark' : 'light');
  };

  const theme = getTheme(mode);

  const contextValue = {
    mode,
    toggleTheme,
    theme,
  };

  return (
    <ThemeContext.Provider value={contextValue}>
      <MuiThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </ThemeContext.Provider>
  );
}; 