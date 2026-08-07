/**
 * Transcription Service
 *
 * PROVIDER (PRD D3 — HIPAA): audio transcription runs on **Azure AI Speech**
 * (Fast Transcription API, diarization on), covered by Microsoft's BAA in the Azure
 * Product Terms. Managed-identity auth is preferred (the container apps run with a
 * user-assigned MI); an API key from Key Vault is the fallback. Config comes from
 * AZURE_SPEECH_* env, provisioned separately (spch-carein-staging).
 *
 * ⚠️ COMPLIANCE: Deepgram has NO BAA and MUST NOT touch real recording audio. The former
 * Deepgram path has been removed entirely. When Azure Speech is not configured, this
 * service degrades to "unavailable" (callers skip transcription) — it never routes audio
 * to a BAA-less provider.
 *
 * Seam is unchanged for callers: transcribeFile / transcribeUrl return
 * { text, words, utterances, duration_seconds, confidence, paragraphs }.
 */

const fs = require('fs').promises;
const path = require('path');
const { KNOWN_VOCABULARY, applyCorrections } = require('../config/mangoVocabulary');
const { DurableState } = require('./durableState');

// Timezone the daily audio-minute budget is accounted in. MUST be the offices' local zone,
// not UTC: UTC midnight is 7:00 PM CDT, so a UTC day rolled the budget in the middle of the
// evening and the 7:15 PM sync spent 35-40% of the next business day's budget on the
// PREVIOUS evening's calls before the office even opened (diagnosis H1/§3b). Resolved with
// Intl (real DST-aware zone data) — never a hardcoded -5/-6 offset.
const BUDGET_TIMEZONE = process.env.TRANSCRIPTION_BUDGET_TZ || 'America/Chicago';

// Cognitive Services token audience for Entra/MI auth against Azure AI Speech.
const AZURE_SPEECH_SCOPE = 'https://cognitiveservices.azure.com/.default';
// Fast Transcription API version (synchronous, multipart audio, diarization supported).
// 2025-10-15 is the first version that supports `phraseList` for vocabulary biasing
// (item 3c) — used to bias toward office/staff names (KNOWN_VOCABULARY).
const FAST_TRANSCRIPTION_API_VERSION = '2025-10-15';

class TranscriptionService {
  constructor() {
    this.isInitialized = false;
    this.provider = null;      // 'azure' | null
    this.authMode = null;      // 'managed_identity' | 'api_key' | null
    this.endpoint = null;      // https://<name>.cognitiveservices.azure.com
    this.apiKey = null;        // only when authMode === 'api_key'
    this.credential = null;    // ManagedIdentityCredential, only when MI
    this.locales = ['en-US'];
    this.maxSpeakers = 2;      // front-desk staff + patient
    this.stats = {
      totalTranscriptions: 0,
      totalMinutes: 0,
      totalCost: 0,
    };

    // ── Daily circuit breaker (cost guardrail, cost-investigation #2c) ──────────────
    // Caps audio-minutes sent to Azure Speech per LOCAL (America/Chicago) day. When
    // exceeded, callers skip transcription and keep ingesting call metadata — so no dedup
    // regression or retry loop can ever bill unbounded again. Default 120 min/day. Set the
    // env to 0 to disable. The 120 is deliberately unchanged here: it is structurally
    // undersized for transcribe-every-call, and M4 removes that demand by making
    // transcription an explicit, human-triggered decision.
    this.dailyBudgetMinutes = (() => {
      const raw = process.env.MAX_TRANSCRIPTION_MINUTES_PER_DAY;
      if (raw === undefined || raw === '') return 120;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : 120;
    })();
    this.budgetTimezone = BUDGET_TIMEZONE;
    this.dailyKey = null;            // 'YYYY-MM-DD' in budgetTimezone
    this.dailyMinutes = 0;           // audio-minutes transcribed so far today
    this.dailyBudgetTripped = false; // whether we've logged the "budget reached" line today
    // Accounting survives a restart (diagnosis H11): an in-memory counter handed back a
    // fresh 120 minutes every time the container recycled mid-day. Degrades to in-memory
    // with one log line where there is no durable volume (staging) — never blocks startup.
    this._dailyState = new DurableState('transcription_budget.json', { day_key: null, minutes_used: 0 });
    this._dailyLoaded = false;
  }

  /**
   * Day key 'YYYY-MM-DD' in the budget timezone. DST-correct via Intl zone data (en-CA
   * formats as YYYY-MM-DD); a fixed -5/-6 offset would be wrong for half the year.
   * @param {Date} [now] injectable for tests
   */
  _todayKey(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.budgetTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }

  /** Load persisted {dayKey, minutesUsed} once per process (best-effort). */
  _loadDailyState() {
    if (this._dailyLoaded) return;
    this._dailyLoaded = true;
    const doc = this._dailyState.read();
    const key = typeof doc.day_key === 'string' ? doc.day_key : null;
    const used = Number(doc.minutes_used);
    if (key && Number.isFinite(used) && used >= 0) {
      this.dailyKey = key;
      this.dailyMinutes = used;
    }
  }

  /** Persist the current day's accounting (best-effort; never throws). */
  _saveDailyState() {
    this._dailyState.write({ day_key: this.dailyKey, minutes_used: Number(this.dailyMinutes.toFixed(3)) });
  }

  /** Reset the daily transcription counters when the local accounting day rolls over. */
  _rollDailyIfNeeded() {
    this._loadDailyState();
    const today = this._todayKey();
    if (this.dailyKey !== today) {
      this.dailyKey = today;
      this.dailyMinutes = 0;
      this.dailyBudgetTripped = false;
      this._saveDailyState();
    }
  }

  /**
   * The instant the daily budget next rolls over — the NEXT midnight in the budget
   * timezone, as an ISO string. M4's on-demand endpoint hands this to the user so
   * "budget is used up" can say WHEN it resets instead of just refusing.
   *
   * DST-correct by construction: we jump forward by the remaining wall-clock seconds of
   * the local day, then re-read the local time at that instant and correct — on a spring
   * -forward / fall-back day the naive jump lands at 01:00 / 23:00 local, and the
   * correction pulls it onto midnight. Bounded to 3 iterations (one is always enough).
   * @param {Date} [now] injectable for tests
   * @returns {string} ISO-8601 timestamp of the next local midnight
   */
  nextBudgetResetIso(now = new Date()) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.budgetTimezone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    // Seconds elapsed in the local day at instant `d`.
    const localSeconds = (d) => {
      const [h, m, s] = fmt.format(d).split(':').map(Number);
      return h * 3600 + m * 60 + s;
    };

    const DAY = 24 * 3600;
    let ms = now.getTime() + (DAY - localSeconds(now)) * 1000;
    for (let i = 0; i < 3; i++) {
      const off = localSeconds(new Date(ms));
      if (off === 0) break;
      // off near the end of the day => we landed BEFORE midnight, push forward;
      // otherwise we overshot past midnight, pull back.
      ms += (off > DAY / 2 ? DAY - off : -off) * 1000;
    }
    return new Date(ms).toISOString();
  }

  /**
   * Circuit-breaker check. Callers MUST consult this before transcribing so they can skip
   * cleanly (and keep ingesting metadata) rather than bill Azure Speech unbounded. A hard
   * backstop in transcribeBuffer enforces the same cap even if a caller forgets.
   * @returns {{allowed: boolean, usedMinutes: number, capMinutes: number, remainingMinutes: number}}
   */
  checkDailyBudget() {
    this._rollDailyIfNeeded();
    const cap = this.dailyBudgetMinutes;
    const allowed = cap <= 0 || this.dailyMinutes < cap; // cap<=0 => unlimited
    return {
      allowed,
      usedMinutes: this.dailyMinutes,
      capMinutes: cap,
      remainingMinutes: cap <= 0 ? Infinity : Math.max(0, cap - this.dailyMinutes),
    };
  }

  /**
   * Initialize the Azure AI Speech client config. Order:
   *   1. Managed identity (preferred, no secret) unless AZURE_SPEECH_AUTH_MODE=api_key.
   *   2. API key (from Key Vault as azure-speech-key) when AUTH_MODE=api_key and key present.
   *   3. Otherwise unconfigured → isAvailable() false → callers skip transcription.
   * Never falls back to a BAA-less provider.
   */
  initialize() {
    // Endpoint may be given directly, or derived from a region.
    const rawEndpoint = process.env.AZURE_SPEECH_ENDPOINT;
    const region = process.env.AZURE_SPEECH_REGION;
    const endpoint = rawEndpoint
      ? rawEndpoint.replace(/\/+$/, '')
      : (region ? `https://${region}.api.cognitive.microsoft.com` : null);

    if (!endpoint) {
      console.warn(
        '⚠️ Azure AI Speech not configured (AZURE_SPEECH_ENDPOINT/AZURE_SPEECH_REGION missing). ' +
        'Transcription unavailable — calls will not be transcribed (Deepgram is never used).'
      );
      return false;
    }

    if (process.env.AZURE_SPEECH_LOCALES) {
      this.locales = process.env.AZURE_SPEECH_LOCALES.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (process.env.AZURE_SPEECH_MAX_SPEAKERS) {
      const n = parseInt(process.env.AZURE_SPEECH_MAX_SPEAKERS, 10);
      if (Number.isFinite(n) && n >= 1) this.maxSpeakers = n;
    }

    try {
      const authMode = process.env.AZURE_SPEECH_AUTH_MODE || 'managed_identity';
      const useKey = authMode === 'api_key' && !!process.env.AZURE_SPEECH_API_KEY;

      if (useKey) {
        this.authMode = 'api_key';
        this.apiKey = process.env.AZURE_SPEECH_API_KEY;
        console.log('✅ Transcription service initialized (Azure AI Speech, api-key)');
      } else {
        // Preferred: managed identity — no secret. Reuses the container app's MI.
        const { ManagedIdentityCredential } = require('@azure/identity');
        const clientId = process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;
        this.credential = new ManagedIdentityCredential(clientId ? { clientId } : {});
        this.authMode = 'managed_identity';
        console.log('✅ Transcription service initialized (Azure AI Speech, managed identity)');
      }

      this.endpoint = endpoint;
      this.provider = 'azure';
      this.isInitialized = true;
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize Azure AI Speech:', error.message);
      return false;
    }
  }

  /**
   * Resolve the auth header for a Fast Transcription request.
   * @returns {Promise<Record<string,string>>}
   */
  async getAuthHeader() {
    if (this.authMode === 'api_key') {
      return { 'Ocp-Apim-Subscription-Key': this.apiKey };
    }
    // Managed identity — acquire an Entra token for the Cognitive Services audience.
    const token = await this.credential.getToken(AZURE_SPEECH_SCOPE);
    if (!token || !token.token) {
      throw new Error('Failed to acquire managed-identity token for Azure AI Speech');
    }
    return { Authorization: `Bearer ${token.token}` };
  }

  /**
   * Transcribe an audio file from local disk.
   * @param {string} filePath - Path to the audio file
   * @param {Object} options - { locales?, maxSpeakers? }
   */
  async transcribeFile(filePath, options = {}) {
    if (!this.isInitialized) this.initialize();
    if (!this.provider) {
      throw new Error('Transcription service not available. Configure AZURE_SPEECH_ENDPOINT (+ MI or AZURE_SPEECH_API_KEY).');
    }
    console.log(`🎤 Transcribing file (Azure Speech): ${path.basename(filePath)}`);
    const audioBuffer = await fs.readFile(filePath);
    return this.transcribeBuffer(audioBuffer, path.basename(filePath), options);
  }

  /**
   * Transcribe audio from a URL (e.g. a signed Mango recording_url). Downloads the
   * bytes then submits them to Fast Transcription. The buffer is not persisted here.
   * @param {string} url - URL of the audio file
   * @param {Object} options - { locales?, maxSpeakers? }
   */
  async transcribeUrl(url, options = {}) {
    if (!this.isInitialized) this.initialize();
    if (!this.provider) {
      throw new Error('Transcription service not available. Configure AZURE_SPEECH_ENDPOINT (+ MI or AZURE_SPEECH_API_KEY).');
    }
    console.log('🎤 Transcribing from URL (Azure Speech)...');
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) {
      throw new Error(`Audio fetch failed: ${resp.status} ${resp.statusText}`);
    }
    const ab = await resp.arrayBuffer();
    const name = (() => {
      try { return path.basename(new URL(url).pathname) || 'audio.mp3'; } catch { return 'audio.mp3'; }
    })();
    return this.transcribeBuffer(Buffer.from(ab), name, options);
  }

  /**
   * Submit an audio buffer to Azure Fast Transcription and normalize the result.
   * @param {Buffer} audioBuffer
   * @param {string} filename
   * @param {Object} options - { locales?, maxSpeakers? }
   */
  async transcribeBuffer(audioBuffer, filename = 'audio.mp3', options = {}) {
    if (!this.isInitialized) this.initialize();
    if (!this.provider) {
      throw new Error('Transcription service not available. Configure Azure AI Speech.');
    }

    // Hard circuit-breaker backstop (cost-investigation #2c): never exceed the daily
    // audio-minute budget. Callers SHOULD check checkDailyBudget() first and skip
    // gracefully, but enforce here too so no code path can bill Azure Speech unbounded.
    const budget = this.checkDailyBudget();
    if (!budget.allowed) {
      if (!this.dailyBudgetTripped) {
        this.dailyBudgetTripped = true;
        console.warn(
          `⛔ Transcription daily budget reached (${budget.usedMinutes.toFixed(0)}/${budget.capMinutes} min for ${this.dailyKey} ${this.budgetTimezone}). ` +
          'Halting transcription for the day; call metadata still ingests. Override with MAX_TRANSCRIPTION_MINUTES_PER_DAY.'
        );
      }
      const err = new Error(`Transcription daily budget exceeded (${budget.capMinutes} min/day)`);
      err.code = 'TRANSCRIPTION_BUDGET_EXCEEDED';
      throw err;
    }

    const locales = options.locales || this.locales;
    const maxSpeakers = options.maxSpeakers || this.maxSpeakers;

    const definition = {
      locales,
      // Diarization separates staff vs patient turns.
      diarization: { enabled: true, maxSpeakers },
      profanityFilterMode: 'None',
      // Vocabulary biasing (item 3c) — steers the engine toward office/staff names so it
      // hears "Roland" not "Rowland", etc. Supported on api-version 2025-10-15+.
      phraseList: { phrases: [...KNOWN_VOCABULARY] },
    };

    const form = new FormData();
    // Node 22: global FormData/Blob. The audio part must be a Blob/File.
    form.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), filename);
    form.append('definition', JSON.stringify(definition));

    const authHeader = await this.getAuthHeader();
    const url = `${this.endpoint}/speechtotext/transcriptions:transcribe?api-version=${FAST_TRANSCRIPTION_API_VERSION}`;

    const startTime = Date.now();
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { ...authHeader }, body: form });
    } catch (error) {
      console.error('❌ Azure Speech request failed:', error.message);
      throw error;
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 500); } catch (_) {}
      throw new Error(`Azure Speech transcription failed: ${res.status} ${res.statusText} ${detail}`);
    }

    const result = await res.json();
    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const transcript = this.processTranscriptResult(result);

    if (transcript.duration_seconds) {
      this.stats.totalTranscriptions++;
      this.stats.totalMinutes += transcript.duration_seconds / 60;
      // Azure AI Speech standard (S0) ≈ $1 / audio hour.
      this.stats.totalCost += (transcript.duration_seconds / 60) * (1 / 60);
      // Daily circuit-breaker accounting: count the audio-minutes actually transcribed,
      // and persist so a container restart cannot hand back a fresh budget mid-day (H11).
      this._rollDailyIfNeeded();
      this.dailyMinutes += transcript.duration_seconds / 60;
      this._saveDailyState();
    }

    console.log(`✅ Azure Speech transcription complete in ${durationSec}s`);
    return transcript;
  }

  /**
   * Normalize a Fast Transcription response into our standard shape.
   * Azure returns: { durationMilliseconds, combinedPhrases:[{text}], phrases:[{ text,
   * speaker, offsetMilliseconds, durationMilliseconds, confidence, words:[...] }] }
   */
  processTranscriptResult(result) {
    if (!result || (!result.combinedPhrases && !result.phrases)) {
      return { text: '', words: [], utterances: [], duration_seconds: 0, confidence: null, paragraphs: [] };
    }

    const combined = Array.isArray(result.combinedPhrases) ? result.combinedPhrases : [];
    // Deterministic spelling corrections (item 3b) on the recognized transcript text —
    // office-name only (see mangoVocabulary), a backstop to the phrase-list biasing (3c).
    const text = applyCorrections(
      combined.map((c) => c.text).filter(Boolean).join(' ').trim()
      || (Array.isArray(result.phrases) ? result.phrases.map((p) => p.text).filter(Boolean).join(' ').trim() : '')
    );

    const phrases = Array.isArray(result.phrases) ? result.phrases : [];

    // Utterances: one per diarized phrase (speaker-separated segments).
    const utterances = phrases.map((p) => ({
      speaker: typeof p.speaker === 'number' ? p.speaker : 0,
      text: applyCorrections(p.text || ''),
      start: (p.offsetMilliseconds || 0) / 1000,
      end: ((p.offsetMilliseconds || 0) + (p.durationMilliseconds || 0)) / 1000,
      confidence: p.confidence,
    }));

    // Flatten word-level timing when present.
    const words = [];
    for (const p of phrases) {
      if (Array.isArray(p.words)) {
        for (const w of p.words) {
          words.push({
            word: w.text,
            start: (w.offsetMilliseconds || 0) / 1000,
            end: ((w.offsetMilliseconds || 0) + (w.durationMilliseconds || 0)) / 1000,
            confidence: w.confidence,
            speaker: typeof p.speaker === 'number' ? p.speaker : undefined,
          });
        }
      }
    }

    const durationMs = result.durationMilliseconds
      || (phrases.length ? (phrases[phrases.length - 1].offsetMilliseconds || 0) + (phrases[phrases.length - 1].durationMilliseconds || 0) : 0);

    // Average phrase confidence as an overall read.
    const confVals = phrases.map((p) => p.confidence).filter((c) => typeof c === 'number');
    const confidence = confVals.length ? confVals.reduce((a, b) => a + b, 0) / confVals.length : null;

    return {
      text,
      words,
      utterances,
      duration_seconds: Math.round(durationMs / 1000),
      confidence,
      paragraphs: [],
    };
  }

  /**
   * Format transcript as chat-style conversation (speaker-labeled).
   */
  formatAsConversation(transcript) {
    if (!transcript || !transcript.utterances || transcript.utterances.length === 0) {
      return transcript ? transcript.text : '';
    }
    return transcript.utterances.map((utt) => {
      const speaker = `Speaker ${(typeof utt.speaker === 'number' ? utt.speaker : 0) + 1}`;
      return `${speaker}: ${utt.text}`;
    }).join('\n');
  }

  /**
   * Get service stats
   */
  getStats() {
    return {
      ...this.stats,
      provider: this.provider,
      authMode: this.authMode,
      isInitialized: this.isInitialized,
      estimatedCostPerMinute: 1 / 60, // Azure S0 ≈ $1/audio hour
      // Daily circuit-breaker visibility (cost-investigation #2c).
      dailyKey: this.dailyKey,
      dailyMinutes: Number(this.dailyMinutes.toFixed(2)),
      dailyBudgetMinutes: this.dailyBudgetMinutes,
      budgetTimezone: this.budgetTimezone,
      budgetPersisted: this._dailyState.durable === true,
    };
  }

  /**
   * Check if service is available (Azure Speech configured).
   */
  isAvailable() {
    if (!this.isInitialized) this.initialize();
    return this.isInitialized && this.provider === 'azure';
  }
}

// Export singleton instance
module.exports = new TranscriptionService();
