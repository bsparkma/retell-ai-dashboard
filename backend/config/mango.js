/**
 * Mango Voice Configuration
 * 
 * Configuration for scraping call logs and recordings from Mango Voice portal.
 * 
 * SETUP:
 * 1. Set environment variables for credentials
 * 2. Update the portal URL if different
 * 3. Adjust selectors if portal UI changes
 */

const normalizeMangoUrl = (url, fallback) => {
  if (!url) return fallback;
  try {
    const u = new URL(url);
    // Some older configs used portal.mangovoice.com which can be unconfigured/404.
    // Prefer admin.mangovoice.com unless user explicitly overrides to something else valid.
    if (u.hostname === 'portal.mangovoice.com') {
      return fallback;
    }
    return url;
  } catch {
    return fallback;
  }
};

// The classic admin.mangovoice.com/user/login is deprecated (now a "use the web app" notice);
// the live login is the app.mangovoice.com Chakra SPA. (Confirmed empirically 2026-07-22.)
const FALLBACK_BASE = 'https://app.mangovoice.com';
const FALLBACK_LOGIN_URL = 'https://app.mangovoice.com/login/';
const FALLBACK_CALLS_URL = 'https://app.mangovoice.com/calls/?date_range=last_14_days';

module.exports = {
  // Portal configuration (used for the Puppeteer login that harvests the API Bearer token)
  portal: {
    baseUrl: normalizeMangoUrl(process.env.MANGO_PORTAL_URL, FALLBACK_BASE),
    loginUrl: normalizeMangoUrl(process.env.MANGO_LOGIN_URL, FALLBACK_LOGIN_URL),
    // Legacy scraper field; unused on the API ingest path.
    callLogUrl: normalizeMangoUrl(process.env.MANGO_CALLLOG_URL, FALLBACK_CALLS_URL),
  },

  // Internal REST API (api.mangovoice.com). Bearer-authenticated; the token is harvested
  // from the SPA login session (see services/mangoApiClient.js). Base is overridable for
  // the eventual documented Global-API swap.
  api: {
    baseUrl: (process.env.MANGO_API_URL || 'https://api.mangovoice.com').replace(/\/+$/, ''),
  },

  // Ingestion source (PRD). 'off' (default): no Mango ingestion. 'api': pull calls from the
  // internal REST API. The former DOM 'scraper' mode is retired in favor of 'api'.
  ingestMode: process.env.MANGO_INGEST_MODE === 'api' ? 'api' : 'off',

  // Authentication
  auth: {
    username: process.env.MANGO_USERNAME || '',
    password: process.env.MANGO_PASSWORD || '',
  },

  // PBX Selection (for accounts with multiple PBXes)
  // Set MANGO_PBX_NAME to the name shown in the "Select your PBX" screen
  // e.g. "Roland Family Dental & Braces"
  // If not set, the first PBX in the list will be selected
  pbx: {
    name: process.env.MANGO_PBX_NAME || '',
  },

  // Scraper settings
  scraper: {
    // Headless browser mode (set to false for debugging)
    headless: process.env.MANGO_HEADLESS !== 'false',
    
    // Timeouts (ms)
    navigationTimeout: 60000,
    waitTimeout: 30000,
    
    // Rate limiting
    delayBetweenPages: 2000, // 2 seconds between page loads
    delayBetweenDownloads: 1000, // 1 second between recording downloads
    
    // Retry settings
    maxRetries: 3,
    retryDelay: 5000,
  },

  // Sync settings
  sync: {
    // How often to sync (cron expression)
    // Default: Every hour at minute 15
    schedule: process.env.MANGO_SYNC_SCHEDULE || '15 * * * *',
    
    // How many days back to look for calls on first sync
    initialLookbackDays: 7,
    
    // How many days back to look on regular syncs
    regularLookbackDays: 1,
    
    // Maximum calls to process per sync
    maxCallsPerSync: 100,
    
    // Whether to download recordings
    downloadRecordings: true,

    // Safety cap to avoid pulling hundreds of MP3s in one run
    maxRecordingsPerSync: parseInt(process.env.MANGO_MAX_RECORDINGS_PER_SYNC || '10', 10),
    
    // Recording storage path
    recordingsPath: process.env.MANGO_RECORDINGS_PATH || './recordings/mango',
  },

  // Worklist behaviour (PRD D1). 'all' (default): every Mango staff call enters the
  // "Needs attention" view like a Retell call. 'flagged': only Mango calls that are an
  // emergency / requested an appointment / need a callback demand attention; the rest
  // stay visible in "All calls" and are sendable, but drop out of the attention count
  // and default view. Flip = env change, not a rebuild.
  worklistMode: process.env.MANGO_WORKLIST_MODE === 'flagged' ? 'flagged' : 'all',
  summaryMinSeconds: parseInt(process.env.MANGO_SUMMARY_MIN_SECONDS || '20', 10),

  // CSS Selectors for the Mango portal (admin.mangovoice.com)
  // Update these if the portal UI changes
  selectors: {
    // Login page - based on admin.mangovoice.com/user/login
    // Supports both:
    // - admin.mangovoice.com (classic)
    // - app.mangovoice.com (Chakra UI login)
    usernameInput: 'input#username-input, input[name="username"], input[name="email"], input[type="email"], input[type="text"]',
    passwordInput: 'input#password-input, input[name="password"], input[type="password"]',
    // app.mangovoice.com uses a button[type="button"].chakra-button with "Log In" text
    loginButton: 'button.chakra-button, button[type="submit"], button[type="button"], input[type="submit"], .btn-primary, .btn-login, button.btn',
    
    // Call log page
    // Try to match both classic tables and SPA data grids
    callLogTable: 'table, [role="table"], .call-log-table, .calls-table, .call-logs, .call-history, .cdr, .cdrs, .ReactTable, .MuiDataGrid-root, .ag-root',
    callLogRow: 'tbody tr, .call-row, [role="row"]',
    // Table columns (fallback to cell-index parsing if these don't match)
    dateColumn: 'td:nth-child(1), .call-date, [data-col="date"], [data-field="date"]',
    timeColumn: 'td:nth-child(2), .call-time, [data-col="time"], [data-field="time"]',
    fromColumn: 'td:nth-child(3), .call-from, [data-col="from"], [data-field="from"]',
    toColumn: 'td:nth-child(4), .call-to, [data-col="to"], [data-field="to"]',
    durationColumn: 'td:nth-child(5), .call-duration, [data-col="duration"], [data-field="duration"]',
    outcomeColumn: 'td:nth-child(6), .call-outcome, [data-col="outcome"], [data-field="outcome"]',
    
    // Recording download
    recordingLink: 'a[href*="recording"], a[href*="recordings"], a[href*="mp3"], .download-recording, .play-recording, button[aria-label*="Play"], button[aria-label*="Download"]',
    // app.mangovoice.com call details
    appCallLink: 'a[href^="/calls/"], a[href*="/calls/"]',
    appKebabButton: 'button[aria-haspopup="menu"], button[aria-label*="More"], button[aria-label*="more"], button[aria-label*="options"], button[aria-label*="Options"], button.chakra-menu__menu-button',
    appMenuItem: '[role="menuitem"], button[role="menuitem"], .chakra-menu__menuitem, li[role="menuitem"]',
    
    // Pagination
    nextPageButton: '.pagination .next, button[aria-label="Next"], .next-page',
    dateRangePicker: '.date-range, input[type="date"]',
  },

  // Call outcome mapping
  // Maps Mango outcome text to our standardized outcomes
  outcomeMapping: {
    'answered': 'answered',
    'missed': 'missed',
    'voicemail': 'voicemail',
    'busy': 'missed',
    'no answer': 'missed',
    'failed': 'failed',
    'inbound': 'answered',
    'outbound': 'answered',
  },
};

