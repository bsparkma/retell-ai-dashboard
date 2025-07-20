import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { Box, Container } from '@mui/material';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import Breadcrumbs from './components/common/Breadcrumbs';
import FloatingActionMenu from './components/common/FloatingActionMenu';
import Dashboard from './pages/Dashboard';
import CallDetails from './pages/CallDetails';
import Calendar from './pages/Calendar';
import Agents from './pages/Agents';
import Analytics from './pages/Analytics';
import config from './config/env';

function App() {
  const [sidebarOpen, setSidebarOpen] = React.useState(true);

  const handleSidebarToggle = () => {
    setSidebarOpen(!sidebarOpen);
  };

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <Header onMenuClick={handleSidebarToggle} />
      <Sidebar open={sidebarOpen} onToggle={handleSidebarToggle} />
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          mt: config.ui.headerHeight / 8, // Account for header height
          ml: sidebarOpen ? config.ui.drawerWidth / 8 - 1.5 : 5, // Reduced left margin for better space utilization
          transition: 'margin-left 0.3s ease',
          px: 2, // Reduced horizontal padding
          py: 3,
          width: `calc(100% - ${sidebarOpen ? config.ui.drawerWidth : 56}px)`, // Ensure full width usage
        }}
      >
        <Breadcrumbs />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/calls/:id" element={<CallDetails />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/analytics" element={<Analytics />} />
        </Routes>
      </Box>
      
      <FloatingActionMenu />
    </Box>
  );
}

export default App; 