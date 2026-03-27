# CareIn Dashboard V2 - Master Implementation Plan

## 🎯 Project Overview

### Vision
Transform the CareIn Dashboard from a basic Retell AI call viewer into a **comprehensive unified call management platform** that monitors ALL calls (both AI and staff-handled), provides full transcription, quality assurance scoring, and deep Open Dental integration.

### Current State
- Basic dashboard viewing Retell AI calls
- Some Open Dental calendar integration
- Manual agent management
- No visibility into staff-handled calls
- No real-time monitoring
- No quality assurance

### Target State
- Real-time live call monitoring for AI calls
- Unified visibility of ALL calls (AI + staff)
- Full transcription for every call (including staff via Mango Voice)
- Automated AI quality assurance scoring
- Deep Open Dental integration (transcripts synced to patient records)
- Developer dashboard for system health monitoring
- Smart callback queue management
- Modern UI with command palette, notifications

---

## 🏗️ Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CALL SOURCES                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─────────────────┐                    ┌─────────────────┐               │
│   │   MANGO VOICE   │                    │   RETELL AI     │               │
│   │   (Staff Calls) │                    │   (AI Calls)    │               │
│   │                 │                    │                 │               │
│   │ • Call logs     │                    │ • Transcripts   │               │
│   │ • Recordings    │                    │ • Recordings    │               │
│   │ • No transcript │                    │ • Webhooks      │               │
│   │ • No API        │                    │ • Full API      │               │
│   └────────┬────────┘                    └────────┬────────┘               │
│            │                                      │                         │
│            │ Scrape/Download                      │ Webhooks (real-time)    │
│            ▼                                      ▼                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                              BACKEND                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                     NODE.JS + EXPRESS                               │  │
│   │                                                                     │  │
│   │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐ │  │
│   │  │ Mango       │  │ Retell      │  │ Transcribe  │  │ AI QA     │ │  │
│   │  │ Scraper     │  │ Webhooks    │  │ Service     │  │ Evaluator │ │  │
│   │  └─────────────┘  └─────────────┘  └─────────────┘  └───────────┘ │  │
│   │                                                                     │  │
│   │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐ │  │
│   │  │ Socket.IO   │  │ Open Dental │  │ Notification│  │ Queue     │ │  │
│   │  │ Server      │  │ Sync        │  │ Service     │  │ Manager   │ │  │
│   │  └─────────────┘  └─────────────┘  └─────────────┘  └───────────┘ │  │
│   │                                                                     │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                           │                                                 │
│                           ▼                                                 │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                     DATABASE (PostgreSQL/SQLite)                    │  │
│   │  • calls, transcripts, recordings, qa_scores, callbacks, sync_logs │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                              FRONTEND                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                     REACT + MATERIAL UI                             │  │
│   │                                                                     │  │
│   │  Pages:                        Components:                          │  │
│   │  • Dashboard (unified calls)   • LiveCallMonitor                    │  │
│   │  • LiveMonitor                 • ChatBubbleTranscript               │  │
│   │  • CallDetails                 • CallbackQueue                      │  │
│   │  • Callbacks                   • QAScoreCard                        │  │
│   │  • QA & Analytics              • SystemHealthWidget                 │  │
│   │  • Admin/Developer             • CommandPalette                     │  │
│   │  • Calendar (Open Dental)      • NotificationBell                   │  │
│   │  • Agents                      • SentimentGauge                     │  │
│   │                                                                     │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                          EXTERNAL SERVICES                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│   │ Deepgram    │  │ OpenAI/     │  │ Open Dental │  │ Slack       │      │
│   │ (Transcribe)│  │ Claude (QA) │  │ (Database)  │  │ (Alerts)    │      │
│   └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📋 Implementation Phases

### Phase 1: Retell Live Monitoring (Week 1-2) ✅ COMPLETE
**Goal:** Real-time visibility into AI-handled calls

#### Week 1: Backend Infrastructure ✅ COMPLETE
| Task | File(s) | Description | Status |
|------|---------|-------------|--------|
| 1.1 | `backend/socket/socketHandler.js` | Set up Socket.IO server alongside Express | ✅ |
| 1.2 | `backend/routes/webhooks.js` | Create POST `/api/webhooks/retell` endpoint | ✅ |
| 1.3 | `backend/services/liveCallManager.js` | In-memory store for active calls | ✅ |
| 1.4 | `backend/server.js` | Integrate Socket.IO with Express | ✅ |
| 1.5 | Retell Dashboard | Configure webhook URL in Retell settings | ✅ |

**Webhook Events to Handle:**
- `call_started` - Add to active calls, emit to frontend
- `call_ended` - Remove from active, store final data
- `call_analyzed` - Update with post-call analysis

#### Week 2: Frontend Live Dashboard ✅ COMPLETE
| Task | File(s) | Description | Status |
|------|---------|-------------|--------|
| 2.1 | `frontend/src/contexts/SocketContext.js` | Socket.IO client provider | ✅ |
| 2.2 | `frontend/src/hooks/useLiveCalls.js` | Hook for live call state | ✅ |
| 2.3 | `frontend/src/pages/LiveMonitor.js` | New live calls page | ✅ |
| 2.4 | `frontend/src/components/LiveCalls/LiveCallCard.js` | Individual live call display | ✅ |
| 2.5 | `frontend/src/components/LiveCalls/LiveTranscript.js` | Real-time transcript display | ✅ |
| 2.6 | `frontend/src/components/LiveCalls/SentimentGauge.js` | Live sentiment indicator | ✅ |
| 2.7 | `frontend/src/components/Sidebar.js` | Add live call indicator/count to sidebar | ✅ |

**Deliverables:**
- [x] See AI calls start/end in real-time
- [x] Watch transcripts appear as conversation happens
- [x] Live sentiment gauge during calls
- [x] Emergency call instant alerts
- [x] Sidebar badge showing active call count

---

### Phase 2: Mango Voice Integration (Week 3-4) ✅ COMPLETE
**Goal:** Import staff-handled calls with full transcription

#### Week 3: Mango Scraper ✅ COMPLETE
| Task | File(s) | Description | Status |
|------|---------|-------------|--------|
| 3.1 | `backend/services/mangoScraper.js` | Puppeteer-based Mango portal scraper | ✅ |
| 3.2 | `backend/services/mangoScraper.js` | Login handler with session persistence | ✅ |
| 3.3 | `backend/services/mangoScraper.js` | Call log extraction (date, time, from, to, duration) | ✅ |
| 3.4 | `backend/services/mangoScraper.js` | Recording download functionality | ✅ |
| 3.5 | `backend/services/syncScheduler.js` | Scheduled sync job (configurable interval) | ✅ |
| 3.6 | `backend/config/mango.js` | Mango credentials/config | ✅ |

**Mango Portal Details:**
- URL: [User to provide]
- Login: Username/password auth
- Call log fields: Date, Time, Outcome, From, To, Duration
- Recordings: MP3 format, individual download

#### Week 4: Transcription Pipeline ✅ COMPLETE
| Task | File(s) | Description | Status |
|------|---------|-------------|--------|
| 4.1 | `backend/services/transcriptionService.js` | Deepgram API integration | ✅ |
| 4.2 | `backend/services/transcriptionService.js` | Queue management for batch processing | ✅ |
| 4.3 | `backend/services/transcriptionService.js` | Transcript storage and formatting | ✅ |
| 4.4 | `backend/services/callAnalyzer.js` | Extract caller name from transcript | ✅ |
| 4.5 | `backend/services/callAnalyzer.js` | Determine call reason/outcome | ✅ |
| 4.6 | `backend/services/callAnalyzer.js` | Sentiment analysis | ✅ |
| 4.7 | Database | Schema for storing Mango calls | ✅ (in-memory for now) |

**Transcription Service:**
- Provider: Deepgram (recommended) or OpenAI Whisper
- Cost: ~$0.0043-0.006/minute
- Format: MP3 → JSON transcript with timestamps

**Deliverables:**
- [x] Automated Mango call log import
- [x] Recording download and storage
- [x] Full transcription of staff calls
- [x] Caller name extraction
- [x] Sentiment analysis for staff calls

---

### Phase 3: Unified Dashboard & Callback Queue (Week 5-6) ✅ COMPLETE
**Goal:** Single view for all calls, actionable callback management

#### Week 5: Unified Call View ✅ COMPLETE
| Task | File(s) | Description | Status |
|------|---------|-------------|--------|
| 5.1 | `backend/services/unifiedCallStore.js` | Unified calls storage (in-memory + JSON persist) | ✅ |
| 5.2 | `backend/routes/unifiedCalls.js` | New unified API with source filtering | ✅ |
| 5.3 | `frontend/src/pages/Dashboard.js` | Display both AI and staff calls with badges | ✅ |
| 5.4 | `frontend/src/components/Transcript/ChatBubbleTranscript.js` | iMessage-style transcript UI | ✅ |
| 5.5 | `frontend/src/components/Transcript/AudioSyncPlayer.js` | Click-to-seek audio player | ✅ |
| 5.6 | Filter system | Filter by source (AI/Staff), handler type | ✅ |

#### Week 6: Callback Queue Manager ✅ COMPLETE
| Task | File(s) | Description | Status |
|------|---------|-------------|--------|
| 6.1 | `frontend/src/pages/Callbacks.js` | New callbacks page | ✅ |
| 6.2 | `frontend/src/pages/Callbacks.js` | Priority-sorted queue (built into page) | ✅ |
| 6.3 | `frontend/src/pages/Callbacks.js` | Individual callback card (built into page) | ✅ |
| 6.4 | `backend/routes/callbacks.js` | CRUD for callbacks | ✅ |
| 6.5 | `backend/routes/callbacks.js` | Auto-detection of callback needs | ✅ |
| 6.6 | SLA tracking | Overdue indicators (1hr, 24hr) | ✅ |
| 6.7 | Resolution workflow | Mark complete, add notes | ✅ |

**Callback Priority Order:**
1. 🔴 Emergency (unresolved)
2. 🟠 Failed transfers
3. 🟡 Voicemails
4. 🟢 General callback requests

**Deliverables:**
- [x] Unified call view (AI + Staff in same table)
- [x] Beautiful chat-bubble transcript UI
- [x] Audio player synced with transcript
- [x] Priority callback queue
- [x] SLA monitoring with alerts
- [x] One-click callback initiation

---

### Phase 4: Open Dental Deep Integration (Week 7) ✅ COMPLETE
**Goal:** Sync call data to patient records

| Task | File(s) | Description | Status |
|------|---------|-------------|--------|
| 7.1 | `backend/services/openDentalSync.js` | Enhanced patient matching (phone + name) | ✅ |
| 7.2 | `backend/services/openDentalSync.js` | Push transcript summary to CommLog | ✅ |
| 7.3 | `backend/services/openDentalSync.js` | Create patient if not found (optional) | ⬜ (Skipped - risky to auto-create) |
| 7.4 | `frontend/src/components/OpenDental/PatientLinkDialog.js` | Manual patient linking UI | ✅ |
| 7.5 | `frontend/src/components/OpenDental/PatientCallHistory.js` | Patient call history view | ✅ |
| 7.6 | `frontend/src/components/OpenDental/SyncStatusBadge.js` | Sync status tracking | ✅ |
| 7.7 | `backend/routes/openDentalSync.js` | API endpoints for sync operations | ✅ |
| 7.8 | `frontend/src/pages/CallDetails.js` | Integrated OD sync section | ✅ |

**Open Dental CommLog Format:**
```
═══════════════════════════════════════════════════════
📞 CALL SUMMARY - [Date] [Time]
═══════════════════════════════════════════════════════

Handler: [AI Agent / Staff] (Retell AI / Mango Voice)
Duration: [X:XX]
Caller: [Name] ([Phone])
Outcome: [Resolved/Unresolved/etc]
Sentiment: [positive/neutral/negative]

───────────────────────────────────────────────────────
📝 AI SUMMARY
───────────────────────────────────────────────────────
[Generated summary]

───────────────────────────────────────────────────────
📜 FULL TRANSCRIPT (optional)
───────────────────────────────────────────────────────
[Transcript here]

───────────────────────────────────────────────────────
📊 Metadata
───────────────────────────────────────────────────────
Call ID: [ID]
Source: [Retell AI / Mango Voice]
Is New Patient: [Yes/No]
Emergency: [Yes/No]
═══════════════════════════════════════════════════════
```

**Deliverables:**
- [x] Automatic transcript sync to Open Dental CommLog
- [x] Patient matching with multiple strategies (phone exact, name+phone, fuzzy name)
- [x] Manual patient linking when auto-match fails
- [x] Patient call history view (all calls for a patient)
- [x] Sync status tracking with visual badges
- [x] Batch sync operations

---

### Phase 5: Developer Dashboard (Week 8) ✅ COMPLETE
**Goal:** System health monitoring and admin controls

| Task | File(s) | Description | Status |
|------|---------|-------------|--------|
| 8.1 | `frontend/src/pages/Admin.js` | Admin/developer dashboard page | ✅ |
| 8.2 | `frontend/src/pages/Admin.js` | Connection status indicators (built into page) | ✅ |
| 8.3 | `frontend/src/pages/Admin.js` | Mango sync progress/history (built into page) | ✅ |
| 8.4 | `frontend/src/pages/Admin.js` | Processing queue status (built into page) | ✅ |
| 8.5 | `frontend/src/pages/Admin.js` | Usage and cost monitoring (built into page) | ✅ |
| 8.6 | `frontend/src/pages/Admin.js` | Recent issues and errors (built into page) | ✅ |
| 8.7 | `backend/routes/admin.js` | Admin API endpoints | ✅ |
| 8.8 | Manual controls | Trigger sync, start/stop scheduler | ✅ |

**Health Checks:**
- Retell API: Connected/Disconnected ✅
- Retell Webhook: Receiving events/Silent ✅
- Mango Scraper: Last sync time, next scheduled ✅
- Deepgram: API status ✅
- Open Dental: Connected/Error ✅
- Socket.IO: Active clients ✅

**Deliverables:**
- [x] At-a-glance system health
- [x] Sync history and status
- [x] Processing queue visibility
- [x] Cost/usage tracking
- [x] Error log with details
- [x] Manual admin controls (start/stop scheduler, run now)

---

### Phase 6: AI Quality Assurance (Week 9)
**Goal:** Automated call evaluation and scoring

| Task | File(s) | Description | Status |
|------|---------|-------------|--------|
| 9.1 | `backend/services/qaEvaluator.js` | LLM-based call evaluation | ⬜ |
| 9.2 | `backend/services/qaEvaluator.js` | Configurable evaluation criteria | ⬜ |
| 9.3 | Database | QA scores table | ⬜ |
| 9.4 | `frontend/src/pages/QualityAssurance.js` | QA dashboard page | ⬜ |
| 9.5 | `frontend/src/components/QA/QAScoreCard.js` | Score display for individual call | ⬜ |
| 9.6 | `frontend/src/components/QA/QATrends.js` | Score trends over time | ⬜ |
| 9.7 | `frontend/src/components/QA/HandlerPerformance.js` | Performance by agent/staff | ⬜ |
| 9.8 | `frontend/src/components/QA/IssuesList.js` | Flagged calls needing review | ⬜ |

**QA Evaluation Criteria:**
| Metric | Weight | Description |
|--------|--------|-------------|
| Greeting Quality | 10% | Professional, warm greeting |
| Issue Understanding | 20% | Correctly identified caller need |
| Resolution | 25% | Was issue resolved? |
| Customer Sentiment | 20% | Caller satisfaction |
| Professionalism | 15% | Appropriate language/tone |
| Compliance | 10% | No HIPAA or policy violations |

**LLM Prompt Template:**
```
Evaluate this dental office call transcript and score on these criteria:
1. Greeting (1-10): Was the greeting professional and warm?
2. Understanding (1-10): Did the handler correctly understand the issue?
3. Resolution (Yes/Partial/No): Was the caller's issue resolved?
4. Sentiment (Positive/Neutral/Negative): How did the caller feel?
5. Professionalism (1-10): Was the language and tone appropriate?
6. Compliance Issues: Any HIPAA violations or policy concerns?
7. Summary: Brief description of call quality issues, if any.

Transcript:
[TRANSCRIPT]
```

**Deliverables:**
- [ ] Automated call scoring
- [ ] Overall QA score dashboard
- [ ] Performance by handler (AI vs staff, individual staff)
- [ ] Trend charts over time
- [ ] Flagged calls for review
- [ ] Improvement recommendations

---

### Phase 7: Analytics Dashboard (Week 10)
**Goal:** Deep insights into call patterns and business impact

| Task | File(s) | Description | Status |
|------|---------|-------------|--------|
| 10.1 | `frontend/src/pages/Analytics.js` | Enhanced analytics page | ⬜ |
| 10.2 | Call volume analytics | By hour, day, week, month | ⬜ |
| 10.3 | Handler comparison | AI vs Staff performance | ⬜ |
| 10.4 | Call reason breakdown | What are people calling about? | ⬜ |
| 10.5 | Resolution metrics | First-call resolution rate | ⬜ |
| 10.6 | Cost/ROI analysis | Value of AI calls, time saved | ⬜ |
| 10.7 | Export functionality | CSV, PDF reports | ⬜ |
| 10.8 | Scheduled reports | Email daily/weekly digest | ⬜ |

**Key Metrics:**
- Total calls (AI vs Staff split)
- Average handle time
- Resolution rate
- Sentiment distribution
- Peak call times
- Transfer success rate
- Callback completion rate
- Appointments booked via AI

---

### Phase 8: Notifications & Integrations (Week 11)
**Goal:** Proactive alerts and external integrations

| Task | File(s) | Description | Status |
|------|---------|-------------|--------|
| 11.1 | `backend/services/notificationService.js` | Core notification engine | ⬜ |
| 11.2 | `frontend/src/components/common/NotificationBell.js` | In-app notification center | ⬜ |
| 11.3 | Browser push | Web push notifications | ⬜ |
| 11.4 | Email integration | SendGrid/SES for email alerts | ⬜ |
| 11.5 | Slack integration | Webhook to Slack channels | ⬜ |
| 11.6 | Custom alert rules | "Notify when X happens" | ⬜ |
| 11.7 | Quiet hours | Respect off-hours | ⬜ |

**Alert Types:**
- 🔴 Emergency call detected
- 🟠 Callback overdue (>1hr, >24hr)
- 🟡 Low QA score detected
- 🟡 Mango sync failed
- 🟢 Daily summary ready

---

### Phase 9: UI/UX Polish (Week 12)
**Goal:** Professional, modern interface

| Task | File(s) | Description | Status |
|------|---------|-------------|--------|
| 12.1 | `frontend/src/components/common/CommandPalette.js` | ⌘+K quick actions | ⬜ |
| 12.2 | Dark mode polish | Better colors, consistency | ⬜ |
| 12.3 | Mobile responsive | Tablet/phone optimization | ⬜ |
| 12.4 | Keyboard shortcuts | Navigate without mouse | ⬜ |
| 12.5 | Loading states | Skeleton loaders, animations | ⬜ |
| 12.6 | Accessibility | ARIA, color contrast | ⬜ |
| 12.7 | Office branding | Custom colors/logo option | ⬜ |
| 12.8 | Onboarding | First-use tour/guide | ⬜ |

---

## 🗄️ Database Schema

### New Tables Needed

```sql
-- Unified calls table (augments existing)
CREATE TABLE calls (
  id UUID PRIMARY KEY,
  source ENUM('retell', 'mango') NOT NULL,
  external_id VARCHAR(255), -- Retell call_id or Mango reference
  
  -- Call metadata
  call_date TIMESTAMP NOT NULL,
  duration_seconds INTEGER,
  caller_number VARCHAR(50),
  caller_name VARCHAR(255),
  
  -- Handler info
  handler_type ENUM('ai', 'staff') NOT NULL,
  handler_id VARCHAR(255), -- Agent ID or staff extension
  handler_name VARCHAR(255),
  
  -- Call details
  outcome ENUM('resolved', 'unresolved', 'transferred', 'voicemail'),
  call_reason VARCHAR(255),
  is_emergency BOOLEAN DEFAULT FALSE,
  sentiment ENUM('positive', 'neutral', 'negative'),
  
  -- Transfer tracking
  transfer_attempted BOOLEAN DEFAULT FALSE,
  transfer_status ENUM('successful', 'failed', 'voicemail'),
  transfer_destination VARCHAR(255),
  
  -- Content
  summary TEXT,
  transcript TEXT,
  transcript_json JSONB, -- Structured transcript with timestamps
  recording_url VARCHAR(500),
  recording_path VARCHAR(500), -- Local storage path
  
  -- Open Dental integration
  patient_id INTEGER, -- Open Dental PatNum
  patient_matched_by ENUM('phone', 'name', 'manual'),
  od_sync_status ENUM('pending', 'synced', 'failed', 'skipped'),
  od_commlog_id INTEGER,
  
  -- QA
  qa_score INTEGER, -- 0-100
  qa_evaluated_at TIMESTAMP,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Callbacks tracking
CREATE TABLE callbacks (
  id UUID PRIMARY KEY,
  call_id UUID REFERENCES calls(id),
  
  priority ENUM('emergency', 'high', 'medium', 'low') NOT NULL,
  reason TEXT,
  
  status ENUM('pending', 'attempted', 'completed', 'failed') DEFAULT 'pending',
  due_at TIMESTAMP,
  assigned_to VARCHAR(255),
  
  attempts INTEGER DEFAULT 0,
  last_attempt_at TIMESTAMP,
  resolution_notes TEXT,
  completed_at TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- QA Scores (detailed)
CREATE TABLE qa_scores (
  id UUID PRIMARY KEY,
  call_id UUID REFERENCES calls(id),
  
  overall_score INTEGER, -- 0-100
  
  -- Individual metrics
  greeting_score INTEGER,
  understanding_score INTEGER,
  resolution_score INTEGER,
  sentiment_score INTEGER,
  professionalism_score INTEGER,
  compliance_passed BOOLEAN,
  
  -- AI evaluation
  evaluation_model VARCHAR(50), -- gpt-4, claude, etc
  evaluation_raw JSONB, -- Full LLM response
  issues_detected TEXT[],
  recommendations TEXT,
  
  flagged_for_review BOOLEAN DEFAULT FALSE,
  reviewed_by VARCHAR(255),
  reviewed_at TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT NOW()
);

-- Sync logs (for admin dashboard)
CREATE TABLE sync_logs (
  id UUID PRIMARY KEY,
  source ENUM('mango', 'retell', 'opendental') NOT NULL,
  
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  status ENUM('running', 'completed', 'failed') NOT NULL,
  
  calls_found INTEGER,
  calls_imported INTEGER,
  calls_transcribed INTEGER,
  calls_failed INTEGER,
  
  error_message TEXT,
  details JSONB,
  
  created_at TIMESTAMP DEFAULT NOW()
);

-- System health snapshots
CREATE TABLE system_health (
  id UUID PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  
  retell_connected BOOLEAN,
  retell_last_webhook TIMESTAMP,
  
  mango_connected BOOLEAN,
  mango_last_sync TIMESTAMP,
  
  deepgram_connected BOOLEAN,
  deepgram_quota_remaining INTEGER,
  
  opendental_connected BOOLEAN,
  opendental_last_sync TIMESTAMP,
  
  queue_transcription INTEGER,
  queue_qa_evaluation INTEGER,
  queue_od_sync INTEGER
);
```

---

## 📁 File Structure (New Files)

```
backend/
├── config/
│   ├── mango.js                    # Mango Voice credentials
│   └── deepgram.js                 # Deepgram API config
├── services/
│   ├── liveCallManager.js          # Active call state management
│   ├── mangoScraper.js             # Puppeteer-based Mango scraper
│   ├── syncScheduler.js            # Scheduled sync jobs
│   ├── transcriptionService.js     # Deepgram integration
│   ├── callAnalyzer.js             # Name extraction, sentiment
│   ├── qaEvaluator.js              # LLM-based QA scoring
│   ├── callbackService.js          # Callback management
│   ├── notificationService.js      # Alerts and notifications
│   └── openDentalSync.js           # Enhanced OD integration
├── routes/
│   ├── webhooks.js                 # POST /api/webhooks/retell
│   ├── liveCalls.js                # GET /api/live-calls
│   ├── callbacks.js                # Callback CRUD
│   ├── qa.js                       # QA scores and analytics
│   ├── admin.js                    # Admin endpoints
│   └── notifications.js            # Notification endpoints
├── socket/
│   └── socketHandler.js            # Socket.IO event handlers
├── jobs/
│   ├── mangoSync.js                # Mango sync job
│   ├── transcriptionWorker.js      # Process transcription queue
│   └── qaWorker.js                 # Process QA evaluation queue
└── migrations/
    └── [timestamp]_add_v2_tables.js

frontend/src/
├── contexts/
│   └── SocketContext.js            # WebSocket provider
├── hooks/
│   ├── useLiveCalls.js             # Live call state hook
│   ├── useNotifications.js         # Notifications hook
│   └── useKeyboardShortcuts.js     # Keyboard navigation
├── pages/
│   ├── LiveMonitor.js              # Real-time call view
│   ├── Callbacks.js                # Callback queue page
│   ├── QualityAssurance.js         # QA dashboard
│   └── Admin.js                    # Developer dashboard
├── components/
│   ├── LiveCalls/
│   │   ├── LiveCallsDashboard.js
│   │   ├── LiveCallCard.js
│   │   ├── LiveTranscript.js
│   │   └── SentimentGauge.js
│   ├── Transcript/
│   │   ├── ChatBubbleTranscript.js
│   │   ├── TranscriptSearch.js
│   │   └── AudioSyncPlayer.js
│   ├── Callbacks/
│   │   ├── CallbackQueue.js
│   │   └── CallbackCard.js
│   ├── QA/
│   │   ├── QAScoreCard.js
│   │   ├── QATrends.js
│   │   ├── HandlerPerformance.js
│   │   └── IssuesList.js
│   ├── Admin/
│   │   ├── SystemHealth.js
│   │   ├── SyncStatus.js
│   │   ├── ProcessingQueues.js
│   │   ├── CostTracker.js
│   │   └── ErrorLog.js
│   ├── common/
│   │   ├── CommandPalette.js       # ⌘+K modal
│   │   └── NotificationBell.js     # Notification dropdown
│   └── Notifications/
│       └── NotificationSettings.js
└── services/
    └── socket.js                   # Socket.IO client
```

---

## 🔌 API Endpoints (New)

### Webhooks
```
POST /api/webhooks/retell          # Receive Retell events
```

### Live Calls
```
GET  /api/live-calls               # Get all active calls
GET  /api/live-calls/:id           # Get specific active call
```

### Callbacks
```
GET  /api/callbacks                # List all callbacks
GET  /api/callbacks/:id            # Get specific callback
POST /api/callbacks                # Create callback
PATCH /api/callbacks/:id           # Update callback (status, notes)
POST /api/callbacks/:id/attempt    # Log callback attempt
```

### QA & Analytics
```
GET  /api/qa/scores                # Get QA scores (filterable)
GET  /api/qa/scores/:callId        # Get QA score for call
POST /api/qa/evaluate/:callId      # Trigger manual QA evaluation
GET  /api/qa/trends                # QA score trends over time
GET  /api/qa/handlers              # Performance by handler
GET  /api/qa/issues                # Flagged calls needing review
```

### Admin
```
GET  /api/admin/health             # System health status
GET  /api/admin/sync-logs          # Sync history
POST /api/admin/sync/mango         # Trigger manual Mango sync
GET  /api/admin/queues             # Processing queue status
GET  /api/admin/costs              # Usage and cost data
GET  /api/admin/errors             # Recent errors
POST /api/admin/test-connection    # Test external service
```

### Notifications
```
GET  /api/notifications            # Get user notifications
PATCH /api/notifications/:id/read  # Mark as read
GET  /api/notifications/settings   # Get notification preferences
PUT  /api/notifications/settings   # Update preferences
```

---

## ⚙️ Environment Variables (New)

```bash
# Mango Voice (for scraping)
MANGO_PORTAL_URL=https://portal.mangovoice.com
MANGO_USERNAME=your_username
MANGO_PASSWORD=your_password

# Deepgram (transcription)
DEEPGRAM_API_KEY=your_deepgram_key

# OpenAI/Claude (QA evaluation)
OPENAI_API_KEY=your_openai_key
# or
ANTHROPIC_API_KEY=your_claude_key

# Notifications
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
SENDGRID_API_KEY=your_sendgrid_key
NOTIFICATION_EMAIL_FROM=alerts@yourdomain.com

# Sync settings
MANGO_SYNC_INTERVAL_MINUTES=60
QA_EVALUATION_ENABLED=true
QA_EVALUATION_MODEL=gpt-3.5-turbo
```

---

## 📊 Success Metrics

### Phase 1-2 (Live Monitoring)
- [ ] Live calls visible within 1 second of start
- [ ] Transcript updates appear in real-time
- [ ] Zero missed webhook events

### Phase 3-4 (Mango Integration)
- [ ] 100% of Mango calls imported
- [ ] 95%+ transcription accuracy
- [ ] <2 hour delay from call end to transcript available

### Phase 5-6 (Unified + Callbacks)
- [ ] Single dashboard shows all calls
- [ ] Callback SLA tracking accurate
- [ ] Zero callbacks "lost" in the system

### Phase 7 (Open Dental)
- [ ] 90%+ calls auto-matched to patient
- [ ] Transcripts synced within 1 hour
- [ ] Zero data loss during sync

### Phase 8-9 (QA + Analytics)
- [ ] 100% of calls evaluated
- [ ] QA trends accurately reflect reality
- [ ] Staff can identify improvement areas

---

## 🚨 Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Mango changes portal UI | Build flexible selectors, monitor for changes |
| Mango rate-limits scraping | Respect delays, randomize intervals |
| Deepgram quota exceeded | Monitor usage, set alerts at 80% |
| Open Dental API issues | Queue and retry, alert on failures |
| LLM costs spike | Use cheaper model (GPT-3.5), sample calls |

---

## 📝 Notes for Future Agents

1. **Always check this document first** before making changes
2. **Update task status** as work progresses (⬜ → 🟡 → ✅)
3. **Maintain backwards compatibility** - existing features should keep working
4. **Test thoroughly** before marking complete
5. **Document any deviations** from this plan in a CHANGELOG
6. **Ask user to clarify** if requirements are unclear

---

## 🔄 Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-12 | Initial specification created |
| 1.1 | 2026-01-12 | Phase 1 (Live Monitoring) completed |
| 1.2 | 2026-01-12 | Phase 2 (Mango Integration + Transcription) completed |
| 1.3 | 2026-01-12 | Phase 3 partial (Callbacks) completed |
| 1.4 | 2026-01-12 | Phase 5 (Developer Dashboard) completed |
| 1.5 | 2026-01-13 | Phase 3 (Unified Dashboard) fully completed - added unified call store, source filtering, chat-bubble transcripts, audio sync player |
| 1.6 | 2026-01-13 | Phase 4 (Open Dental Deep Integration) completed - CommLog sync, patient matching, manual linking UI, call history, sync status tracking |
| 1.7 | 2026-01-13 | All integrations verified - Fixed Mango portal URL (admin.mangovoice.com), CSS selectors, and SSL handling. All 6 services now connected. |

---

## 📊 Overall Progress: ~65% Complete

| Phase | Status |
|-------|--------|
| Phase 1: Retell Live Monitoring | ✅ Complete |
| Phase 2: Mango Voice Integration | ✅ Complete |
| Phase 3: Unified Dashboard & Callbacks | ✅ Complete |
| Phase 4: Open Dental Deep Integration | ✅ Complete |
| Phase 5: Developer Dashboard | ✅ Complete |
| Phase 6: AI Quality Assurance | ⬜ Not Started |
| Phase 7: Analytics Dashboard | ⬜ Not Started |
| Phase 8: Notifications & Integrations | ⬜ Not Started |
| Phase 9: UI/UX Polish | ⬜ Not Started |

---

*Last updated: January 12, 2026*

