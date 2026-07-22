/**
 * Mango internal REST API client (interim M3 ingestion path).
 *
 * The Mango web app (app.mangovoice.com) is backed by a clean Django-REST API at
 * api.mangovoice.com, Bearer-authenticated. We drive that directly instead of DOM
 * scraping. The Bearer is minted by the SPA login, so the interim auth provider harvests
 * it from a Puppeteer login session. When the documented "Global API" unblocks, only the
 * auth provider needs swapping — the client + normalization stay.
 *
 * Compliance (D3): recordings are the signed, EXPIRING S3 `recording_url` from call detail.
 * We fetch → Azure Speech (BAA) → discard; audio is never written to disk here.
 */

const config = require('../config/mango');
const mangoScraper = require('./mangoScraper'); // reused ONLY for its Puppeteer login/session
const transcriptionService = require('./transcriptionService');
const { normalizeMangoCall, isIngestibleCall } = require('./mangoNormalize');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Transcribe calls at least this long (very short clips are noise / AUDIO_TOO_SHORT).
const MIN_TRANSCRIBE_SECONDS = 5;

// ---------------------------------------------------------------------------
// Auth layer — isolated behind a small interface so the eventual documented
// Global-API token scheme can drop in without touching the client/normalizer.
// ---------------------------------------------------------------------------

class MangoAuthProvider {
  /** @returns {Promise<string>} an "Authorization" header value (e.g. "Bearer …"). */
  async getToken() { throw new Error('MangoAuthProvider.getToken not implemented'); }
  /** Invalidate any cached token (called on 401 to force a re-harvest). */
  invalidate() {}
}

/**
 * Interim provider: log in with Puppeteer and harvest the SPA's Bearer token from an
 * outgoing api.mangovoice.com request. Token is cached until invalidated.
 */
class BrowserSessionAuthProvider extends MangoAuthProvider {
  constructor() {
    super();
    this._token = null;
    this._inFlight = null;
  }

  invalidate() {
    this._token = null;
    // Force mangoScraper to re-authenticate on the next login() as well.
    mangoScraper.isLoggedIn = false;
  }

  async getToken() {
    if (this._token) return this._token;
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._harvest().finally(() => { this._inFlight = null; });
    return this._inFlight;
  }

  async _harvest() {
    await mangoScraper.login(); // handles login-URL, selectors, PBX select (validated)
    const page = mangoScraper.page;

    let bearer = '';
    const listener = (req) => {
      try {
        if (bearer) return;
        if (!/api\.mangovoice\.com/i.test(req.url())) return;
        const a = req.headers()['authorization'] || req.headers()['Authorization'] || '';
        if (/^Bearer\s+/i.test(a)) bearer = a;
      } catch (_) {}
    };
    page.on('request', listener);
    try {
      // Landing on the app home fires API XHRs that carry the Bearer.
      await page.goto(`${config.portal.baseUrl}/`, { waitUntil: 'networkidle2' }).catch(() => {});
      if (page.url().includes('select-pbx')) {
        await mangoScraper.selectFirstPbxIfNeeded().catch(() => {});
      }
      const deadline = Date.now() + 12000;
      while (!bearer && Date.now() < deadline) await sleep(250);
    } finally {
      page.off('request', listener);
    }

    if (!bearer) throw new Error('Failed to harvest Mango Bearer token from login session');
    this._token = bearer;
    return this._token;
  }
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

class MangoApiClient {
  /**
   * @param {MangoAuthProvider} [authProvider]
   * @param {{ baseUrl?: string }} [opts]
   */
  constructor(authProvider, opts = {}) {
    this.auth = authProvider || new BrowserSessionAuthProvider();
    this.baseUrl = (opts.baseUrl || config.api.baseUrl).replace(/\/+$/, '');
  }

  /**
   * Authenticated JSON request. On 401, invalidate + re-harvest the token and retry once.
   * @param {string} pathOrUrl
   * @param {{ method?: string, retryOn401?: boolean }} [opts]
   */
  async _fetch(pathOrUrl, opts = {}) {
    const method = opts.method || 'GET';
    const retryOn401 = opts.retryOn401 !== false;
    const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;

    const token = await this.auth.getToken();
    let res = await fetch(url, { method, headers: { authorization: token, accept: 'application/json' } });

    if (res.status === 401 && retryOn401) {
      this.auth.invalidate();
      const fresh = await this.auth.getToken();
      res = await fetch(url, { method, headers: { authorization: fresh, accept: 'application/json' } });
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (_) {}
      throw new Error(`Mango API ${method} ${pathOrUrl} -> ${res.status} ${detail}`);
    }
    return res.json();
  }

  /**
   * GET /calls/ — one page.
   * NB: order by `-started_at` (actual call time). `-created_at` is the DB record/import
   * time (Mango backfilled history), so it does NOT surface the most recent calls.
   */
  async listCalls({ limit = 50, offset = 0, ordering = '-started_at' } = {}) {
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset), ordering });
    const j = await this._fetch(`/calls/?${q.toString()}`);
    return { count: j.count, next: j.next, results: Array.isArray(j.results) ? j.results : [] };
  }

  /** GET /calls/<id>/ — detail incl. signed recording_url. */
  async getCall(id) {
    return this._fetch(`/calls/${encodeURIComponent(id)}/`);
  }

  /** Close the underlying browser session (auth). */
  async close() {
    await mangoScraper.close().catch(() => {});
  }

  /**
   * Fetch recent calls, normalize, and transcribe recordings inline (D3 discard).
   * Mirrors the contract syncScheduler expects from the retired scraper's fullSync,
   * except transcription happens here (the signed recording_url expires quickly).
   *
   * @param {{ sinceDays?: number, maxCalls?: number }} [options]
   */
  async fullSync(options = {}) {
    const sinceDays = options.sinceDays || 1;
    const maxCalls = options.maxCalls || 100;
    const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

    const result = {
      success: false,
      calls_found: 0,
      calls_processed: 0,
      recordings_transcribed: 0,
      calls: [],
      errors: [],
    };

    console.log(`📞 Mango API sync: pulling up to ${maxCalls} calls from last ${sinceDays}d...`);

    // Page through /calls/ (newest first) until we pass the window or hit maxCalls.
    const raw = [];
    let offset = 0;
    const pageSize = 50;
    let stop = false;
    while (raw.length < maxCalls && !stop) {
      let page;
      try {
        page = await this.listCalls({ limit: Math.min(pageSize, maxCalls - raw.length), offset });
      } catch (e) {
        result.errors.push(`listCalls offset=${offset}: ${e.message}`);
        break;
      }
      if (!page.results.length) break;
      for (const c of page.results) {
        const started = c.started_at ? Date.parse(c.started_at) : Date.now();
        if (Number.isFinite(started) && started < sinceMs) { stop = true; break; }
        if (isIngestibleCall(c)) raw.push(c);
      }
      if (page.results.length < Math.min(pageSize, maxCalls)) break;
      offset += page.results.length;
      await sleep(300); // be polite
    }

    result.calls_found = raw.length;
    const canTranscribe = transcriptionService.isAvailable();

    for (const c of raw) {
      try {
        const call = normalizeMangoCall(c);

        if (canTranscribe && !c.is_missed && (call.duration_seconds || 0) >= MIN_TRANSCRIBE_SECONDS) {
          try {
            const detail = await this.getCall(c.id);
            const rec = detail && detail.recording_url;
            if (rec && typeof rec === 'string') {
              const tr = await transcriptionService.transcribeUrl(rec); // in-memory; discarded
              if (tr && tr.text) {
                call.transcript = tr.text;
                call.transcript_json = tr.utterances || tr.words || null;
                result.recordings_transcribed++;
              }
            }
          } catch (e) {
            result.errors.push(`transcribe ${c.id}: ${e.message}`);
          }
        }

        result.calls.push(call);
        result.calls_processed++;
      } catch (e) {
        result.errors.push(`normalize ${c && c.id}: ${e.message}`);
      }
    }

    result.success = true;
    console.log(`✅ Mango API sync: found ${result.calls_found}, transcribed ${result.recordings_transcribed}, errors ${result.errors.length}`);
    return result;
  }
}

// Default singleton (browser-session auth). Exports the classes too for testing / future swap.
module.exports = new MangoApiClient();
module.exports.MangoApiClient = MangoApiClient;
module.exports.MangoAuthProvider = MangoAuthProvider;
module.exports.BrowserSessionAuthProvider = BrowserSessionAuthProvider;
