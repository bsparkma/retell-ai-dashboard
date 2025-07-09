import React, { createContext, useContext, useState, useEffect } from 'react';

const NotificationContext = createContext();

export const useNotifications = () => {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return context;
};

export const NotificationProvider = ({ children }) => {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  // Generate mock notifications for demo
  useEffect(() => {
    const generateMockNotifications = () => {
      const mockNotifications = [
        {
          id: '1',
          type: 'error',
          title: 'Failed Call',
          message: 'Call with patient #12345 failed due to connection timeout',
          timestamp: new Date(Date.now() - 5 * 60000), // 5 minutes ago
          read: false,
          severity: 'high',
          action: '/calls/12345',
        },
        {
          id: '2',
          type: 'warning',
          title: 'Agent Performance',
          message: 'Emergency AI agent response time increased by 15%',
          timestamp: new Date(Date.now() - 15 * 60000), // 15 minutes ago
          read: false,
          severity: 'medium',
          action: '/agents',
        },
        {
          id: '3',
          type: 'error',
          title: 'API Issue',
          message: 'Retell API experiencing intermittent connection issues',
          timestamp: new Date(Date.now() - 30 * 60000), // 30 minutes ago
          read: true,
          severity: 'high',
          action: null,
        },
        {
          id: '4',
          type: 'info',
          title: 'Daily Summary',
          message: '127 calls processed today with 94% success rate',
          timestamp: new Date(Date.now() - 2 * 60 * 60000), // 2 hours ago
          read: false,
          severity: 'low',
          action: '/analytics',
        },
        {
          id: '5',
          type: 'warning',
          title: 'Unresolved Calls',
          message: '3 calls require manual review and follow-up',
          timestamp: new Date(Date.now() - 45 * 60000), // 45 minutes ago
          read: false,
          severity: 'medium',
          action: '/?filter=unresolved',
        },
      ];

      setNotifications(mockNotifications);
      updateUnreadCount(mockNotifications);
    };

    generateMockNotifications();

    // Simulate real-time notifications every 30 seconds
    const interval = setInterval(() => {
      const newNotification = generateRandomNotification();
      if (newNotification) {
        addNotification(newNotification);
      }
    }, 30000);

    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const generateRandomNotification = () => {
    const random = Math.random();
    if (random > 0.7) { // 30% chance of new notification
      const types = ['error', 'warning', 'info'];
      const type = types[Math.floor(Math.random() * types.length)];
      
      const notifications = {
        error: [
          'Call connection failed',
          'Agent response timeout',
          'API authentication error',
        ],
        warning: [
          'High call volume detected',
          'Agent performance degraded',
          'Unusual sentiment pattern',
        ],
        info: [
          'New agent deployment successful',
          'System maintenance completed',
          'Analytics report generated',
        ],
      };

      const messages = notifications[type];
      const message = messages[Math.floor(Math.random() * messages.length)];

      return {
        id: Date.now().toString(),
        type,
        title: type.charAt(0).toUpperCase() + type.slice(1),
        message,
        timestamp: new Date(),
        read: false,
        severity: type === 'error' ? 'high' : type === 'warning' ? 'medium' : 'low',
        action: type === 'error' ? '/calls' : type === 'warning' ? '/agents' : '/analytics',
      };
    }
    return null;
  };

  const updateUnreadCount = (notificationList) => {
    const unread = notificationList.filter(n => !n.read).length;
    setUnreadCount(unread);
  };

  const addNotification = (notification) => {
    setNotifications(prev => {
      const updated = [notification, ...prev];
      updateUnreadCount(updated);
      return updated;
    });
  };

  const markAsRead = (id) => {
    setNotifications(prev => {
      const updated = prev.map(n => 
        n.id === id ? { ...n, read: true } : n
      );
      updateUnreadCount(updated);
      return updated;
    });
  };

  const markAllAsRead = () => {
    setNotifications(prev => {
      const updated = prev.map(n => ({ ...n, read: true }));
      updateUnreadCount(updated);
      return updated;
    });
  };

  const removeNotification = (id) => {
    setNotifications(prev => {
      const updated = prev.filter(n => n.id !== id);
      updateUnreadCount(updated);
      return updated;
    });
  };

  const clearAllNotifications = () => {
    setNotifications([]);
    setUnreadCount(0);
  };

  const getNotificationsByType = (type) => {
    return notifications.filter(n => n.type === type);
  };

  const getUnreadNotifications = () => {
    return notifications.filter(n => !n.read);
  };

  const contextValue = {
    notifications,
    unreadCount,
    addNotification,
    markAsRead,
    markAllAsRead,
    removeNotification,
    clearAllNotifications,
    getNotificationsByType,
    getUnreadNotifications,
  };

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
    </NotificationContext.Provider>
  );
}; 