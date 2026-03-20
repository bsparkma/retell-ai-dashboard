/**
 * Unified Call Store
 * 
 * In-memory store that combines calls from multiple sources:
 * - Retell AI (real-time via webhooks + API)
 * - Mango Voice (staff calls via scraper)
 * 
 * Provides unified API for querying all calls regardless of source.
 * 
 * Note: In production, this should be backed by a database (PostgreSQL/SQLite).
 * For now, we use in-memory storage with periodic persistence to JSON.
 */

const fs = require('fs').promises;
const path = require('path');

class UnifiedCallStore {
  constructor() {
    // All calls indexed by ID
    this.calls = new Map();
    
    // Indexes for fast lookups
    this.bySource = {
      retell: new Set(),
      mango: new Set(),
    };
    
    this.byDate = new Map(); // date string -> Set of call IDs
    this.byCallerNumber = new Map(); // phone -> Set of call IDs
    
    // Persistence settings
    this.persistPath = path.join(__dirname, '../../data/unified_calls.json');
    this.isDirty = false;
    this.autoSaveInterval = null;
    
    // Stats
    this.stats = {
      totalRetell: 0,
      totalMango: 0,
      lastRetellSync: null,
      lastMangoSync: null,
    };
  }

  /**
   * Initialize the store - load from disk if exists
   */
  async initialize() {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.persistPath);
      await fs.mkdir(dataDir, { recursive: true });
      
      // Try to load existing data
      try {
        const data = await fs.readFile(this.persistPath, 'utf-8');
        const parsed = JSON.parse(data);
        
        // Restore calls
        if (parsed.calls) {
          for (const call of parsed.calls) {
            this.addCallInternal(call, false);
          }
        }
        
        // Restore stats
        if (parsed.stats) {
          this.stats = { ...this.stats, ...parsed.stats };
        }
        
        console.log(`✅ Unified call store loaded: ${this.calls.size} calls`);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.error('⚠️ Error loading call store:', e.message);
        }
        console.log('📋 Starting with empty call store');
      }
      
      // Start auto-save interval
      this.startAutoSave();
      
    } catch (error) {
      console.error('❌ Failed to initialize call store:', error);
    }
  }

  /**
   * Add a call to the store (internal method)
   */
  addCallInternal(call, markDirty = true) {
    const id = call.id || call.call_id || call.external_id;
    if (!id) {
      console.error('Call missing ID, skipping');
      return null;
    }
    
    // Normalize the call structure
    const normalizedCall = this.normalizeCall(call);
    normalizedCall.id = id;
    
    // Store in main map
    this.calls.set(id, normalizedCall);
    
    // Update source index
    const source = normalizedCall.source || 'retell';
    if (this.bySource[source]) {
      this.bySource[source].add(id);
    }
    
    // Update date index
    const dateKey = normalizedCall.call_date?.split('T')[0] || new Date().toISOString().split('T')[0];
    if (!this.byDate.has(dateKey)) {
      this.byDate.set(dateKey, new Set());
    }
    this.byDate.get(dateKey).add(id);
    
    // Update caller number index
    const phone = normalizedCall.caller_number;
    if (phone) {
      if (!this.byCallerNumber.has(phone)) {
        this.byCallerNumber.set(phone, new Set());
      }
      this.byCallerNumber.get(phone).add(id);
    }
    
    if (markDirty) {
      this.isDirty = true;
    }
    
    return normalizedCall;
  }

  /**
   * Normalize call to unified format
   */
  normalizeCall(call) {
    const source = call.source || 'retell';
    
    // Common fields
    const normalized = {
      id: call.id || call.call_id || call.external_id,
      source: source,
      external_id: call.external_id || call.call_id || call.id,
      
      // Call metadata
      call_date: call.call_date || call.start_timestamp || new Date().toISOString(),
      duration_seconds: call.duration_seconds || call.duration || 0,
      
      // Caller info
      caller_number: call.caller_number || call.from_number || 'Unknown',
      caller_name: call.caller_name || null,
      
      // Handler info
      handler_type: call.handler_type || (source === 'mango' ? 'staff' : 'ai'),
      handler_id: call.handler_id || call.agent_id || null,
      handler_name: call.handler_name || call.agent_name || null,
      
      // Call details
      outcome: call.outcome || call.success_status || 'unknown',
      call_reason: call.call_reason || call.reason || null,
      is_emergency: call.is_emergency || false,
      sentiment: call.sentiment || 'neutral',
      
      // Transfer tracking
      transfer_attempted: call.transfer_attempted || false,
      transfer_status: call.transfer_status || 'none',
      transfer_destination: call.transfer_destination || null,
      callback_required: call.callback_required || false,
      callback_reason: call.callback_reason || null,
      
      // Content
      summary: call.summary || call.call_summary || call.call_analysis?.call_summary || null,
      transcript: call.transcript || null,
      transcript_json: call.transcript_json || call.transcript_object || null,
      recording_url: call.recording_url || null,
      recording_path: call.recording_path || null,

      // Source-specific metadata (useful for deep links + recording retrieval)
      mango_call_id: call.mango_call_id || call.raw_data?.mango_call_id || null,
      mango_detail_url: call.mango_detail_url || call.raw_data?.mango_detail_url || null,
      
      // Patient matching
      patient_id: call.patient_id || null,
      patient_matched_by: call.patient_matched_by || null,
      is_new_patient: call.is_new_patient || null,
      
      // QA
      qa_score: call.qa_score || null,
      qa_evaluated_at: call.qa_evaluated_at || null,
      
      // Timestamps
      created_at: call.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    
    return normalized;
  }

  /**
   * Add or update a call from Retell AI
   */
  addRetellCall(call) {
    const existing = this.calls.get(call.call_id);

    // Compute duration from Retell timestamps if not already set
    let duration = call.duration_seconds || call.duration || 0;
    if (!duration && call.start_timestamp && call.end_timestamp) {
      duration = Math.round((new Date(call.end_timestamp) - new Date(call.start_timestamp)) / 1000);
    }

    const normalizedCall = {
      ...call,
      source: 'retell',
      handler_type: 'ai',
      duration_seconds: duration,
      // Map Retell-specific fields to our unified schema
      caller_number: call.caller_number || call.from_number || 'Unknown',
      call_date: call.call_date || call.start_timestamp || new Date().toISOString(),
    };

    const stored = this.addCallInternal(normalizedCall);

    if (!existing) {
      this.stats.totalRetell++;
    }
    this.stats.lastRetellSync = new Date().toISOString();

    return stored;
  }

  /**
   * Add calls from Mango Voice scraper
   */
  addMangoCalls(calls) {
    const added = [];
    const updated = [];
    
    for (const call of calls) {
      // Check if already exists (by external_id)
      const existingId = Array.from(this.calls.values())
        .find(c => c.external_id === call.external_id)?.id;
      
      const normalizedCall = {
        ...call,
        source: 'mango',
        handler_type: 'staff',
      };

      // If it already exists, update it with any new fields (recording_url/path/transcript/etc)
      if (existingId) {
        const existing = this.calls.get(existingId);
        if (existing) {
          const merged = {
            ...existing,
            ...this.normalizeCall({ ...existing, ...normalizedCall, id: existingId }),
            updated_at: new Date().toISOString(),
          };
          this.calls.set(existingId, merged);
          this.isDirty = true;
          updated.push(merged);
        }
        continue;
      }

      const stored = this.addCallInternal(normalizedCall);
      if (stored) {
        added.push(stored);
        this.stats.totalMango++;
      }
    }
    
    this.stats.lastMangoSync = new Date().toISOString();
    console.log(`✅ Mango store upsert: added ${added.length}, updated ${updated.length}`);
    
    return added;
  }

  /**
   * Get a call by ID
   */
  getCall(id) {
    return this.calls.get(id);
  }

  /**
   * Get all calls with optional filters
   */
  getCalls(options = {}) {
    const {
      source, // 'retell', 'mango', or null for all
      startDate,
      endDate,
      limit = 100,
      offset = 0,
      sortBy = 'call_date',
      sortOrder = 'desc',
      callerNumber,
      sentiment,
      outcome,
      handlerType,
      isEmergency,
      callbackRequired,
    } = options;
    
    let results = Array.from(this.calls.values());
    
    // Filter by source
    if (source) {
      results = results.filter(c => c.source === source);
    }
    
    // Filter by date range
    if (startDate) {
      const start = new Date(startDate);
      results = results.filter(c => new Date(c.call_date) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      results = results.filter(c => new Date(c.call_date) <= end);
    }
    
    // Filter by caller number
    if (callerNumber) {
      results = results.filter(c => c.caller_number?.includes(callerNumber));
    }
    
    // Filter by sentiment
    if (sentiment) {
      results = results.filter(c => c.sentiment === sentiment);
    }
    
    // Filter by outcome
    if (outcome) {
      results = results.filter(c => c.outcome === outcome);
    }
    
    // Filter by handler type
    if (handlerType) {
      results = results.filter(c => c.handler_type === handlerType);
    }
    
    // Filter by emergency status
    if (isEmergency !== undefined) {
      results = results.filter(c => c.is_emergency === isEmergency);
    }
    
    // Filter by callback required
    if (callbackRequired !== undefined) {
      results = results.filter(c => c.callback_required === callbackRequired);
    }
    
    // Sort
    results.sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      
      // Handle date sorting
      if (sortBy === 'call_date') {
        valA = new Date(valA);
        valB = new Date(valB);
      }
      
      if (sortOrder === 'desc') {
        return valB > valA ? 1 : valB < valA ? -1 : 0;
      } else {
        return valA > valB ? 1 : valA < valB ? -1 : 0;
      }
    });
    
    // Get total before pagination
    const total = results.length;
    
    // Apply pagination
    results = results.slice(offset, offset + limit);
    
    return {
      calls: results,
      total,
      pagination: {
        limit,
        offset,
        hasMore: offset + results.length < total,
      },
    };
  }

  /**
   * Get calls by caller phone number
   */
  getCallsByPhone(phone) {
    const callIds = this.byCallerNumber.get(phone) || new Set();
    return Array.from(callIds).map(id => this.calls.get(id)).filter(Boolean);
  }

  /**
   * Get calls for a specific date
   */
  getCallsByDate(dateString) {
    const callIds = this.byDate.get(dateString) || new Set();
    return Array.from(callIds).map(id => this.calls.get(id)).filter(Boolean);
  }

  /**
   * Update a call
   */
  updateCall(id, updates) {
    const call = this.calls.get(id);
    if (!call) {
      return null;
    }
    
    const updatedCall = {
      ...call,
      ...updates,
      updated_at: new Date().toISOString(),
    };
    
    this.calls.set(id, updatedCall);
    this.isDirty = true;
    
    return updatedCall;
  }

  /**
   * Get store statistics
   */
  getStats() {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const todayCalls = this.getCallsByDate(today);
    
    // Calculate source breakdown
    const retellCalls = Array.from(this.bySource.retell).length;
    const mangoCalls = Array.from(this.bySource.mango).length;
    
    // Calculate sentiment breakdown
    const allCalls = Array.from(this.calls.values());
    const sentimentBreakdown = {
      positive: allCalls.filter(c => c.sentiment === 'positive').length,
      neutral: allCalls.filter(c => c.sentiment === 'neutral').length,
      negative: allCalls.filter(c => c.sentiment === 'negative').length,
    };
    
    // Calculate handler breakdown
    const aiCalls = allCalls.filter(c => c.handler_type === 'ai').length;
    const staffCalls = allCalls.filter(c => c.handler_type === 'staff').length;
    
    return {
      totalCalls: this.calls.size,
      todayCalls: todayCalls.length,
      bySource: {
        retell: retellCalls,
        mango: mangoCalls,
      },
      byHandler: {
        ai: aiCalls,
        staff: staffCalls,
      },
      sentiment: sentimentBreakdown,
      emergencyCalls: allCalls.filter(c => c.is_emergency).length,
      callbacksNeeded: allCalls.filter(c => c.callback_required).length,
      lastSync: {
        retell: this.stats.lastRetellSync,
        mango: this.stats.lastMangoSync,
      },
    };
  }

  /**
   * Persist store to disk
   */
  async persist() {
    if (!this.isDirty) {
      return;
    }
    
    try {
      const data = {
        calls: Array.from(this.calls.values()),
        stats: this.stats,
        savedAt: new Date().toISOString(),
      };
      
      await fs.writeFile(this.persistPath, JSON.stringify(data, null, 2));
      this.isDirty = false;
      console.log(`💾 Saved ${this.calls.size} calls to disk`);
    } catch (error) {
      console.error('❌ Failed to persist call store:', error);
    }
  }

  /**
   * Start auto-save interval
   */
  startAutoSave(intervalMs = 60000) {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    
    this.autoSaveInterval = setInterval(() => {
      this.persist();
    }, intervalMs);
    
    console.log(`⏰ Auto-save enabled (every ${intervalMs / 1000}s)`);
  }

  /**
   * Stop auto-save and persist final state
   */
  async shutdown() {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    await this.persist();
    console.log('✅ Call store shutdown complete');
  }

  /**
   * Clear all data (for testing)
   */
  clear() {
    this.calls.clear();
    this.bySource.retell.clear();
    this.bySource.mango.clear();
    this.byDate.clear();
    this.byCallerNumber.clear();
    this.stats = {
      totalRetell: 0,
      totalMango: 0,
      lastRetellSync: null,
      lastMangoSync: null,
    };
    this.isDirty = true;
  }
}

// Export singleton instance
const unifiedCallStore = new UnifiedCallStore();
module.exports = unifiedCallStore;

