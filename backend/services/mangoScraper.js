/**
 * Mango Voice Scraper Service
 * 
 * Scrapes call logs and downloads recordings from the Mango Voice portal.
 * Uses Puppeteer for browser automation.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs').promises;
const fssync = require('fs');
const config = require('../config/mango');

class MangoScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isLoggedIn = false;
    this.lastSyncTime = null;
    this.landingUrl = null; // last known post-login landing URL (often includes account-specific path)
  }

  /**
   * Initialize the browser instance
   */
  async initialize() {
    if (this.browser) {
      return;
    }

    console.log('🔧 Initializing Mango scraper browser...');
    
    this.browser = await puppeteer.launch({
      headless: config.scraper.headless ? 'new' : false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
      ],
      ignoreHTTPSErrors: true,
      defaultViewport: {
        width: 1920,
        height: 1080,
      },
    });

    this.page = await this.browser.newPage();
    
    // Set longer timeouts
    this.page.setDefaultNavigationTimeout(config.scraper.navigationTimeout);
    this.page.setDefaultTimeout(config.scraper.waitTimeout);

    // Handle downloads
    const downloadPath = path.resolve(config.sync.recordingsPath);
    await fs.mkdir(downloadPath, { recursive: true });
    
    const client = await this.page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadPath,
    });

    console.log('✅ Mango scraper browser initialized');
  }

  /**
   * Login to Mango portal
   */
  async login() {
    if (this.isLoggedIn) {
      console.log('📋 Already logged in to Mango portal');
      return true;
    }

    if (!config.auth.username || !config.auth.password) {
      throw new Error('Mango credentials not configured. Set MANGO_USERNAME and MANGO_PASSWORD environment variables.');
    }

    console.log('🔐 Logging in to Mango portal...');

    try {
      await this.initialize();
      
      // Navigate to login page
      await this.page.goto(config.portal.loginUrl, { waitUntil: 'networkidle2' });
      
      // Wait for login form
      await this.page.waitForSelector(config.selectors.usernameInput);
      
      // Clear and fill username
      await this.page.click(config.selectors.usernameInput, { clickCount: 3 });
      await this.page.type(config.selectors.usernameInput, config.auth.username);
      
      // Clear and fill password
      await this.page.click(config.selectors.passwordInput, { clickCount: 3 });
      await this.page.type(config.selectors.passwordInput, config.auth.password);
      
      // Click login button
      await this.clickLoginButton();
      
      // Wait for navigation after login
      await this.page.waitForNavigation({ waitUntil: 'networkidle2' });
      
      // Verify login success (should not be on login page anymore)
      const currentUrl = this.page.url();
      if (currentUrl.includes('login')) {
        throw new Error('Login failed - still on login page');
      }
      
      this.isLoggedIn = true;
      this.landingUrl = currentUrl;
      console.log('✅ Successfully logged in to Mango portal');
      return true;

    } catch (error) {
      console.error('❌ Mango login failed:', error.message);
      this.isLoggedIn = false;
      throw error;
    }
  }

  /**
   * If the current page looks like a login page, attempt to log in without navigating.
   * This helps when Mango redirects you back to login on certain subdomains/paths.
   */
  async loginOnCurrentPageIfNeeded() {
    try {
      const hasUser = await this.page.$(config.selectors.usernameInput);
      const hasPass = await this.page.$(config.selectors.passwordInput);
      const hasBtn = await this.page.$(config.selectors.loginButton);
      if (!hasUser || !hasPass || !hasBtn) return false;

      console.log('🔐 Detected login form on current page; attempting login...');

      await this.page.click(config.selectors.usernameInput, { clickCount: 3 });
      await this.page.type(config.selectors.usernameInput, config.auth.username);

      await this.page.click(config.selectors.passwordInput, { clickCount: 3 });
      await this.page.type(config.selectors.passwordInput, config.auth.password);

      // Wait for the login button to become enabled/clickable (app.mangovoice.com uses aria-disabled)
      try {
        await this.page.waitForFunction(
          (btnSel) => {
            const btn = document.querySelector(btnSel);
            if (!btn) return false;
            const ariaDisabled = btn.getAttribute('aria-disabled');
            // Some buttons use disabled attribute, others use aria-disabled
            const disabled = btn.disabled === true || ariaDisabled === 'true';
            return !disabled;
          },
          { timeout: 10000 },
          config.selectors.loginButton
        );
      } catch (e) {
        // best-effort; we'll still try clicking
      }

      await this.clickLoginButton();
      await this.page.waitForNavigation({ waitUntil: 'networkidle2' });

      const currentUrl = this.page.url();
      if (currentUrl.includes('login')) {
        console.log('⚠️ Still on login page after attempted login.');
        return false;
      }

      this.isLoggedIn = true;
      this.landingUrl = currentUrl;
      console.log('✅ Login successful on current page');
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Click the most likely "Log In" button on the page.
   * Some Mango pages use button[type="button"] and not submit; some buttons can be disabled via aria-disabled.
   */
  async clickLoginButton() {
    // Fast path for classic login forms
    const submitInput = await this.page.$('input[type="submit"]');
    if (submitInput) {
      await submitInput.evaluate(el => el.click());
      return true;
    }
    const submitButton = await this.page.$('button[type="submit"]');
    if (submitButton) {
      await submitButton.evaluate(el => el.click());
      return true;
    }

    // Wait for an enabled "Log In" / "Login" button to exist (app.mangovoice.com uses aria-disabled)
    try {
      await this.page.waitForFunction(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        return btns.some((b) => {
          const txt = (b.innerText || '').trim();
          if (!/log\s*in|login/i.test(txt)) return false;
          const ariaDisabled = b.getAttribute('aria-disabled');
          const disabled = b.disabled === true || ariaDisabled === 'true';
          return !disabled;
        });
      }, { timeout: 10000 });

      const buttons = await this.page.$$('button');
      for (const btn of buttons) {
        const ok = await this.page.evaluate((el) => {
          const txt = (el.innerText || '').trim();
          if (!/log\s*in|login/i.test(txt)) return false;
          const ariaDisabled = el.getAttribute('aria-disabled');
          const disabled = el.disabled === true || ariaDisabled === 'true';
          return !disabled;
        }, btn);
        if (!ok) continue;

        // Scroll into view and click via DOM to avoid "not clickable" issues from overlays/layout
        await btn.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
        await btn.evaluate(el => el.click());
        return true;
      }
    } catch (e) {
      // fall through
    }

    // Fallback to selector click
    try {
      await this.page.click(config.selectors.loginButton);
      return true;
    } catch (e) {
      await this.captureDebugArtifacts('login-click-failed');
      throw e;
    }
    return true;
  }

  /**
   * Scrape call logs from the portal
   * @param {Object} options - Scraping options
   * @param {Date} options.startDate - Start date for call logs
   * @param {Date} options.endDate - End date for call logs
   * @param {number} options.maxCalls - Maximum calls to fetch
   */
  async scrapeCallLogs(options = {}) {
    const {
      startDate = new Date(Date.now() - 24 * 60 * 60 * 1000), // Default: last 24 hours
      endDate = new Date(),
      maxCalls = config.sync.maxCallsPerSync,
    } = options;

    console.log(`📞 Scraping call logs from ${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}...`);

    try {
      await this.login();

      // Capture JSON API responses while the calls page loads (best way to get Mango call IDs)
      const jsonTexts = [];
      const onResponse = async (res) => {
        try {
          const ct = (res.headers()['content-type'] || '').toLowerCase();
          if (!ct.includes('application/json')) return;
          const url = res.url();
          if (!/mangovoice\.com/i.test(url)) return;
          const text = await res.text();
          if (text && text.length < 8_000_000) jsonTexts.push(text);
        } catch (e) {}
      };
      this.page.on('response', onResponse);
      
      // Prefer configured call log URL (if set), but fall back to discovering it from the portal UI.
      let navigated = false;

      // 1) Try configured URL first
      if (config.portal.callLogUrl) {
        await this.page.goto(config.portal.callLogUrl, { waitUntil: 'networkidle2' });
        // Give SPA pages (like app.mangovoice.com) a moment to render after network settles
        await this.delay(2000);
        const is404 = await this.page.evaluate(() => {
          const title = (document.title || '').toLowerCase();
          const body = (document.body?.innerText || '').toLowerCase();
          return title.includes('404') || body.includes('404 page not found') || body.includes('page not found');
        });
        if (!is404) {
          navigated = true;
        } else {
          console.log(`⚠️ Configured callLogUrl returned 404: ${config.portal.callLogUrl}`);
        }
      }

      // 2) If configured URL isn't usable, try to discover Call Logs link from the post-login landing page first
      if (!navigated) {
        // Ensure we're on a page that actually has navigation links (root may redirect to login)
        if (this.landingUrl && this.page.url() !== this.landingUrl) {
          await this.page.goto(this.landingUrl, { waitUntil: 'networkidle2' });
        }

        let discoveredUrl = await this.discoverCallLogsUrl();

        // If not found, try base URL (some accounts render nav links there)
        if (!discoveredUrl) {
          await this.page.goto(config.portal.baseUrl, { waitUntil: 'networkidle2' });
          discoveredUrl = await this.discoverCallLogsUrl();
        }

        if (discoveredUrl) {
          console.log(`➡️ Navigating to discovered Call Logs URL: ${discoveredUrl}`);
          await this.page.goto(discoveredUrl, { waitUntil: 'networkidle2' });
          navigated = true;
        }
      }

      // If we got redirected to login during navigation attempts, try logging in again in-place.
      if (this.page.url().includes('login')) {
        await this.loginOnCurrentPageIfNeeded();
      }

      // app.mangovoice.com may require selecting a PBX (location) before allowing /calls
      if (this.page.url().includes('select-pbx')) {
        await this.selectFirstPbxIfNeeded();
      }

      // Wait until the Calls UI renders. Mango's app UI is often a div-grid (not a <table>),
      // so prefer a content-based signal over brittle selectors.
      try {
        await this.page.waitForFunction(() => {
          const text = document.body?.innerText || '';
          // Common pattern in the Calls list: time like "2:59 PM" and date like "01/14/26"
          return /\b\d{1,2}:\d{2}\s*(AM|PM)\b/.test(text) && /\b\d{2}\/\d{2}\/\d{2}\b/.test(text);
        }, { timeout: config.scraper.waitTimeout });
      } catch (e) {
        await this.captureDebugArtifacts('call-logs-not-found');
        this.page.off('response', onResponse);
        throw e;
      }

      // Stop capturing
      this.page.off('response', onResponse);

      // Preferred: click rows to extract the *real* Mango call IDs (URLs like /calls/4637427643)
      const clickedCalls = await this.extractCallsByClickingRows(Math.min(maxCalls, 25));
      if (clickedCalls.length > 0) {
        console.log(`✅ Extracted ${clickedCalls.length} call IDs by clicking rows`);
        return clickedCalls;
      }
      
      // Set date range if date picker exists
      try {
        const datePicker = await this.page.$(config.selectors.dateRangePicker);
        if (datePicker) {
          // Try to set date range (this may need adjustment based on portal UI)
          console.log('📅 Setting date range filter...');
        }
      } catch (e) {
        console.log('⚠️ Date picker not found, scraping current view');
      }
      
      // Scrape calls from table
      const calls = await this.extractCallsFromTable();
      
      console.log(`✅ Scraped ${calls.length} calls from Mango portal`);
      return calls;

    } catch (error) {
      console.error('❌ Failed to scrape call logs:', error.message);
      throw error;
    }
  }

  /**
   * On app.mangovoice.com/calls, selecting a row updates the URL to /calls/<id> and opens the details panel.
   * This method clicks the first N rows and records the resulting call IDs (most reliable way to get recordings).
   */
  async extractCallsByClickingRows(maxRows = 10) {
    try {
      const candidates = await this.page.evaluate((selectors, maxRows) => {
        // Try a few strategies to find call rows in the app UI
        let rows = Array.from(document.querySelectorAll(selectors.callLogRow));
        if (!rows || rows.length < 5) {
          rows = Array.from(document.querySelectorAll('[role="row"], tr, .MuiDataGrid-row, .ag-row, .call-row'));
        }

        const out = [];

        const isTime = (s) => /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test((s || '').trim());
        const isDate = (s) => /^\d{2}\/\d{2}\/\d{2}$/.test((s || '').trim());
        const isDuration = (s) => /^(\d{1,2}:)?\d{1,2}:\d{2}$/.test((s || '').trim());
        const isPhone = (s) => /\(\d{3}\)\s*\d{3}-\d{4}/.test(s || '') || /^\+?\d[\d\-\s\(\)]{7,}$/.test(s || '');
        const outcomeCandidates = ['Answered', 'Missed', 'Voicemail', 'In Progress', 'Failed', 'Busy', 'No Answer'];

        const parseRowText = (row) => {
          const text = (row.innerText || '').toString();
          const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
          const time = lines.find(isTime) || '';
          const date = lines.find(isDate) || '';
          const duration = [...lines].reverse().find(isDuration) || '';
          const phones = lines.filter(isPhone);
          const fromPhone = phones[0] || '';
          const toPhone = phones[1] || '';
          const outcome = lines.find(x => outcomeCandidates.some(o => x.toLowerCase() === o.toLowerCase())) || '';
          return { date, time, from_number: fromPhone, to_number: toPhone, duration_text: duration, outcome_text: outcome };
        };

        const looksLikeCallRow = (row) => {
          const text = (row.innerText || '').toString();
          // Require a time + date pattern (matches the calls list rows)
          return /\b\d{1,2}:\d{2}\s*(AM|PM)\b/.test(text) && /\b\d{2}\/\d{2}\/\d{2}\b/.test(text);
        };

        const pushCandidate = (row) => {
          if (out.length >= maxRows) return;
          const r = row.getBoundingClientRect();
          if (r.width < 300 || r.height < 24 || r.height > 180) return;
          // Avoid clicking inside the right-side details panel
          if (r.left > window.innerWidth * 0.7) return;
          // Avoid header rows at the very top
          if (r.top < 120) return;
          const parsed = parseRowText(row);
          if (!parsed.time || !parsed.date) return;
          if (!parsed.from_number && !parsed.to_number) return;
          // Prefer rows that likely have a recording: answered calls with a visible duration
          const outcomeLower = (parsed.outcome_text || '').toLowerCase();
          if (!parsed.duration_text) return;
          if (outcomeLower.includes('missed') || outcomeLower.includes('voicemail') || outcomeLower.includes('failed')) return;
          out.push({ click: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, ...parsed });
        };

        for (const row of rows) {
          if (!looksLikeCallRow(row)) continue;
          pushCandidate(row);
          if (out.length >= maxRows) break;
        }

        // If we still didn't find any, do a broader scan (SPA UIs often don't use roles)
        if (out.length === 0) {
          const all = Array.from(document.querySelectorAll('div, li, tr'));
          for (const el of all) {
            if (!/\b\d{1,2}:\d{2}\s*(AM|PM)\b/.test((el.innerText || '').toString())) continue;
            if (!/\b\d{2}\/\d{2}\/\d{2}\b/.test((el.innerText || '').toString())) continue;
            pushCandidate(el);
            if (out.length >= maxRows) break;
          }
        }

        // Deduplicate by Y position (nested divs can match)
        const seenY = new Set();
        const deduped = [];
        for (const c of out.sort((a, b) => a.click.y - b.click.y)) {
          const key = Math.round(c.click.y / 8);
          if (seenY.has(key)) continue;
          seenY.add(key);
          deduped.push(c);
          if (deduped.length >= maxRows) break;
        }

        return deduped;
      }, config.selectors, maxRows);

      const results = [];
      const base = new URL(this.page.url()).origin;

      for (const c of candidates) {
        try {
          // Click the row
          await this.page.mouse.click(c.click.x, c.click.y);
          // Give the SPA a moment to update the route
          await this.delay(600);

          // Wait briefly for URL update
          try {
            await this.page.waitForFunction(() => /\/calls\/\d+/.test(window.location.pathname), { timeout: 3000 });
          } catch (e) {}

          const url = this.page.url();
          const m = url.match(/\/calls\/(\d+)/);
          if (!m) continue;

          // Determine if this call page actually has a recording.
          // We avoid wasting time on download attempts for "No Recording Available" calls.
          const hasRecording = await this.page.evaluate(() => {
            const text = (document.body?.innerText || '').toLowerCase();
            if (text.includes('no recording available')) return false;
            // Heuristic: there is a player/seek bar area near the top of Call Details when recordings exist
            // (audio tag may be absent until play/download is triggered).
            const hasTimeline = /\b0:00\b/.test(text);
            const hasPlayBtn = Array.from(document.querySelectorAll('button')).some(b => {
              const al = (b.getAttribute('aria-label') || '').toLowerCase();
              const tt = (b.getAttribute('title') || '').toLowerCase();
              return al.includes('play') || tt.includes('play');
            });
            return hasTimeline || hasPlayBtn;
          });

          const callId = m[1];
          results.push({
            ...c,
            mango_call_id: callId,
            mango_detail_url: `${base}/calls/${callId}`,
            recording_url: null,
            has_recording: hasRecording,
            scraped_at: new Date().toISOString(),
          });
        } catch (e) {
          // ignore row failures
        }
      }

      // Only return if we found at least 1 valid ID
      return results.filter(r => !!r.mango_call_id);
    } catch (e) {
      return [];
    }
  }

  extractCallsFromApiResponses(texts) {
    const parsedJson = [];
    for (const t of texts) {
      try {
        parsedJson.push(JSON.parse(t));
      } catch (e) {}
    }

    // Find the "best" array of call-like objects
    let best = [];
    let bestScore = 0;
    for (const root of parsedJson) {
      const arrays = this.findArrays(root);
      for (const arr of arrays) {
        if (!Array.isArray(arr) || arr.length < 5) continue;
        const score = this.scoreCallArray(arr);
        if (score > bestScore) {
          best = arr;
          bestScore = score;
        }
      }
    }

    if (!best || best.length === 0) return [];

    const out = [];
    for (const item of best) {
      if (!item || typeof item !== 'object') continue;
      const id = item.callId || item.call_id || item.id || item.CallId || item.CallID;
      if (!id) continue;

      const startedAt = item.startedAt || item.startTime || item.start || item.dateTime || item.timestamp || null;
      const durationSec = item.durationSec || item.durationSeconds || item.duration || null;

      const from = item.from?.number || item.fromNumber || item.from_number || item.callerNumber || item.caller_number || '';
      const to = item.to?.number || item.toNumber || item.to_number || '';

      const outcome = item.outcome || item.status || item.callStatus || item.result || '';

      const dt = startedAt ? new Date(startedAt) : null;
      const date = dt && !isNaN(dt) ? dt.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }) : '';
      const time = dt && !isNaN(dt) ? dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';

      out.push({
        date,
        time,
        from_number: from,
        to_number: to,
        duration_text: typeof durationSec === 'number' ? this.formatDuration(durationSec) : (item.durationText || ''),
        outcome_text: typeof outcome === 'string' ? outcome : '',
        mango_call_id: String(id),
        mango_detail_url: `https://app.mangovoice.com/calls/${encodeURIComponent(String(id))}`,
        recording_url: null,
        scraped_at: new Date().toISOString(),
        raw_data: item,
      });
    }

    return out;
  }

  findArrays(node) {
    const found = [];
    const visit = (n) => {
      if (!n) return;
      if (Array.isArray(n)) {
        found.push(n);
        for (const x of n) visit(x);
        return;
      }
      if (typeof n === 'object') {
        for (const k of Object.keys(n)) visit(n[k]);
      }
    };
    visit(node);
    return found;
  }

  scoreCallArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    let score = 0;
    let checked = 0;
    for (const item of arr.slice(0, 25)) {
      if (!item || typeof item !== 'object') continue;
      checked++;
      const id = item.callId || item.call_id || item.id || item.CallId || item.CallID;
      if (id) score += 2;
      const hasFrom = item.fromNumber || item.from_number || item.from?.number || item.callerNumber || item.caller_number;
      const hasTo = item.toNumber || item.to_number || item.to?.number;
      if (hasFrom) score += 1;
      if (hasTo) score += 1;
      if (item.startedAt || item.startTime || item.timestamp) score += 1;
      if (item.durationSec || item.durationSeconds || item.duration) score += 1;
    }
    if (checked < 5) return 0;
    return score;
  }

  formatDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  /**
   * Extract call data from the table on the current page
   */
  async extractCallsFromTable() {
    return await this.page.evaluate((selectors) => {
      const calls = [];
      const rows = document.querySelectorAll(selectors.callLogRow);
      
      rows.forEach((row, index) => {
        try {
          const getCellTextByIndex = (idx) => {
            const cells = row.querySelectorAll('td, [role="cell"]');
            return cells && cells[idx] ? (cells[idx].textContent || '').trim() : '';
          };

          // Extract data from each column
          const date = row.querySelector(selectors.dateColumn)?.textContent?.trim() || '';
          const time = row.querySelector(selectors.timeColumn)?.textContent?.trim() || '';
          const from = row.querySelector(selectors.fromColumn)?.textContent?.trim() || '';
          const to = row.querySelector(selectors.toColumn)?.textContent?.trim() || '';
          const duration = row.querySelector(selectors.durationColumn)?.textContent?.trim() || '';
          const outcome = row.querySelector(selectors.outcomeColumn)?.textContent?.trim() || '';

          // Fallback for data-grids where our selectors don't match: parse by column index
          const fDate = date || getCellTextByIndex(0);
          const fTime = time || getCellTextByIndex(1);
          const fFrom = from || getCellTextByIndex(2);
          const fTo = to || getCellTextByIndex(3);
          const fDuration = duration || getCellTextByIndex(4);
          const fOutcome = outcome || getCellTextByIndex(5);
          
          // Find recording link if exists
          const recordingLink = row.querySelector(selectors.recordingLink) || row.querySelector('a[href]');
          const recordingUrl = recordingLink?.href || null;
          
          if (fDate || fFrom || fTo) {
            calls.push({
              row_index: index,
              date: fDate,
              time: fTime,
              from_number: fFrom,
              to_number: fTo,
              duration_text: fDuration,
              outcome_text: fOutcome,
              recording_url: recordingUrl,
              scraped_at: new Date().toISOString(),
            });
          }
        } catch (e) {
          console.error('Error parsing row:', e);
        }
      });

      // If we couldn't find table/grid rows via selectors (common in app.mangovoice.com),
      // fall back to parsing visible text blocks.
      if (calls.length === 0) {
        // Prefer extracting real call detail links (best signal)
        const toAbsolute = (href) => {
          try {
            return new URL(href, window.location.origin).toString();
          } catch {
            return href;
          }
        };

        const anchors = Array.from(document.querySelectorAll(selectors.appCallLink || 'a[href*="/calls/"]'));
        const callLinks = anchors
          .map(a => ({ href: a.getAttribute('href') || '', abs: toAbsolute(a.getAttribute('href') || ''), text: (a.textContent || '').trim() }))
          .filter(x => /\/calls\/\d+/.test(x.abs));

        if (callLinks.length > 0) {
          // Attempt to parse each call row by traversing up to a "row-like" container and reading its text.
          const unique = new Map(); // callId -> abs url
          for (const l of callLinks) {
            const m = l.abs.match(/\/calls\/(\d+)/);
            if (!m) continue;
            unique.set(m[1], l.abs);
          }

          unique.forEach((abs, callId) => {
            const a = anchors.find(x => (x.getAttribute('href') || '').includes(callId));
            const container = a ? (a.closest('[role="row"]') || a.closest('tr') || a.closest('div')) : null;
            const t = (container?.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);

            const isTime = (s) => /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(s);
            const isDate = (s) => /^\d{2}\/\d{2}\/\d{2}$/.test(s);
            const isDuration = (s) => /^(\d{1,2}:)?\d{1,2}:\d{2}$/.test(s);
            const isPhone = (s) => /\(\d{3}\)\s*\d{3}-\d{4}/.test(s) || /^\+?\d[\d\-\s\(\)]{7,}$/.test(s);

            const time = t.find(isTime) || '';
            const date = t.find(isDate) || '';
            const duration = t.find(isDuration) || '';
            const phones = t.filter(isPhone);
            const fromPhone = phones[0] || '';
            const toPhone = phones[1] || '';
            const outcomeCandidates = ['Answered', 'Missed', 'Voicemail', 'In Progress', 'Failed', 'Busy', 'No Answer'];
            const outcome = t.find(x => outcomeCandidates.some(o => x.toLowerCase() === o.toLowerCase())) || '';

            calls.push({
              row_index: calls.length,
              date,
              time,
              from_number: fromPhone,
              to_number: toPhone,
              duration_text: duration,
              outcome_text: outcome,
              recording_url: null,
              mango_detail_url: abs, // call details page (we'll derive mp3 download from here)
              mango_call_id: callId,
              scraped_at: new Date().toISOString(),
            });
          });

          return calls;
        }

        const lines = (document.body?.innerText || '')
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean);

        const isTime = (s) => /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(s);
        const isDate = (s) => /^\d{2}\/\d{2}\/\d{2}$/.test(s);
        const isDuration = (s) => /^(\d{1,2}:)?\d{1,2}:\d{2}$/.test(s);
        const isPhone = (s) => /\(\d{3}\)\s*\d{3}-\d{4}/.test(s) || /^\+?\d[\d\-\s\(\)]{7,}$/.test(s);

        // Split into blocks by time line
        const blocks = [];
        let current = [];
        for (const line of lines) {
          if (isTime(line) && current.length > 0) {
            blocks.push(current);
            current = [line];
          } else {
            current.push(line);
          }
        }
        if (current.length > 0) blocks.push(current);

        // Attempt to extract call detail links (app.mangovoice.com/calls/<id>) and align by index.
        const callDetailLinksByIndex = Array.from(new Set(
          Array.from(document.querySelectorAll('a[href*="/calls/"]'))
            .map(a => a.href)
            .filter(h => /\/calls\/\d+/.test(h))
        ));

        // Heuristic parse each block
        blocks.forEach((b, idx) => {
          if (!b[0] || !isTime(b[0])) return;
          const time = b[0];
          const date = b.find(isDate) || '';

          const duration = [...b].reverse().find(isDuration) || '';

          const phoneIdxs = [];
          b.forEach((x, i) => { if (isPhone(x)) phoneIdxs.push(i); });

          const fromPhone = phoneIdxs[0] !== undefined ? b[phoneIdxs[0]] : '';
          const toPhone = phoneIdxs[1] !== undefined ? b[phoneIdxs[1]] : '';

          const fromName = phoneIdxs[0] !== undefined && phoneIdxs[0] > 0 ? b[phoneIdxs[0] - 1] : '';
          const toName = phoneIdxs[1] !== undefined && phoneIdxs[1] > 0 ? b[phoneIdxs[1] - 1] : '';

          // Outcome tends to be one of these words somewhere near the top
          const outcomeCandidates = ['Answered', 'Missed', 'Voicemail', 'In Progress', 'Failed', 'Busy', 'No Answer'];
          const outcome = b.find(x => outcomeCandidates.some(o => x.toLowerCase() === o.toLowerCase())) || '';

          if (date || fromName || toName) {
            const detailUrl = callDetailLinksByIndex[idx] || null;
            const mangoCallIdMatch = detailUrl ? detailUrl.match(/\/calls\/(\d+)/) : null;
            calls.push({
              row_index: idx,
              date,
              time,
              from_number: fromPhone || fromName,
              to_number: toPhone || toName,
              duration_text: duration,
              outcome_text: outcome,
              recording_url: null,
              mango_detail_url: detailUrl,
              mango_call_id: mangoCallIdMatch ? mangoCallIdMatch[1] : null,
              scraped_at: new Date().toISOString(),
              raw_block: b.slice(0, 30),
            });
          }
        });
      }

      return calls;
    }, config.selectors);
  }

  /**
   * Try to discover the Call Logs page URL by looking for nav links.
   * This makes the scraper more resilient to portal URL changes.
   */
  async discoverCallLogsUrl() {
    try {
      const discovered = await this.page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const score = (a) => {
          const text = (a.textContent || '').trim().toLowerCase();
          const href = (a.href || '').toLowerCase();
          let s = 0;
          if (text.includes('call logs') || text.includes('call log')) s += 10;
          if (text === 'calls' || text.includes('calls')) s += 6;
          if (text.includes('cdr')) s += 6;
          if (href.includes('call')) s += 3;
          if (href.includes('cdr')) s += 3;
          if (href.includes('log')) s += 2;
          return s;
        };
        const best = anchors
          .map(a => ({ a, s: score(a) }))
          .filter(x => x.s > 0)
          .sort((x, y) => y.s - x.s)[0];
        return best?.a?.href || null;
      });
      return discovered;
    } catch (e) {
      return null;
    }
  }

  /**
   * Capture a screenshot + HTML snapshot for debugging selector/navigation issues.
   */
  async captureDebugArtifacts(reason = 'debug') {
    try {
      const dir = path.join(__dirname, '../../data/mango_debug');
      await fs.mkdir(dir, { recursive: true });
      const ts = Date.now();
      const safeReason = String(reason).replace(/[^a-zA-Z0-9_-]/g, '_');
      const url = this.page ? this.page.url() : 'unknown';

      const htmlPath = path.join(dir, `${safeReason}_${ts}.html`);
      const metaPath = path.join(dir, `${safeReason}_${ts}.json`);
      const pngPath = path.join(dir, `${safeReason}_${ts}.png`);

      const html = this.page ? await this.page.content() : '';
      await fs.writeFile(htmlPath, html, 'utf8');
      await fs.writeFile(metaPath, JSON.stringify({ reason, url, timestamp: new Date().toISOString() }, null, 2), 'utf8');
      if (this.page) {
        await this.page.screenshot({ path: pngPath, fullPage: true });
      }

      console.log(`🧩 Mango debug artifacts saved: ${path.relative(process.cwd(), dir)}`);
    } catch (e) {
      // best-effort only
    }
  }

  /**
   * Select the correct PBX on app.mangovoice.com/select-pbx pages.
   * If MANGO_PBX_NAME is configured, selects that PBX by name.
   * Otherwise, selects the first PBX in the list.
   */
  async selectFirstPbxIfNeeded() {
    try {
      const targetPbxName = config.pbx?.name || '';
      console.log(`🏢 Mango requires PBX selection${targetPbxName ? `; looking for "${targetPbxName}"` : '; selecting first PBX'}...`);
      
      // Wait for the "Select your PBX" text to appear
      await this.page.waitForFunction(
        () => document.body?.innerText?.includes('Select your PBX'),
        { timeout: 15000 }
      );
      await this.delay(500);
      
      // Find PBX options by looking for clickable divs with cursor:pointer containing PBX names
      // The Mango UI uses dynamically-generated CSS class names, so we look for structure instead
      const pbxOptions = await this.page.evaluate(() => {
        // Find all divs that look like PBX options (have cursor pointer and contain text)
        const candidates = Array.from(document.querySelectorAll('div'))
          .filter(el => {
            const style = window.getComputedStyle(el);
            const text = el.innerText?.trim() || '';
            // Must be clickable and have text, but not be a button or contain multiple nested divs
            return style.cursor === 'pointer' && 
                   text.length > 0 && 
                   text.length < 100 &&
                   !el.querySelector('button') &&
                   el.querySelectorAll('div').length < 3;
          });
        
        // Filter to find PBX-like entries (they often contain "Dental", "Family", etc.)
        // and exclude obvious non-PBX elements
        const pbxLike = candidates.filter(el => {
          const text = el.innerText?.trim() || '';
          // Skip elements that are clearly UI controls
          if (/^(back|next|log in|sign in|cancel)$/i.test(text)) return false;
          // Skip version badges
          if (/^v[\d.]+$/.test(text)) return false;
          return true;
        });
        
        // Get unique text entries (in case of nested matches)
        const seen = new Set();
        return pbxLike
          .map((el, idx) => ({ element: el, text: el.innerText?.trim() || '', idx }))
          .filter(item => {
            if (seen.has(item.text)) return false;
            seen.add(item.text);
            return true;
          })
          .map(item => ({ name: item.text, index: item.idx }));
      });
      
      if (!pbxOptions || pbxOptions.length === 0) {
        throw new Error('No PBX rows found on select-pbx page');
      }
      
      console.log(`📋 Available PBXes: ${pbxOptions.map(p => p.name).join(', ')}`);
      
      // Find the target PBX (by name if configured, otherwise first)
      let targetName = pbxOptions[0].name;
      if (targetPbxName) {
        const match = pbxOptions.find(p => 
          p.name.toLowerCase().includes(targetPbxName.toLowerCase())
        );
        if (match) {
          targetName = match.name;
          console.log(`✅ Found matching PBX: "${match.name}"`);
        } else {
          console.log(`⚠️ PBX "${targetPbxName}" not found, falling back to first PBX: "${pbxOptions[0].name}"`);
        }
      }
      
      // Click the PBX by finding it again and clicking
      await this.page.evaluate((name) => {
        const candidates = Array.from(document.querySelectorAll('div'))
          .filter(el => {
            const style = window.getComputedStyle(el);
            const text = el.innerText?.trim() || '';
            return style.cursor === 'pointer' && text === name;
          });
        if (candidates[0]) candidates[0].click();
      }, targetName);

      // Wait for route change away from select-pbx
      await this.page.waitForFunction(() => !window.location.href.includes('select-pbx'), { timeout: 20000 });
      console.log(`✅ PBX selected, now at: ${this.page.url()}`);
    } catch (e) {
      await this.captureDebugArtifacts('select-pbx-failed');
      throw e;
    }
  }

  /**
   * Download a recording file
   * @param {string} recordingUrl - URL of the recording
   * @param {string} callId - Call ID for naming the file
   */
  async downloadRecording(recordingUrl, callId) {
    if (!recordingUrl) {
      return null;
    }

    console.log(`⬇️ Downloading recording for call ${callId}...`);

    try {
      // Ensure we have an active page/session
      await this.login();

      // If this is a Mango "call details" page, use the more reliable network-capture flow.
      // That flow saves the MP3 by buffering the response, avoiding flaky browser download behavior.
      if (/\/calls\/\d+/i.test(recordingUrl)) {
        const dl = await this.downloadRecordingFromCallDetail(recordingUrl, callId);
        return dl?.filepath || null;
      }

      const downloadDir = path.resolve(config.sync.recordingsPath);
      await fs.mkdir(downloadDir, { recursive: true });

      const before = new Set(await fs.readdir(downloadDir));

      // Navigate to call details page (or mp3 url)
      await this.page.goto(recordingUrl, { waitUntil: 'networkidle2' });
      await this.delay(1500);

      // If redirected to login or PBX selector, handle it
      if (this.page.url().includes('login')) {
        await this.loginOnCurrentPageIfNeeded();
      }
      if (this.page.url().includes('select-pbx')) {
        await this.selectFirstPbxIfNeeded();
        // Return to the intended call detail page after PBX selection
        await this.page.goto(recordingUrl, { waitUntil: 'networkidle2' });
        await this.delay(1500);
      }

      // Skip quickly if Mango explicitly says there is no recording for this call.
      const noRecording = await this.page.evaluate(() => {
        const t = (document.body?.innerText || '').toLowerCase();
        return t.includes('no recording available');
      });
      if (noRecording) {
        console.log(`ℹ️ No recording available for call ${callId}`);
        return null;
      }

      // If this is already a direct mp3 link, navigation should trigger download via CDP.
      // Otherwise, open the kebab menu and click "Download".
      if (!/\.mp3(\?|$)/i.test(this.page.url())) {
        await this.openKebabMenuAndDownload();
      }

      // Wait for a new download to appear in download dir (may start as .crdownload)
      const started = Date.now();
      let newest = null;
      while (Date.now() - started < 90000) {
        const files = await fs.readdir(downloadDir);
        const newFiles = files.filter(f => !before.has(f));
        const anyNew = newFiles[0];
        if (anyNew) {
          // Prefer finalized mp3 if present
          const mp3 = newFiles.find(f => f.toLowerCase().endsWith('.mp3'));
          if (mp3) {
            newest = path.join(downloadDir, mp3);
            break;
          }

          // If a .crdownload exists, wait until it finishes
          const cr = newFiles.find(f => f.toLowerCase().endsWith('.crdownload'));
          if (cr) {
            const crPath = path.join(downloadDir, cr);
            const base = crPath.slice(0, -'.crdownload'.length);
            // Wait a bit for Chrome to finalize
            for (let i = 0; i < 120; i++) {
              const doneExists = fssync.existsSync(base);
              if (doneExists) {
                newest = base;
                break;
              }
              await this.delay(500);
            }
            if (newest) break;
          }
        }
        await this.delay(500);
      }

      if (!newest) {
        // Only capture artifacts if we expected a recording; otherwise this is common noise.
        await this.captureDebugArtifacts('recording-download-timeout');
        return null;
      }

      // Rename to a deterministic filename so we can trace it back to the Mango call
      const safeId = String(callId || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
      const renamed = path.join(downloadDir, `mango_${safeId}_${Date.now()}.mp3`);
      try {
        await fs.rename(newest, renamed);
        newest = renamed;
      } catch (e) {
        // If rename fails (file lock), keep original
      }

      console.log(`✅ Recording downloaded: ${path.basename(newest)}`);
      return newest;

    } catch (error) {
      console.error(`❌ Failed to download recording for call ${callId}:`, error.message);
      return null;
    }
  }

  async openKebabMenuAndDownload() {
    // Mango app UI menus may be rendered in shadow DOM/portals that querySelectorAll can't see.
    // Use geometry to open the kebab (top-right) and click the 3rd menu item ("Download audio").

    const kebabRect = await this.page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], div'))
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(x => x.r.width > 0 && x.r.height > 0)
        .filter(x => x.r.top < 220 && x.r.left > window.innerWidth * 0.6)
        .filter(x => x.r.width <= 60 && x.r.height <= 60);

      // Right-most small control in the Call Details header is typically the kebab
      const topRight = nodes.sort((a, b) => b.r.left - a.r.left)[0];
      if (!topRight) return null;
      return { left: topRight.r.left, top: topRight.r.top, width: topRight.r.width, height: topRight.r.height };
    });

    if (!kebabRect) {
      await this.captureDebugArtifacts('kebab-not-found');
      throw new Error('Kebab/menu button not found on call details page');
    }

    // Click kebab
    await this.page.mouse.click(kebabRect.left + kebabRect.width / 2, kebabRect.top + kebabRect.height / 2);
    await this.delay(400);

    // Keyboard navigation: menu order observed in UI:
    // 1) Copy Link to Call
    // 2) Copy Link to Call at Timestamp
    // 3) Download audio
    // ArrowDown twice + Enter is more reliable than DOM clicking (menu may be in shadow DOM)
    try {
      await this.page.keyboard.press('ArrowDown');
      await this.delay(80);
      await this.page.keyboard.press('ArrowDown');
      await this.delay(80);
      await this.page.keyboard.press('Enter');
    } catch (e) {
      // ignore
    }

    await this.delay(1200);
  }

  /**
   * Parse duration text to seconds
   * @param {string} durationText - Duration text like "2:30" or "00:02:30"
   */
  parseDuration(durationText) {
    if (!durationText) return 0;
    
    const parts = durationText.split(':').map(Number);
    
    if (parts.length === 3) {
      // HH:MM:SS
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      // MM:SS
      return parts[0] * 60 + parts[1];
    }
    
    return parseInt(durationText) || 0;
  }

  /**
   * Parse date and time to ISO string
   * @param {string} dateText - Date text
   * @param {string} timeText - Time text
   */
  parseDateTime(dateText, timeText) {
    try {
      const dateTimeStr = `${dateText} ${timeText}`;
      const parsed = new Date(dateTimeStr);
      
      if (isNaN(parsed.getTime())) {
        return new Date().toISOString();
      }
      
      return parsed.toISOString();
    } catch (e) {
      return new Date().toISOString();
    }
  }

  /**
   * Map outcome text to standardized outcome
   */
  mapOutcome(outcomeText) {
    const lower = (outcomeText || '').toLowerCase().trim();
    return config.outcomeMapping[lower] || 'unknown';
  }

  /**
   * Transform raw scraped data to our call format
   */
  transformCall(rawCall) {
    const safeExternalId = rawCall.external_id ||
      (rawCall.mango_call_id ? `mango_call_${rawCall.mango_call_id}` : null) ||
      `mango_${rawCall.date || ''}_${rawCall.time || ''}_${rawCall.from_number || ''}`.replace(/[^a-zA-Z0-9_]/g, '_');

    return {
      source: 'mango',
      external_id: safeExternalId,
      mango_call_id: rawCall.mango_call_id || null,
      mango_detail_url: rawCall.mango_detail_url || null,
      call_date: this.parseDateTime(rawCall.date, rawCall.time),
      caller_number: rawCall.from_number,
      called_number: rawCall.to_number,
      duration_seconds: this.parseDuration(rawCall.duration_text),
      outcome: this.mapOutcome(rawCall.outcome_text),
      handler_type: 'staff',
      handler_name: null, // Could be extracted if Mango shows extension/user
      // Only set recording_url when it's a real downloadable audio URL (we'll populate after download)
      recording_url: rawCall.recording_url && /\.mp3(\?|$)/i.test(rawCall.recording_url) ? rawCall.recording_url : null,
      raw_data: rawCall,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * Full sync: scrape calls, download recordings, return processed data
   */
  async fullSync(options = {}) {
    console.log('🔄 Starting Mango full sync...');
    const startTime = Date.now();
    
    const result = {
      success: false,
      calls_found: 0,
      calls_processed: 0,
      recordings_downloaded: 0,
      errors: [],
      duration_ms: 0,
    };

    try {
      // Scrape call logs
      const rawCalls = await this.scrapeCallLogs(options);
      result.calls_found = rawCalls.length;
      
      // Transform calls
      const processedCalls = [];
      let recordingsDownloadedThisRun = 0;
      for (const rawCall of rawCalls) {
        try {
          const call = this.transformCall(rawCall);
          
          // Download recording if enabled and available
          if (config.sync.downloadRecordings && recordingsDownloadedThisRun < config.sync.maxRecordingsPerSync) {
            // Only attempt MP3 download when there is likely a recording (answered calls with duration)
            const likelyHasRecording = (call.duration_seconds || 0) > 0 && call.outcome !== 'missed' && call.outcome !== 'failed';

            // If we have a Mango detail URL (like https://app.mangovoice.com/calls/4637427643),
            // download the MP3 by opening the details page and clicking the kebab-menu "Download" option.
            const detailUrl = rawCall.mango_detail_url;
            const hasRecordingSignal = rawCall.has_recording === true;
            if (detailUrl && likelyHasRecording && hasRecordingSignal) {
              const recordingPath = await this.downloadRecording(detailUrl, call.external_id);
              if (recordingPath) {
                const filename = path.basename(recordingPath);
                call.recording_path = recordingPath;
                call.recording_url = `/api/mango/recordings/${encodeURIComponent(filename)}`;
                result.recordings_downloaded++;
                recordingsDownloadedThisRun++;
              }
            }
          }
          
          processedCalls.push(call);
          result.calls_processed++;
          
          // Rate limiting
          await this.delay(500);
          
        } catch (e) {
          result.errors.push(`Error processing call: ${e.message}`);
        }
      }
      
      result.success = true;
      result.calls = processedCalls;
      this.lastSyncTime = new Date();
      
    } catch (error) {
      result.errors.push(error.message);
      console.error('❌ Mango sync failed:', error.message);
    }

    result.duration_ms = Date.now() - startTime;
    console.log(`✅ Mango sync completed in ${result.duration_ms}ms`);
    console.log(`   Found: ${result.calls_found}, Processed: ${result.calls_processed}, Recordings: ${result.recordings_downloaded}`);
    
    return result;
  }

  /**
   * Download MP3 for a Mango call by opening the call detail page and extracting the MP3 URL
   * from network JSON responses. Saves file to recordingsPath and returns file path + public URL.
   */
  async downloadRecordingFromCallDetail(detailUrl, callId) {
    try {
      await this.login();

      // Capture JSON + audio responses while loading the details page
      const jsonTexts = [];
      const audioResponses = [];
      let lastAudioResponseUrl = null;
      const onResponse = async (res) => {
        try {
          const url = res.url();
          if (!/mangovoice\.com/i.test(url)) return;
          const ct = (res.headers()['content-type'] || '').toLowerCase();
          const cd = (res.headers()['content-disposition'] || '').toLowerCase();

          if (ct.includes('audio') || /\.mp3(\?|$)/i.test(url) || cd.includes('.mp3')) {
            audioResponses.push(res);
            lastAudioResponseUrl = url;
            return;
          }

          if (!ct.includes('application/json')) return;
          const text = await res.text();
          if (text && text.length < 8_000_000) jsonTexts.push(text);
        } catch (e) {}
      };
      this.page.on('response', onResponse);

      // Navigate to the details page
      await this.page.goto(detailUrl, { waitUntil: 'networkidle2' });
      await this.delay(1500);

      if (this.page.url().includes('login')) {
        await this.loginOnCurrentPageIfNeeded();
      }
      if (this.page.url().includes('select-pbx')) {
        await this.selectFirstPbxIfNeeded();
        // Return to the desired detail page after selecting PBX
        await this.page.goto(detailUrl, { waitUntil: 'networkidle2' });
        await this.delay(1500);
      }

      // Wait for call details UI to render (not just skeleton)
      try {
        await this.page.waitForFunction(() => {
          const text = document.body?.innerText || '';
          // "Call Details" appears in the right panel; duration like "3:41" often appears near player
          return /call details/i.test(text) && /\b\d{1,2}:\d{2}\b/.test(text);
        }, { timeout: 20000 });
      } catch (e) {
        // continue; we might still be able to find audio
      }

      // 1) If an <audio> element has a direct URL, use it
      const directAudioUrl = await this.page.evaluate(() => {
        const a = document.querySelector('audio');
        const s = document.querySelector('audio source');
        const src = a?.src || s?.getAttribute('src') || null;
        if (!src) return null;
        // ignore blob URLs
        if (src.startsWith('blob:')) return null;
        return src;
      });

      let mp3Url = directAudioUrl || this.findFirstMp3UrlInJsonTexts(jsonTexts);

      // 2) If we still don't have it, try to trigger audio load by clicking a Play button (best-effort)
      if (!mp3Url) {
        try {
          // Start waiting for an audio response
          const audioRespPromise = this.page.waitForResponse((res) => {
            const url = res.url();
            const ct = (res.headers()['content-type'] || '').toLowerCase();
            const cd = (res.headers()['content-disposition'] || '').toLowerCase();
            return ct.includes('audio') || /\.mp3(\?|$)/i.test(url) || cd.includes('.mp3');
          }, { timeout: 15000 });

          // Attempt "Download MP3" via the kebab menu (three dots)
          await this.openKebabMenuAndDownload();

          const audioResp = await audioRespPromise;
          if (audioResp) {
            mp3Url = audioResp.url();
            audioResponses.push(audioResp);
          }
        } catch (e) {
          // ignore
        }
      }

      // 3) As a fallback, try triggering audio load by clicking a Play button (best-effort)
      if (!mp3Url) {
        try {
          const audioRespPromise = this.page.waitForResponse((res) => {
            const url = res.url();
            const ct = (res.headers()['content-type'] || '').toLowerCase();
            const cd = (res.headers()['content-disposition'] || '').toLowerCase();
            return ct.includes('audio') || /\.mp3(\?|$)/i.test(url) || cd.includes('.mp3');
          }, { timeout: 15000 });

          await this.page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const byLabel = btns.find(b => /play/i.test(b.getAttribute('aria-label') || '') || /play/i.test(b.getAttribute('title') || ''));
            if (byLabel) return byLabel.click();

            // Heuristic: click a likely play button near the top of Call Details panel
            const withSvg = btns
              .map(b => ({ b, r: b.getBoundingClientRect() }))
              .filter(x => x.r.top < 260 && x.r.left > window.innerWidth * 0.55)
              .filter(x => x.b.querySelector('svg'))
              .sort((a, z) => a.r.left - z.r.left);
            // Often the play button is among the first few icon buttons in that row
            if (withSvg[2]?.b) withSvg[2].b.click();
          });

          const audioResp = await audioRespPromise;
          if (audioResp) {
            mp3Url = audioResp.url();
            audioResponses.push(audioResp);
          }
        } catch (e) {}
      }

      // Stop listening
      this.page.off('response', onResponse);

      if (!mp3Url) {
        await this.captureDebugArtifacts('recording-url-not-found');
        if (lastAudioResponseUrl) {
          console.log(`ℹ️ Saw audio-ish response but couldn't resolve mp3Url: ${lastAudioResponseUrl}`);
        }
        return null;
      }

      console.log(`🎧 Mango MP3 URL resolved for ${callId}: ${mp3Url}`);

      // Download the MP3 using a separate page (shares cookies in the same browser context)
      const filename = `mango_${callId}_${Date.now()}.mp3`.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const absDir = path.resolve(config.sync.recordingsPath);
      const absPath = path.join(absDir, filename);
      await fs.mkdir(absDir, { recursive: true });

      // Prefer direct Node fetch for signed URLs (more reliable than browser download behavior)
      const downloadWithFetch = async () => {
        if (typeof fetch !== 'function') return false;
        const resp = await fetch(mp3Url, { redirect: 'follow' });
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (!resp.ok) {
          throw new Error(`MP3 fetch failed: ${resp.status} ${resp.statusText}`);
        }
        if (!ct.includes('audio') && !ct.includes('mpeg') && !ct.includes('octet-stream')) {
          // Common failure mode: HTML/XML error from S3
          const preview = (await resp.text()).slice(0, 300);
          throw new Error(`MP3 fetch returned non-audio content-type "${ct}". Preview: ${preview}`);
        }
        const ab = await resp.arrayBuffer();
        await fs.writeFile(absPath, Buffer.from(ab));
        return true;
      };

      try {
        const ok = await downloadWithFetch();
        if (!ok) throw new Error('Global fetch not available');
      } catch (e) {
        // Fallback: try puppeteer response buffering
        const captured = audioResponses.find(r => r.url() === mp3Url);
        if (captured) {
          const buf = await captured.buffer();
          await fs.writeFile(absPath, buf);
        } else {
          const dlPage = await this.browser.newPage();
          try {
            const resp = await dlPage.goto(mp3Url, { waitUntil: 'networkidle2' });
            if (!resp) throw new Error('No response when downloading MP3');
            const ct = (resp.headers()['content-type'] || '').toLowerCase();
            if (!ct.includes('audio') && !ct.includes('mpeg') && !ct.includes('octet-stream')) {
              throw new Error(`Puppeteer MP3 download returned non-audio content-type "${ct}"`);
            }
            const buf = await resp.buffer();
            await fs.writeFile(absPath, buf);
          } finally {
            await dlPage.close().catch(() => {});
          }
        }
      }

      // Sanity check file exists and is non-trivial
      const stat = fssync.existsSync(absPath) ? fssync.statSync(absPath) : null;
      if (!stat || stat.size < 1024) {
        await this.captureDebugArtifacts('recording-download-too-small');
        return null;
      }

      // Public URL served by backend static route (added in server.js)
      const publicUrl = `/api/mango/recordings/${encodeURIComponent(filename)}`;
      return { filepath: absPath, publicUrl, mp3Url };
    } catch (e) {
      console.error(`❌ Mango downloadRecordingFromCallDetail failed for ${callId}: ${e.message}`);
      return null;
    }
  }

  findFirstMp3UrlInJsonTexts(texts) {
    for (const t of texts) {
      const m = t.match(/https?:\/\/[^\s"'\\]+\.mp3(?:\?[^\s"'\\]+)?/i);
      if (m && m[0]) return m[0];
      // Some APIs may provide a path-only URL
      const m2 = t.match(/\/[^\s"'\\]+\.mp3(?:\?[^\s"'\\]+)?/i);
      if (m2 && m2[0]) {
        // Assume app domain if relative
        return `https://app.mangovoice.com${m2[0]}`;
      }
    }
    return null;
  }

  /**
   * Utility: delay for rate limiting
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Close the browser
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.isLoggedIn = false;
      console.log('🔧 Mango scraper browser closed');
    }
  }

  /**
   * Get scraper status
   */
  getStatus() {
    return {
      initialized: !!this.browser,
      loggedIn: this.isLoggedIn,
      lastSyncTime: this.lastSyncTime,
    };
  }
}

// Export singleton instance
module.exports = new MangoScraper();

