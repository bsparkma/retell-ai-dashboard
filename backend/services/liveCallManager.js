/**
 * Live Call Manager
 * 
 * Manages the state of active calls in memory and provides
 * methods to add, update, and remove calls. Emits events
 * via Socket.IO when call state changes.
 */

class LiveCallManager {
  constructor() {
    this.activeCalls = new Map();
    this.io = null;
  }

  /**
   * Initialize with Socket.IO instance
   */
  setSocketIO(io) {
    this.io = io;
    console.log('📞 LiveCallManager initialized with Socket.IO');
  }

  /**
   * Add a new active call
   */
  addCall(callData) {
    const call = {
      call_id: callData.call_id,
      agent_id: callData.agent_id,
      agent_name: callData.agent_name || 'AI Agent',
      caller_number: callData.from_number || callData.caller_number || 'Unknown',
      caller_name: callData.caller_name || null,
      started_at: callData.start_timestamp || new Date().toISOString(),
      duration: 0,
      status: 'active',
      is_emergency: false,
      sentiment: 'neutral',
      sentiment_score: 0,
      transcript: [],
      transcript_text: '',
      metadata: callData.metadata || {},
      last_updated: new Date().toISOString()
    };

    this.activeCalls.set(call.call_id, call);
    
    // Emit to all connected clients
    if (this.io) {
      this.io.emit('call:started', call);
      this.io.emit('live-calls:update', this.getAllCalls());
    }

    console.log(`📞 Call started: ${call.call_id} from ${call.caller_number}`);
    return call;
  }

  /**
   * Update an existing call with new data
   */
  updateCall(callId, updates) {
    const call = this.activeCalls.get(callId);
    if (!call) {
      console.warn(`⚠️ Tried to update non-existent call: ${callId}`);
      return null;
    }

    // Merge updates
    const updatedCall = {
      ...call,
      ...updates,
      last_updated: new Date().toISOString()
    };

    // Calculate duration if call is still active
    if (updatedCall.started_at) {
      const startTime = new Date(updatedCall.started_at);
      updatedCall.duration = Math.floor((Date.now() - startTime) / 1000);
    }

    this.activeCalls.set(callId, updatedCall);

    // Emit update to clients
    if (this.io) {
      this.io.emit('call:updated', updatedCall);
      this.io.emit('live-calls:update', this.getAllCalls());
    }

    return updatedCall;
  }

  /**
   * Add transcript utterance to a call
   */
  addTranscriptUtterance(callId, utterance) {
    const call = this.activeCalls.get(callId);
    if (!call) {
      console.warn(`⚠️ Tried to add transcript to non-existent call: ${callId}`);
      return null;
    }

    // Format utterance
    const formattedUtterance = {
      role: utterance.role || 'unknown', // 'agent' or 'user'
      content: utterance.content || utterance.text || '',
      timestamp: utterance.timestamp || new Date().toISOString(),
      words: utterance.words || []
    };

    call.transcript.push(formattedUtterance);
    call.transcript_text = call.transcript
      .map(u => `${u.role === 'agent' ? 'Agent' : 'Caller'}: ${u.content}`)
      .join('\n');
    call.last_updated = new Date().toISOString();

    // Analyze sentiment from content
    call.sentiment = this.analyzeSentiment(call.transcript_text);

    // Detect emergency keywords
    call.is_emergency = this.detectEmergency(call.transcript_text);

    // Try to extract caller name if not already set
    if (!call.caller_name || call.caller_name === call.caller_number) {
      call.caller_name = this.extractCallerName(call.transcript_text) || call.caller_number;
    }

    this.activeCalls.set(callId, call);

    // Emit transcript update
    if (this.io) {
      this.io.emit('call:transcript', {
        call_id: callId,
        utterance: formattedUtterance,
        full_transcript: call.transcript
      });
      this.io.emit('call:updated', call);
    }

    return call;
  }

  /**
   * End a call and remove from active calls
   */
  endCall(callId, endData = {}) {
    const call = this.activeCalls.get(callId);
    if (!call) {
      console.warn(`⚠️ Tried to end non-existent call: ${callId}`);
      return null;
    }

    // Calculate final duration
    const endTime = endData.end_timestamp ? new Date(endData.end_timestamp) : new Date();
    const startTime = new Date(call.started_at);
    const duration = Math.floor((endTime - startTime) / 1000);

    // Create final call data
    const finalCall = {
      ...call,
      ...endData,
      status: 'ended',
      ended_at: endTime.toISOString(),
      duration,
      call_analysis: endData.call_analysis || null,
      recording_url: endData.recording_url || null,
      summary: endData.call_analysis?.call_summary || 
               endData.summary || 
               this.generateSummary(call.transcript_text)
    };

    // Remove from active calls
    this.activeCalls.delete(callId);

    // Emit call ended event
    if (this.io) {
      this.io.emit('call:ended', finalCall);
      this.io.emit('live-calls:update', this.getAllCalls());
    }

    console.log(`📞 Call ended: ${callId} (Duration: ${this.formatDuration(duration)})`);
    return finalCall;
  }

  /**
   * Get a specific call by ID
   */
  getCall(callId) {
    return this.activeCalls.get(callId) || null;
  }

  /**
   * Get all active calls
   */
  getAllCalls() {
    const calls = Array.from(this.activeCalls.values());
    
    // Update durations before returning
    const now = Date.now();
    return calls.map(call => ({
      ...call,
      duration: Math.floor((now - new Date(call.started_at)) / 1000)
    }));
  }

  /**
   * Get count of active calls
   */
  getActiveCount() {
    return this.activeCalls.size;
  }

  /**
   * Get emergency calls
   */
  getEmergencyCalls() {
    return this.getAllCalls().filter(call => call.is_emergency);
  }

  /**
   * Simple sentiment analysis based on keywords
   */
  analyzeSentiment(text) {
    if (!text) return 'neutral';

    const lowerText = text.toLowerCase();

    // Negative indicators
    const negativeWords = [
      'angry', 'frustrated', 'upset', 'terrible', 'horrible', 'worst',
      'unacceptable', 'disappointed', 'furious', 'hate', 'ridiculous',
      'pain', 'hurts', 'emergency', 'urgent', 'bleeding', 'swollen'
    ];

    // Positive indicators
    const positiveWords = [
      'thank you', 'thanks', 'great', 'wonderful', 'excellent', 'amazing',
      'appreciate', 'helpful', 'perfect', 'happy', 'pleased', 'fantastic'
    ];

    let negativeCount = 0;
    let positiveCount = 0;

    negativeWords.forEach(word => {
      if (lowerText.includes(word)) negativeCount++;
    });

    positiveWords.forEach(word => {
      if (lowerText.includes(word)) positiveCount++;
    });

    if (negativeCount > positiveCount && negativeCount >= 2) return 'negative';
    if (positiveCount > negativeCount && positiveCount >= 2) return 'positive';
    return 'neutral';
  }

  /**
   * Detect emergency keywords in transcript
   */
  detectEmergency(text) {
    if (!text) return false;

    const lowerText = text.toLowerCase();
    const emergencyKeywords = [
      'emergency', 'urgent', 'severe pain', 'bleeding',
      'swelling', 'can\'t breathe', 'chest pain', 'accident',
      'broken', 'knocked out', 'tooth fell out', 'abscess'
    ];

    return emergencyKeywords.some(keyword => lowerText.includes(keyword));
  }

  /**
   * Extract caller name from transcript
   */
  extractCallerName(text) {
    if (!text) return null;

    const patterns = [
      /(?:my name is|i'm|this is|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
      /(?:caller|user):\s*(?:hi|hello),?\s*(?:my name is|i'm|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        // Validate it's not a common word
        const invalidNames = ['okay', 'yes', 'no', 'sure', 'well', 'um', 'the'];
        if (!invalidNames.includes(name.toLowerCase())) {
          return name;
        }
      }
    }

    return null;
  }

  /**
   * Generate a simple summary from transcript
   */
  generateSummary(text) {
    if (!text || text.length < 50) {
      return 'Call transcript too short for summary.';
    }

    // Extract first few caller statements as summary
    const callerStatements = text
      .split('\n')
      .filter(line => line.startsWith('Caller:'))
      .slice(0, 3)
      .map(line => line.replace('Caller:', '').trim())
      .join(' ');

    if (callerStatements.length > 200) {
      return callerStatements.substring(0, 200) + '...';
    }

    return callerStatements || 'No summary available.';
  }

  /**
   * Format duration as MM:SS
   */
  formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Clear all active calls (for testing/reset)
   */
  clearAll() {
    this.activeCalls.clear();
    if (this.io) {
      this.io.emit('live-calls:update', []);
    }
    console.log('📞 All active calls cleared');
  }
}

// Export singleton instance
module.exports = new LiveCallManager();

