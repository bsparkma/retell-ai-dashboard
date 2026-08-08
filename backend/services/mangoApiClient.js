/**
 * Mango internal REST API client (interim M3 ingestion path).
 *
 * The Mango web app (app.mangovoice.com) is backed by a clean Django-REST API at
 * api.mangovoice.com, Bearer-authenticated with SimpleJWT. We drive that directly instead
 * of DOM scraping. When the documented "Global API" unblocks, only the auth provider swaps.
 *
 * Auth is isolated behind MangoAuthProvider:
 *   - HttpLoginAuthProvider (DEFAULT): POST /api/token/ {username,password} -> {access,refresh}.
 *     Pure fetch — no browser — so it runs in the lean API container (no Chromium).
 *   - BrowserSessionAuthProvider (fallback): harvests the Bearer from a Puppeteer login,
 *     for environments where the HTTP login is unavailable. Requires Chromium.
 *
 * Compliance (D3): recordings are the signed, EXPIRING S3 `recording_url` from call detail.
 * We fetch → Azure Speech (BAA) → discard; audio is never written to disk here.
 */

const config = require('../config/mango');
const transcriptionService = require('./transcriptionService');
const unifiedCallStore = require('./unifiedCallStore');
const ingestionWatermark = require('./ingestionWatermark');
const { normalizeMangoCall, isIngestibleCall } = require('./mangoNormalize');
const { getOfficeForCall, normalizeE164 } = require('../config/officeAgents');
const { normalizeTranscriptJson } = require('../utils/transcriptShape');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Transcribe calls at least this long (very short clips are noise / AUDIO_TOO_SHORT).
const MIN_TRANSCRIBE_SECONDS = 5;
// Rows requested per /calls/ page during the backwards walk.
const PAGE_SIZE = 50;
// Offices we always report in the summary, in display order. Any office key not listed
// here still gets a bucket — this is only the ordering/always-shown set.
const OFFICE_LOG_ORDER = ['roland', 'valley', 'unknown'];

/**
 * One office's slice of a sync. Every ingested call lands in EXACTLY ONE outcome bucket,
 * so `ingested` equals the sum of the rest — the diagnosis could not reconcile 1-6 calls
 * per batch precisely because the old counters were not a closed set.
 */
function blankOfficeCounters() {
  return {
    ingested: 0,        // normalized + returned for storage
    transcribed: 0,     // sent to Azure Speech, got text back
    reused: 0,          // transcript already in the store (dedup guard)
    auto_off: 0,        // WOULD have been transcribed, but MANGO_AUTO_TRANSCRIBE is false
    budget_skipped: 0,  // daily audio-minute breaker was spent
    no_recording: 0,    // Mango had no recording_url for it AT FETCH TIME
    missed: 0,          // is_missed — nothing to transcribe
    too_short: 0,       // shorter than MIN_TRANSCRIBE_SECONDS
    errors: 0,          // detail fetch / Speech threw
    unavailable: 0,     // Azure Speech not configured in this environment
    empty: 0,           // Speech returned no text
    // Recording IS enabled on every Mango line (confirmed by Beau), so a missing
    // recording_url is a PUBLISH-LAG question, not a per-line setting question. Bucketing
    // by how old the call was when we asked answers it: mass in <15m = publish lag (M4's
    // on-demand button fixes it for free); anything >60m is a real gap worth investigating.
    no_recording_age: { lt15m: 0, m15to60: 0, gt60m: 0, unknown: 0 },
  };
}

/** Which age bucket a call falls in, measured at the moment we asked Mango for its detail. */
function noRecordingAgeBucket(startedAt, nowMs) {
  const t = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(t)) return 'unknown';
  const ageMin = (nowMs - t) / 60000;
  if (ageMin < 15) return 'lt15m';
  if (ageMin <= 60) return 'm15to60';
  return 'gt60m';
}

// ---------------------------------------------------------------------------
// Auth layer — isolated behind a small interface so the eventual documented
// Global-API token scheme can drop in without touching the client/normalizer.
// ---------------------------------------------------------------------------

class MangoAuthProvider {
  /** @returns {Promise<string>} an "Authorization" header value (e.g. "Bearer …"). */
  async getToken() { throw new Error('MangoAuthProvider.getToken not implemented'); }
  /** Invalidate any cached token (called on 401 to force a refresh/re-login). */
  invalidate() {}
  /** Release any resources (e.g. a browser). No-op by default. */
  async close() {}
}

/**
 * DEFAULT provider: SimpleJWT HTTP login. Pure fetch, container-friendly (no browser).
 *   POST {baseUrl}/api/token/          {username,password} -> {access, refresh}
 *   POST {baseUrl}/api/token/refresh/  {refresh}           -> {access}
 */
class HttpLoginAuthProvider extends MangoAuthProvider {
  constructor(opts = {}) {
    super();
    this.baseUrl = (opts.baseUrl || config.api.baseUrl).replace(/\/+$/, '');
    this.username = opts.username || config.auth.username;
    this.password = opts.password || config.auth.password;
    this._access = null;
    this._refresh = null;
    this._inFlight = null;
  }

  invalidate() { this._access = null; } // keep refresh for a cheap re-mint

  async getToken() {
    if (this._access) return `Bearer ${this._access}`;
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._acquire().finally(() => { this._inFlight = null; });
    return this._inFlight;
  }

  async _acquire() {
    // Prefer a refresh (no password on the wire) when we have one.
    if (this._refresh) {
      try {
        const r = await fetch(`${this.baseUrl}/api/token/refresh/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ refresh: this._refresh }),
        });
        if (r.ok) {
          const j = await r.json();
          if (j && j.access) { this._access = j.access; return `Bearer ${this._access}`; }
        }
      } catch (_) { /* fall through to full login */ }
      this._refresh = null;
    }

    if (!this.username || !this.password) {
      throw new Error('Mango credentials not configured (MANGO_USERNAME / MANGO_PASSWORD).');
    }
    const res = await fetch(`${this.baseUrl}/api/token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch (_) {}
      throw new Error(`Mango login failed: ${res.status} ${detail}`);
    }
    const j = await res.json();
    if (!j || !j.access) throw new Error('Mango login: no access token in response');
    this._access = j.access;
    this._refresh = j.refresh || null;
    return `Bearer ${this._access}`;
  }
}

/**
 * Fallback provider: harvest the SPA's Bearer from a Puppeteer login session. Requires
 * Chromium — NOT available in the lean API container. Kept for local/diagnostic use and
 * environments where the HTTP login endpoint is unavailable. mangoScraper is required
 * lazily so the default (HTTP) path never loads Puppeteer.
 */
class BrowserSessionAuthProvider extends MangoAuthProvider {
  constructor() {
    super();
    this._token = null;
    this._inFlight = null;
  }

  invalidate() {
    this._token = null;
    try { require('./mangoScraper').isLoggedIn = false; } catch (_) {}
  }

  async close() {
    try { await require('./mangoScraper').close(); } catch (_) {}
  }

  async getToken() {
    if (this._token) return this._token;
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._harvest().finally(() => { this._inFlight = null; });
    return this._inFlight;
  }

  async _harvest() {
    const mangoScraper = require('./mangoScraper');
    await mangoScraper.login();
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
      await page.goto(`${config.portal.baseUrl}/`, { waitUntil: 'networkidle2' }).catch(() => {});
      if (page.url().includes('select-pbx')) await mangoScraper.selectFirstPbxIfNeeded().catch(() => {});
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
   * @param {MangoAuthProvider} [authProvider] defaults to HttpLoginAuthProvider
   * @param {{ baseUrl?: string }} [opts]
   */
  constructor(authProvider, opts = {}) {
    this.auth = authProvider || new HttpLoginAuthProvider();
    this.baseUrl = (opts.baseUrl || config.api.baseUrl).replace(/\/+$/, '');
  }

  /**
   * Authenticated JSON request. On 401, invalidate + re-acquire the token and retry once.
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

  /** Release auth resources (browser, if any). */
  async close() {
    if (this.auth && typeof this.auth.close === 'function') await this.auth.close();
  }

  /**
   * Fetch recent calls, normalize, and transcribe recordings inline (D3 discard).
   * Mirrors the contract syncScheduler expects from the retired scraper's fullSync,
   * except transcription happens here (the signed recording_url expires quickly).
   *
   * INGESTION IS WATERMARKED (diagnosis H3). The backwards walk stops when it crosses
   * `watermark − OVERLAP`, not after a fixed number of calls, so a busy hour can no longer
   * saturate a 25-call cap and drop the remainder on the floor. `maxCalls`
   * (MANGO_MAX_CALLS_PER_SYNC) therefore no longer truncates a watermarked walk — that
   * truncation WAS the defect. It still bounds the COLD-START pull, where there is no
   * floor to stop at and we are deliberately not backfilling history.
   *
   * The watermark advances on successful INGESTION only, never on transcription outcome:
   * a call that was ingested but not transcribed keeps its row and stays transcribable
   * later. That is the seam M4's on-demand transcribe button is built on.
   *
   * @param {{ sinceDays?: number, maxCalls?: number }} [options]
   */
  async fullSync(options = {}) {
    const sinceDays = options.sinceDays || 1;
    const maxCalls = options.maxCalls || 100;
    const maxPages = ingestionWatermark.MAX_PAGES;

    const maxSkipPages = ingestionWatermark.MAX_SKIP_PAGES;

    const watermarkBefore = ingestionWatermark.get().startedAt;
    const wmFloor = ingestionWatermark.floorMs();
    const coldStart = wmFloor === null;
    const floorMs = coldStart ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : wmFloor;

    // An unfetched range a previous truncated walk left behind. While one is open the walk
    // keeps paging past the floor to drain it, and stops at its older bound instead.
    const gap = coldStart ? null : ingestionWatermark.getGap();
    const gapFromMs = gap ? Date.parse(gap.from) : null;
    const gapToMs = gap ? Date.parse(gap.to) : null;
    const stopMs = gap ? Math.min(floorMs, gapFromMs) : floorMs;

    const result = {
      success: false,
      calls_found: 0,
      calls_processed: 0,
      recordings_transcribed: 0,
      recordings_reused: 0,             // transcript already in the store → not re-sent to Speech
      transcription_skipped_auto_off: 0, // eligible, but automatic transcription is off (M4)
      transcription_skipped_budget: 0,  // skipped because the daily budget was spent
      recordings_missing: 0,            // Mango had no recording_url at fetch time
      calls: [],
      errors: [],
      // Watermark / walk telemetry (read by the admin sync history + the summary log).
      cold_start: coldStart,
      watermark_before: watermarkBefore,
      watermark_after: watermarkBefore,
      walk_complete: false,
      pages_fetched: 0,
      calls_scanned: 0,
      page_cap_hit: false,
      // Backlog drainage (a previous truncated walk's unfetched range).
      gap_before: gap,
      gap_after: gap,
      gap_calls_ingested: 0,
      skip_pages: 0,
      skip_cap_hit: false,
      // Per-office breakdown (item 5) + the count of calls whose `to` party had no DID.
      by_office: {},
      no_did: 0,
    };
    let budgetLogged = false; // log the "budget reached" line at most once per run
    let autoOffLogged = false; // ditto for the "automatic transcription is off" line

    if (coldStart) {
      console.log(
        `📞 Mango API sync: INITIALIZING — no ingestion watermark stored yet, falling back to the ` +
        `last ${sinceDays}d (up to ${maxCalls} calls). Older history is NOT backfilled.`
      );
    } else if (gap) {
      console.warn(
        `📞 Mango API sync: walking back to ${new Date(floorMs).toISOString()} ` +
        `(watermark ${watermarkBefore} − ${ingestionWatermark.OVERLAP_MINUTES}m overlap), then DRAINING ` +
        `the backlog gap ${gap.from} → ${gap.to} left by an earlier truncated walk...`
      );
    } else {
      console.log(
        `📞 Mango API sync: walking back to ${new Date(floorMs).toISOString()} ` +
        `(watermark ${watermarkBefore} − ${ingestionWatermark.OVERLAP_MINUTES}m overlap)...`
      );
    }

    // ── Backwards walk: /calls/ newest-first until we cross the stop boundary ──────────
    // Rows above the floor are ingested (the normal window). With a gap open the walk
    // continues past the floor: rows between the gap and the floor are ALREADY ingested,
    // so they are skipped on a separate page budget, and rows inside the gap are ingested.
    // Three independent page budgets. The normal window, the already-covered skip region,
    // and the gap drain each get their own — a shared budget starves whichever comes last
    // in the walk, which is always the drain, so the backlog would never move.
    const raw = [];
    let offset = 0;
    let reachedStop = false;
    let coldStartCapped = false;
    let listCount = null;
    let oldestScannedAt = null;
    let normalPages = 0;
    let gapPages = 0;

    while (normalPages < maxPages && gapPages < maxPages && result.skip_pages < maxSkipPages) {
      let page;
      try {
        page = await this.listCalls({ limit: PAGE_SIZE, offset });
      } catch (e) {
        result.errors.push(`listCalls offset=${offset}: ${e.message}`);
        break; // walk incomplete → the unfetched remainder is recorded as a gap below
      }
      result.pages_fetched++;
      if (typeof page.count === 'number') listCount = page.count;

      if (!page.results.length) { reachedStop = true; break; } // list exhausted

      let pageHadNormal = false;
      let pageHadGap = false;
      for (const c of page.results) {
        result.calls_scanned++;
        const started = c.started_at ? Date.parse(c.started_at) : NaN;
        if (Number.isFinite(started)) oldestScannedAt = started;
        if (Number.isFinite(started) && started < stopMs) { reachedStop = true; break; }

        // Already covered by an earlier run: below the floor but above the gap. Costs a
        // list row and nothing else.
        if (gap !== null && Number.isFinite(started) && started < floorMs && started > gapToMs) {
          continue;
        }

        const inGap = gap !== null && Number.isFinite(started) && started <= gapToMs;
        if (inGap) pageHadGap = true; else pageHadNormal = true;

        if (isIngestibleCall(c)) {
          raw.push(c);
          if (inGap) result.gap_calls_ingested++;
        }
        // Cold start has no floor to stop at — bound it by maxCalls and move on.
        if (coldStart && raw.length >= maxCalls) { coldStartCapped = true; break; }
      }

      // Charge the page to whichever budget it actually consumed.
      if (pageHadNormal) normalPages++;
      else if (pageHadGap) gapPages++;
      else result.skip_pages++;

      if (reachedStop || coldStartCapped) break;
      if (page.results.length < PAGE_SIZE) { reachedStop = true; break; } // list exhausted

      offset += page.results.length;
      await sleep(300); // be polite
    }

    result.walk_complete = reachedStop;
    result.skip_cap_hit = !reachedStop && !coldStartCapped && result.skip_pages >= maxSkipPages;
    result.page_cap_hit = !reachedStop && !coldStartCapped && !result.skip_cap_hit
      && (normalPages >= maxPages || gapPages >= maxPages);

    if (result.page_cap_hit || result.skip_cap_hit) {
      // NEVER truncate silently. The region from oldestScanned up to now IS covered, so
      // the watermark still advances (below) — what we owe is recorded as an explicit gap
      // that later syncs drain from its newest end downward.
      const remaining = Number.isFinite(listCount) ? listCount - result.calls_scanned : null;
      console.error(
        `⛔ Mango sync: ${result.skip_cap_hit ? 'SKIP CAP' : 'PAGE CAP'} HIT — ${result.pages_fetched} pages / ` +
        `${result.calls_scanned} calls scanned (${result.skip_pages} skip page(s)) without reaching ` +
        `${new Date(stopMs).toISOString()}. Oldest scanned ` +
        `${oldestScannedAt ? new Date(oldestScannedAt).toISOString() : 'unknown'}; ` +
        `up to ${remaining === null ? 'unknown' : remaining} older calls left UNFETCHED this run — ` +
        'RECORDED AS A GAP and drained by later syncs, not dropped. Raise ' +
        `${result.skip_cap_hit ? 'MANGO_SYNC_MAX_SKIP_PAGES' : 'MANGO_SYNC_MAX_PAGES'} if this repeats.`
      );
    }

    result.calls_found = raw.length;
    const canTranscribe = transcriptionService.isAvailable();

    // ── Normalize + transcribe ────────────────────────────────────────────────────────
    let newestIngestedMs = null;

    for (const c of raw) {
      let call;
      try {
        call = normalizeMangoCall(c);
      } catch (e) {
        result.errors.push(`normalize ${c && c.id}: ${e.message}`);
        continue; // NOT ingested → must not pull the watermark past it
      }

      // Office key for counters/logging (item 5). getOfficeForCall is a pure function of
      // called_number, which normalizeMangoCall just computed. Attached to the in-flight
      // object only — unifiedCallStore.normalizeCall is a field whitelist, so this never
      // reaches the stored record and office stays a read-time derivation (diagnosis H5).
      const office = getOfficeForCall(call);
      call.office_id = office;
      const oc = result.by_office[office] || (result.by_office[office] = blankOfficeCounters());
      oc.ingested++;
      // The `'(no-line)'` warn in officeAgents fires once per PROCESS, which hid the real
      // count. Count it per sync: a `to` party from which no usable DID could be pulled.
      if (normalizeE164(call.called_number) === null) result.no_did++;

      // DEDUP GUARD (cost-investigation #2/#4): if this call already has a transcript in
      // the store, REUSE it — never re-send the same recording to Azure Speech. Without
      // this, every poll of the rolling window re-transcribed the same answered calls (the
      // root cause of the ~$60 re-transcription loop). The store is consulted by
      // external_id, which the upsert preserves across re-syncs — and which also makes
      // re-ingesting inside the watermark overlap free.
      const existing = unifiedCallStore.findByExternalId(call.external_id);
      if (existing && existing.transcript) {
        call.transcript = existing.transcript;
        call.transcript_json = existing.transcript_json || null;
        result.recordings_reused++;
        oc.reused++;
      } else if (!canTranscribe) {
        oc.unavailable++;
      } else if (c.is_missed) {
        oc.missed++;
      } else if ((call.duration_seconds || 0) < MIN_TRANSCRIBE_SECONDS) {
        oc.too_short++;
      } else if (!config.autoTranscribe) {
        // AUTO-TRANSCRIBE VALVE (M4, D1-REVISED). Off by default: ingest the call fully —
        // watermark, counters, worklist row, everything M3 does — and simply do not send it
        // to Azure Speech. A human decides per call, from the dashboard button.
        //
        // Counted SEPARATELY from budget_skipped on purpose. Both mean "ingested, not
        // transcribed", but one is a policy and the other is a breaker firing; collapsing
        // them would make a spent budget invisible in the logs. And this branch sits AFTER
        // the missed / too-short / unavailable classifications so `auto_off` is exactly the
        // set of calls automatic transcription WOULD have billed — i.e. the answer to
        // "what is the valve saving us?"
        result.transcription_skipped_auto_off++;
        oc.auto_off++;
        if (!autoOffLogged) {
          autoOffLogged = true;
          console.log(
            '⏸️  Mango sync: automatic transcription is OFF (MANGO_AUTO_TRANSCRIBE unset/false) — ' +
            'ingesting call metadata only. Transcribe from the dashboard button per call.'
          );
        }
      } else {
        // CIRCUIT BREAKER (#2c): once the daily audio-minute budget is spent, stop
        // transcribing but keep ingesting metadata, so a dedup regression can never bill
        // unbounded again. The call keeps its row and stays transcribable later (M4).
        const budget = transcriptionService.checkDailyBudget();
        if (!budget.allowed) {
          if (!budgetLogged) {
            budgetLogged = true;
            console.warn(
              `⛔ Mango sync: transcription daily budget reached (${budget.usedMinutes.toFixed(0)}/${budget.capMinutes} min) — ` +
              'ingesting call metadata only for the rest of today.'
            );
          }
          result.transcription_skipped_budget++;
          oc.budget_skipped++;
        } else {
          try {
            const detail = await this.getCall(c.id);
            const rec = detail && detail.recording_url;
            if (rec && typeof rec === 'string') {
              const tr = await transcriptionService.transcribeUrl(rec); // in-memory; discarded
              if (tr && tr.text) {
                call.transcript = tr.text;
                // Canonical shape at the source — see utils/transcriptShape.js.
                call.transcript_json = normalizeTranscriptJson(tr.utterances || tr.words);
                result.recordings_transcribed++;
                oc.transcribed++;
              } else {
                oc.empty++;
              }
            } else {
              // Previously a SILENT fall-through (diagnosis H7): no log, no error, no
              // counter, indistinguishable from "wasn't eligible". Now counted and aged.
              result.recordings_missing++;
              oc.no_recording++;
              oc.no_recording_age[noRecordingAgeBucket(c.started_at, Date.now())]++;
            }
          } catch (e) {
            // A budget-exceeded backstop throw also lands here; record and move on.
            result.errors.push(`transcribe ${c.id}: ${e.message}`);
            oc.errors++;
          }
        }
      }

      result.calls.push(call);
      result.calls_processed++;

      // Watermark candidate: newest SUCCESSFULLY INGESTED call. Deliberately independent
      // of whether it got a transcript — see the contract in ingestionWatermark.js.
      const startedMs = call.call_date ? Date.parse(call.call_date) : NaN;
      if (Number.isFinite(startedMs) && (newestIngestedMs === null || startedMs > newestIngestedMs)) {
        newestIngestedMs = startedMs;
      }
    }

    // The region from `oldestScannedAt` up to the newest call is contiguous whether or not
    // the walk finished, so the watermark advances either way. What a truncated walk owes
    // is recorded as a gap instead of being papered over by holding the watermark — holding
    // it does NOT work, because the next walk restarts from the newest call, so new
    // arrivals push its reach forward and the unfetched range widens every sync.
    if (newestIngestedMs !== null) {
      result.watermark_after = ingestionWatermark.advance(new Date(newestIngestedMs).toISOString());
    }

    if (reachedStop) {
      // Crossed the stop boundary — which IS the gap's older bound whenever one was open.
      if (gap) {
        result.gap_after = ingestionWatermark.closeGap();
        console.log(
          `✅ Mango sync: backlog gap ${gap.from} → ${gap.to} fully drained ` +
          `(${result.gap_calls_ingested} call(s) recovered from it this run).`
        );
      }
    } else if (!coldStartCapped && oldestScannedAt !== null) {
      result.gap_after = ingestionWatermark.openOrExtendGap(stopMs, oldestScannedAt);
      if (result.gap_after) {
        console.warn(
          `📌 Mango sync: unfetched backlog now recorded as ${result.gap_after.from} → ${result.gap_after.to}` +
          (gap ? ` (drained ${result.gap_calls_ingested} call(s) from it this run)` : '') +
          '. Later syncs continue draining it from the newest end down.'
        );
      }
    }

    result.success = true;
    this._logSyncSummary(result);
    return result;
  }

  /**
   * Sync summary — one aggregate line, then ONE LINE PER OFFICE so "is Riley
   * disproportionate?" is answerable straight from Log Analytics. Strictly aggregate:
   * no call ids, no caller numbers, no content, and no DID beyond the office key itself.
   * @param {object} result the fullSync result
   */
  _logSyncSummary(result) {
    console.log(
      `✅ Mango API sync: found ${result.calls_found}, transcribed ${result.recordings_transcribed}, ` +
      `reused ${result.recordings_reused}, auto-off ${result.transcription_skipped_auto_off}, ` +
      `budget-skipped ${result.transcription_skipped_budget}, ` +
      `no-recording ${result.recordings_missing}, errors ${result.errors.length} ` +
      `| scanned ${result.calls_scanned} over ${result.pages_fetched} page(s) ` +
      `(${result.skip_pages} skip), walk ${result.walk_complete ? 'complete' : 'INCOMPLETE'}, ` +
      `watermark ${result.watermark_after}` +
      (result.gap_after
        ? `, BACKLOG GAP OPEN ${result.gap_after.from} → ${result.gap_after.to} (drained ${result.gap_calls_ingested} this run)`
        : '')
    );

    const keys = [
      ...OFFICE_LOG_ORDER.filter((k) => result.by_office[k]),
      ...Object.keys(result.by_office).filter((k) => !OFFICE_LOG_ORDER.includes(k)),
    ];
    for (const key of keys) {
      const o = result.by_office[key];
      const age = o.no_recording_age;
      console.log(
        `📊 Mango sync[${key}]: ingested ${o.ingested}, transcribed ${o.transcribed}, ` +
        `reused ${o.reused}, auto-off ${o.auto_off}, budget-skipped ${o.budget_skipped}, ` +
        `no-recording ${o.no_recording} (age at fetch: <15m ${age.lt15m}, 15-60m ${age.m15to60}, ` +
        `>60m ${age.gt60m}, unknown ${age.unknown}), ` +
        `missed ${o.missed}, too-short ${o.too_short}, errors ${o.errors}, ` +
        `unavailable ${o.unavailable}, empty ${o.empty}`
      );
    }

    if (result.no_did > 0) {
      console.warn(
        `📊 Mango sync: ${result.no_did} call(s) this sync had no usable DID on the office side ` +
        "(ring group / IVR / user object instead of a number) → bucketed to 'unknown'."
      );
    }
  }
}

// Default singleton (HTTP-login auth). Exports the classes too for testing / future swap.
module.exports = new MangoApiClient();
module.exports.MangoApiClient = MangoApiClient;
module.exports.MangoAuthProvider = MangoAuthProvider;
module.exports.HttpLoginAuthProvider = HttpLoginAuthProvider;
module.exports.BrowserSessionAuthProvider = BrowserSessionAuthProvider;
