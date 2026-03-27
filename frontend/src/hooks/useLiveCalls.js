/**
 * useLiveCalls Hook
 * 
 * Manages live call state from Socket.IO events.
 * Provides real-time updates for active calls.
 */

import { useState, useEffect, useCallback } from 'react';
import { useSocket } from '../contexts/SocketContext';

/**
 * Hook for managing live calls state
 */
export const useLiveCalls = () => {
  const { socket, isConnected, subscribe, emit } = useSocket();
  const [liveCalls, setLiveCalls] = useState([]);
  const [selectedCallId, setSelectedCallId] = useState(null);
  const [loading, setLoading] = useState(true);

  // Subscribe to live call events
  useEffect(() => {
    if (!socket || !isConnected) {
      setLoading(true);
      return;
    }

    // Request current live calls
    emit('live-calls:get');

    // Handle live calls update
    const unsubscribeUpdate = subscribe('live-calls:update', (calls) => {
      setLiveCalls(calls || []);
      setLoading(false);
    });

    // Handle new call started
    const unsubscribeStarted = subscribe('call:started', (call) => {
      setLiveCalls(prev => {
        // Check if call already exists
        const exists = prev.some(c => c.call_id === call.call_id);
        if (exists) {
          return prev.map(c => c.call_id === call.call_id ? call : c);
        }
        return [...prev, call];
      });
    });

    // Handle call updated
    const unsubscribeUpdated = subscribe('call:updated', (call) => {
      setLiveCalls(prev => 
        prev.map(c => c.call_id === call.call_id ? call : c)
      );
    });

    // Handle call ended
    const unsubscribeEnded = subscribe('call:ended', (call) => {
      setLiveCalls(prev => 
        prev.filter(c => c.call_id !== call.call_id)
      );
      // If we were watching this call, clear selection
      if (selectedCallId === call.call_id) {
        setSelectedCallId(null);
      }
    });

    // Cleanup
    return () => {
      unsubscribeUpdate();
      unsubscribeStarted();
      unsubscribeUpdated();
      unsubscribeEnded();
    };
  }, [socket, isConnected, subscribe, emit, selectedCallId]);

  // Get count of active calls
  const activeCount = liveCalls.length;

  // Get count of emergency calls
  const emergencyCount = liveCalls.filter(c => c.is_emergency).length;

  // Get selected call details
  const selectedCall = selectedCallId 
    ? liveCalls.find(c => c.call_id === selectedCallId) 
    : null;

  // Select a call to monitor
  const selectCall = useCallback((callId) => {
    setSelectedCallId(callId);
    if (callId) {
      emit('call:subscribe', callId);
    }
  }, [emit]);

  // Clear selection
  const clearSelection = useCallback(() => {
    if (selectedCallId) {
      emit('call:unsubscribe', selectedCallId);
    }
    setSelectedCallId(null);
  }, [emit, selectedCallId]);

  // Refresh live calls
  const refresh = useCallback(() => {
    setLoading(true);
    emit('live-calls:get');
  }, [emit]);

  return {
    liveCalls,
    activeCount,
    emergencyCount,
    selectedCall,
    selectedCallId,
    selectCall,
    clearSelection,
    loading,
    refresh,
    isConnected
  };
};

/**
 * Hook for monitoring a specific call's transcript
 */
export const useCallTranscript = (callId) => {
  const { subscribe } = useSocket();
  const [transcript, setTranscript] = useState([]);
  const [latestUtterance, setLatestUtterance] = useState(null);

  useEffect(() => {
    if (!callId) {
      setTranscript([]);
      setLatestUtterance(null);
      return;
    }

    // Handle transcript updates
    const unsubscribe = subscribe('call:transcript', (data) => {
      if (data.call_id === callId) {
        if (data.full_transcript) {
          setTranscript(data.full_transcript);
        }
        if (data.utterance) {
          setLatestUtterance(data.utterance);
        }
      }
    });

    return unsubscribe;
  }, [callId, subscribe]);

  return { transcript, latestUtterance };
};

export default useLiveCalls;

