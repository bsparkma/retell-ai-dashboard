/**
 * Callbacks Routes
 * 
 * Manages callback queue - tracking calls that need follow-up.
 */

const express = require('express');
const router = express.Router();

// In-memory storage (would be database in production)
let callbacks = [];
let callbackIdCounter = 1;

/**
 * GET /api/callbacks
 * 
 * Get all callbacks, optionally filtered by status
 */
router.get('/', (req, res) => {
  try {
    const { status, priority } = req.query;
    let filtered = [...callbacks];
    
    if (status) {
      filtered = filtered.filter(cb => cb.status === status);
    }
    if (priority) {
      filtered = filtered.filter(cb => cb.priority === priority);
    }
    
    // Sort by priority (emergency > high > medium > low) then by due date
    const priorityOrder = { emergency: 0, high: 1, medium: 2, low: 3 };
    filtered.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(a.due_at) - new Date(b.due_at);
    });
    
    res.json({
      success: true,
      count: filtered.length,
      callbacks: filtered,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/callbacks/stats
 * 
 * Get callback statistics
 */
router.get('/stats', (req, res) => {
  try {
    const pending = callbacks.filter(cb => cb.status === 'pending');
    const overdue = pending.filter(cb => new Date(cb.due_at) < new Date());
    
    const stats = {
      total: callbacks.length,
      pending: pending.length,
      completed: callbacks.filter(cb => cb.status === 'completed').length,
      overdue: overdue.length,
      by_priority: {
        emergency: pending.filter(cb => cb.priority === 'emergency').length,
        high: pending.filter(cb => cb.priority === 'high').length,
        medium: pending.filter(cb => cb.priority === 'medium').length,
        low: pending.filter(cb => cb.priority === 'low').length,
      },
    };
    
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/callbacks/:id
 * 
 * Get a specific callback
 */
router.get('/:id', (req, res) => {
  try {
    const callback = callbacks.find(cb => cb.id === req.params.id);
    
    if (!callback) {
      return res.status(404).json({ success: false, error: 'Callback not found' });
    }
    
    res.json({ success: true, callback });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/callbacks
 * 
 * Create a new callback
 */
router.post('/', (req, res) => {
  try {
    const {
      call_id,
      caller_name,
      caller_number,
      reason,
      priority = 'medium',
      due_at,
      assigned_to,
      notes,
    } = req.body;

    const callback = {
      id: `cb_${callbackIdCounter++}`,
      call_id,
      caller_name: caller_name || 'Unknown',
      caller_number,
      reason,
      priority,
      status: 'pending',
      due_at: due_at || new Date(Date.now() + 60 * 60 * 1000).toISOString(), // Default: 1 hour
      assigned_to,
      notes,
      attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    callbacks.push(callback);
    
    // Emit to connected clients
    const liveCallManager = require('../services/liveCallManager');
    if (liveCallManager.io) {
      liveCallManager.io.emit('callback:created', callback);
      liveCallManager.io.emit('callbacks:stats-updated', getStats());
    }
    
    res.status(201).json({ success: true, callback });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/callbacks/:id
 * 
 * Update a callback
 */
router.patch('/:id', (req, res) => {
  try {
    const index = callbacks.findIndex(cb => cb.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Callback not found' });
    }
    
    const updates = req.body;
    callbacks[index] = {
      ...callbacks[index],
      ...updates,
      updated_at: new Date().toISOString(),
    };
    
    // Emit to connected clients
    const liveCallManager = require('../services/liveCallManager');
    if (liveCallManager.io) {
      liveCallManager.io.emit('callback:updated', callbacks[index]);
      liveCallManager.io.emit('callbacks:stats-updated', getStats());
    }
    
    res.json({ success: true, callback: callbacks[index] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/callbacks/:id/attempt
 * 
 * Log a callback attempt
 */
router.post('/:id/attempt', (req, res) => {
  try {
    const index = callbacks.findIndex(cb => cb.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Callback not found' });
    }
    
    const { result, notes } = req.body;
    
    callbacks[index].attempts++;
    callbacks[index].last_attempt_at = new Date().toISOString();
    callbacks[index].updated_at = new Date().toISOString();
    
    if (result === 'completed') {
      callbacks[index].status = 'completed';
      callbacks[index].completed_at = new Date().toISOString();
    } else if (result === 'no_answer' && callbacks[index].attempts >= 3) {
      callbacks[index].status = 'failed';
    }
    
    if (notes) {
      callbacks[index].resolution_notes = notes;
    }
    
    // Emit to connected clients
    const liveCallManager = require('../services/liveCallManager');
    if (liveCallManager.io) {
      liveCallManager.io.emit('callback:updated', callbacks[index]);
      liveCallManager.io.emit('callbacks:stats-updated', getStats());
    }
    
    res.json({ success: true, callback: callbacks[index] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/callbacks/:id
 * 
 * Delete a callback
 */
router.delete('/:id', (req, res) => {
  try {
    const index = callbacks.findIndex(cb => cb.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Callback not found' });
    }
    
    callbacks.splice(index, 1);
    
    // Emit to connected clients
    const liveCallManager = require('../services/liveCallManager');
    if (liveCallManager.io) {
      liveCallManager.io.emit('callback:deleted', req.params.id);
      liveCallManager.io.emit('callbacks:stats-updated', getStats());
    }
    
    res.json({ success: true, message: 'Callback deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper function to get stats
function getStats() {
  const pending = callbacks.filter(cb => cb.status === 'pending');
  return {
    total: callbacks.length,
    pending: pending.length,
    overdue: pending.filter(cb => new Date(cb.due_at) < new Date()).length,
  };
}

// Create some sample callbacks for testing
function createSampleCallbacks() {
  callbacks = [
    {
      id: 'cb_1',
      call_id: 'call_001',
      caller_name: 'John Smith',
      caller_number: '+1-555-123-4567',
      reason: 'Left voicemail - requesting appointment',
      priority: 'high',
      status: 'pending',
      due_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 mins
      assigned_to: null,
      notes: 'New patient inquiry',
      attempts: 0,
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'cb_2',
      call_id: 'call_002',
      caller_name: 'Sarah Johnson',
      caller_number: '+1-555-987-6543',
      reason: 'Emergency - severe toothache',
      priority: 'emergency',
      status: 'pending',
      due_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 mins ago (overdue)
      assigned_to: null,
      notes: 'Patient in pain, needs immediate callback',
      attempts: 1,
      last_attempt_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      created_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    },
    {
      id: 'cb_3',
      call_id: 'call_003',
      caller_name: 'Mike Davis',
      caller_number: '+1-555-456-7890',
      reason: 'Transfer failed - insurance question',
      priority: 'medium',
      status: 'pending',
      due_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2 hours
      assigned_to: null,
      notes: 'Needs to speak with billing',
      attempts: 0,
      created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    },
    {
      id: 'cb_4',
      call_id: 'call_004',
      caller_name: 'Emily Brown',
      caller_number: '+1-555-321-0987',
      reason: 'General inquiry - office hours',
      priority: 'low',
      status: 'pending',
      due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
      assigned_to: null,
      notes: null,
      attempts: 0,
      created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    },
  ];
  callbackIdCounter = 5;
}

// Initialize with sample data
createSampleCallbacks();

module.exports = router;

