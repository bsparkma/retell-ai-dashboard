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

// Cognitive Services token audience for Entra/MI auth against Azure AI Speech.
const AZURE_SPEECH_SCOPE = 'https://cognitiveservices.azure.com/.default';
// Fast Transcription API version (synchronous, multipart audio, diarization supported).
const FAST_TRANSCRIPTION_API_VERSION = '2024-11-15';

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

    const locales = options.locales || this.locales;
    const maxSpeakers = options.maxSpeakers || this.maxSpeakers;

    const definition = {
      locales,
      // Diarization separates staff vs patient turns.
      diarization: { enabled: true, maxSpeakers },
      profanityFilterMode: 'None',
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
    const text = combined.map((c) => c.text).filter(Boolean).join(' ').trim()
      || (Array.isArray(result.phrases) ? result.phrases.map((p) => p.text).filter(Boolean).join(' ').trim() : '');

    const phrases = Array.isArray(result.phrases) ? result.phrases : [];

    // Utterances: one per diarized phrase (speaker-separated segments).
    const utterances = phrases.map((p) => ({
      speaker: typeof p.speaker === 'number' ? p.speaker : 0,
      text: p.text || '',
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
