/**
 * Transcription Service
 * 
 * Handles audio transcription using Deepgram.
 * Supports both file-based and URL-based transcription.
 */

const { createClient } = require('@deepgram/sdk');
const fs = require('fs').promises;
const path = require('path');

class TranscriptionService {
  constructor() {
    this.client = null;
    this.isInitialized = false;
    this.stats = {
      totalTranscriptions: 0,
      totalMinutes: 0,
      totalCost: 0,
    };
  }

  /**
   * Initialize the Deepgram client
   */
  initialize() {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    
    if (!apiKey) {
      console.warn('⚠️ DEEPGRAM_API_KEY not set. Transcription service unavailable.');
      return false;
    }

    try {
      this.client = createClient(apiKey);
      this.isInitialized = true;
      console.log('✅ Transcription service initialized (Deepgram)');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize Deepgram:', error.message);
      return false;
    }
  }

  /**
   * Transcribe an audio file
   * @param {string} filePath - Path to the audio file
   * @param {Object} options - Transcription options
   */
  async transcribeFile(filePath, options = {}) {
    if (!this.isInitialized) {
      this.initialize();
    }

    if (!this.client) {
      throw new Error('Transcription service not available. Set DEEPGRAM_API_KEY.');
    }

    console.log(`🎤 Transcribing file: ${path.basename(filePath)}`);

    try {
      // Read the audio file
      const audioBuffer = await fs.readFile(filePath);
      
      // Determine mimetype from extension
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.mp3': 'audio/mp3',
        '.wav': 'audio/wav',
        '.m4a': 'audio/m4a',
        '.ogg': 'audio/ogg',
        '.flac': 'audio/flac',
      };
      const mimetype = mimeTypes[ext] || 'audio/mp3';

      // Transcription options
      const transcriptionOptions = {
        model: options.model || 'nova-2',
        smart_format: true,
        punctuate: true,
        diarize: options.diarize !== false, // Enable speaker diarization by default
        utterances: true,
        paragraphs: true,
        ...options,
      };

      // Transcribe
      const startTime = Date.now();
      const { result } = await this.client.listen.prerecorded.transcribeFile(
        audioBuffer,
        transcriptionOptions
      );

      const duration = (Date.now() - startTime) / 1000;
      
      // Extract transcript data
      const transcript = this.processTranscriptResult(result);
      
      // Update stats
      if (transcript.duration_seconds) {
        this.stats.totalTranscriptions++;
        this.stats.totalMinutes += transcript.duration_seconds / 60;
        // Deepgram Nova-2 costs ~$0.0043/min
        this.stats.totalCost += (transcript.duration_seconds / 60) * 0.0043;
      }

      console.log(`✅ Transcription complete in ${duration.toFixed(1)}s`);
      return transcript;

    } catch (error) {
      console.error('❌ Transcription failed:', error.message);
      throw error;
    }
  }

  /**
   * Transcribe from a URL
   * @param {string} url - URL of the audio file
   * @param {Object} options - Transcription options
   */
  async transcribeUrl(url, options = {}) {
    if (!this.isInitialized) {
      this.initialize();
    }

    if (!this.client) {
      throw new Error('Transcription service not available. Set DEEPGRAM_API_KEY.');
    }

    console.log(`🎤 Transcribing from URL...`);

    try {
      const transcriptionOptions = {
        model: options.model || 'nova-2',
        smart_format: true,
        punctuate: true,
        diarize: options.diarize !== false,
        utterances: true,
        paragraphs: true,
        ...options,
      };

      const startTime = Date.now();
      const { result } = await this.client.listen.prerecorded.transcribeUrl(
        { url },
        transcriptionOptions
      );

      const duration = (Date.now() - startTime) / 1000;
      const transcript = this.processTranscriptResult(result);

      // Update stats
      if (transcript.duration_seconds) {
        this.stats.totalTranscriptions++;
        this.stats.totalMinutes += transcript.duration_seconds / 60;
        this.stats.totalCost += (transcript.duration_seconds / 60) * 0.0043;
      }

      console.log(`✅ Transcription complete in ${duration.toFixed(1)}s`);
      return transcript;

    } catch (error) {
      console.error('❌ Transcription failed:', error.message);
      throw error;
    }
  }

  /**
   * Process Deepgram result into our standard format
   */
  processTranscriptResult(result) {
    const channel = result?.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];
    
    if (!alternative) {
      return {
        text: '',
        words: [],
        utterances: [],
        duration_seconds: 0,
      };
    }

    // Get full transcript text
    const text = alternative.transcript || '';
    
    // Get words with timing
    const words = (alternative.words || []).map(word => ({
      word: word.word,
      start: word.start,
      end: word.end,
      confidence: word.confidence,
      speaker: word.speaker,
    }));

    // Get utterances (speaker-separated segments)
    const utterances = (result?.results?.utterances || []).map(utt => ({
      speaker: utt.speaker,
      text: utt.transcript,
      start: utt.start,
      end: utt.end,
      confidence: utt.confidence,
    }));

    // Get duration from metadata
    const duration = result?.metadata?.duration || 
                    (words.length > 0 ? words[words.length - 1].end : 0);

    return {
      text,
      words,
      utterances,
      duration_seconds: Math.round(duration),
      paragraphs: alternative.paragraphs?.paragraphs || [],
      confidence: alternative.confidence,
    };
  }

  /**
   * Format transcript as chat-style conversation
   */
  formatAsConversation(transcript) {
    if (!transcript.utterances || transcript.utterances.length === 0) {
      return transcript.text;
    }

    return transcript.utterances.map(utt => {
      const speaker = utt.speaker === 0 ? 'Speaker 1' : `Speaker ${utt.speaker + 1}`;
      return `${speaker}: ${utt.text}`;
    }).join('\n');
  }

  /**
   * Get service stats
   */
  getStats() {
    return {
      ...this.stats,
      isInitialized: this.isInitialized,
      estimatedCostPerMinute: 0.0043,
    };
  }

  /**
   * Check if service is available
   */
  isAvailable() {
    if (!this.isInitialized) {
      this.initialize();
    }
    return this.isInitialized && !!this.client;
  }
}

// Export singleton instance
module.exports = new TranscriptionService();

