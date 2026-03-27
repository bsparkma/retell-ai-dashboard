import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeProvider';
import { NotificationProvider } from './contexts/NotificationContext';
import { SocketProvider } from './contexts/SocketContext';
import App from './App';

// FullCalendar CSS imports - handled by FullCalendar internally in v6+

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <SocketProvider>
          <NotificationProvider>
            <App />
          </NotificationProvider>
        </SocketProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
); 