/**
 * Call Analyzer Service
 * 
 * Uses AI (OpenAI GPT) to analyze call transcripts.
 * Extracts caller name, call reason, sentiment, and generates summaries.
 */

const OpenAI = require('openai');

class CallAnalyzer {
  constructor() {
    this.client = null;
    this.isInitialized = false;
    this.stats = {
      totalAnalyses: 0,
      totalTokens: 0,
      estimatedCost: 0,
    };
  }

  /**
   * Initialize the OpenAI client
   */
  initialize() {
    const apiKey = process.env.OPENAI_API_KEY;
    
    if (!apiKey) {
      console.warn('⚠️ OPENAI_API_KEY not set. Call analysis unavailable.');
      return false;
    }

    try {
      this.client = new OpenAI({ apiKey });
      this.isInitialized = true;
      console.log('✅ Call analyzer initialized (OpenAI)');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize OpenAI:', error.message);
      return false;
    }
  }

  /**
   * Analyze a call transcript
   * @param {Object} call - Call object with transcript
   */
  async analyzeCall(call) {
    if (!this.isInitialized) {
      this.initialize();
    }

    if (!this.client) {
      console.warn('⚠️ Call analyzer not available');
      return this.fallbackAnalysis(call);
    }

    const transcript = call.transcript;
    if (!transcript || transcript.length < 20) {
      return this.fallbackAnalysis(call);
    }

    console.log(`🧠 Analyzing call ${call.external_id || 'unknown'}...`);

    try {
      const prompt = this.buildAnalysisPrompt(transcript, call);
      
      const response = await this.client.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `You are a dental office call analyzer. Analyze call transcripts and extract structured information. Always respond with valid JSON.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 500,
      });

      const content = response.choices[0]?.message?.content || '{}';
      
      // Track usage
      const usage = response.usage;
      this.stats.totalAnalyses++;
      this.stats.totalTokens += usage?.total_tokens || 0;
      // GPT-3.5-turbo costs ~$0.002/1K tokens
      this.stats.estimatedCost += ((usage?.total_tokens || 0) / 1000) * 0.002;

      // Parse JSON response
      const analysis = this.parseAnalysisResponse(content);
      
      console.log(`✅ Call analyzed: ${analysis.caller_name || 'Unknown'}, Sentiment: ${analysis.sentiment}`);
      return analysis;

    } catch (error) {
      console.error('❌ Call analysis failed:', error.message);
      return this.fallbackAnalysis(call);
    }
  }

  /**
   * Build the analysis prompt
   */
  buildAnalysisPrompt(transcript, call) {
    return `Analyze this dental office phone call transcript and extract the following information:

TRANSCRIPT:
"""
${transcript.substring(0, 2000)}
"""

CALLER PHONE NUMBER: ${call.caller_number || 'Unknown'}

Please provide a JSON response with these fields:
{
  "caller_name": "The caller's name if mentioned, or null",
  "call_reason": "Brief reason for the call (e.g., 'appointment scheduling', 'billing question', 'dental emergency', 'general inquiry')",
  "sentiment": "positive", "neutral", or "negative" based on caller's tone",
  "is_emergency": true or false - is this a dental emergency?,
  "summary": "2-3 sentence summary of the call",
  "appointment_requested": true or false,
  "callback_needed": true or false,
  "key_details": ["array", "of", "important", "details"]
}

Respond ONLY with valid JSON, no other text.`;
  }

  /**
   * Parse the AI response
   */
  parseAnalysisResponse(content) {
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          caller_name: parsed.caller_name || null,
          call_reason: parsed.call_reason || 'Unknown',
          sentiment: this.normalizeSentiment(parsed.sentiment),
          is_emergency: !!parsed.is_emergency,
          summary: parsed.summary || '',
          appointment_requested: !!parsed.appointment_requested,
          callback_needed: !!parsed.callback_needed,
          key_details: parsed.key_details || [],
        };
      }
    } catch (e) {
      console.warn('⚠️ Failed to parse analysis response:', e.message);
    }

    return this.fallbackAnalysis({});
  }

  /**
   * Normalize sentiment to our standard values
   */
  normalizeSentiment(sentiment) {
    const s = (sentiment || '').toLowerCase().trim();
    if (s.includes('positive') || s.includes('happy') || s.includes('satisfied')) {
      return 'positive';
    }
    if (s.includes('negative') || s.includes('angry') || s.includes('frustrated')) {
      return 'negative';
    }
    return 'neutral';
  }

  /**
   * Fallback analysis using simple heuristics
   */
  fallbackAnalysis(call) {
    // Guard: transcript may arrive as a non-string (e.g. Retell's transcript_object array),
    // which would throw "transcript.match is not a function" below. Coerce to '' if not a string.
    const transcript = typeof call.transcript === 'string' ? call.transcript : '';

    // Extract caller name using regex
    const namePatterns = [
      /(?:my name is|i'm|this is|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
      /(?:hi|hello),?\s*(?:this is|my name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    ];
    
    let callerName = null;
    for (const pattern of namePatterns) {
      const match = transcript.match(pattern);
      if (match && match[1]) {
        callerName = match[1].trim();
        break;
      }
    }

    // Detect emergency keywords
    const emergencyKeywords = ['emergency', 'severe pain', 'bleeding', 'swelling', 'broken', 'knocked out'];
    const isEmergency = emergencyKeywords.some(kw => transcript.toLowerCase().includes(kw));

    // Detect sentiment
    const negativeWords = ['angry', 'frustrated', 'upset', 'terrible', 'horrible', 'pain', 'hurts'];
    const positiveWords = ['thank you', 'thanks', 'great', 'wonderful', 'appreciate', 'helpful'];
    
    let negativeCount = 0;
    let positiveCount = 0;
    negativeWords.forEach(w => { if (transcript.toLowerCase().includes(w)) negativeCount++; });
    positiveWords.forEach(w => { if (transcript.toLowerCase().includes(w)) positiveCount++; });
    
    let sentiment = 'neutral';
    if (negativeCount > positiveCount && negativeCount >= 2) sentiment = 'negative';
    if (positiveCount > negativeCount && positiveCount >= 2) sentiment = 'positive';

    // Detect call reason
    let callReason = 'general inquiry';
    if (transcript.toLowerCase().includes('appointment')) callReason = 'appointment scheduling';
    if (transcript.toLowerCase().includes('billing') || transcript.toLowerCase().includes('payment')) callReason = 'billing question';
    if (transcript.toLowerCase().includes('insurance')) callReason = 'insurance inquiry';
    if (isEmergency) callReason = 'dental emergency';

    return {
      caller_name: callerName,
      call_reason: callReason,
      sentiment,
      is_emergency: isEmergency,
      summary: `Call from ${callerName || call.caller_number || 'unknown'} regarding ${callReason}.`,
      appointment_requested: transcript.toLowerCase().includes('appointment'),
      callback_needed: transcript.toLowerCase().includes('call') && transcript.toLowerCase().includes('back'),
      key_details: [],
    };
  }

  /**
   * Batch analyze multiple calls
   */
  async analyzeMultipleCalls(calls) {
    const results = [];
    
    for (const call of calls) {
      const analysis = await this.analyzeCall(call);
      results.push({
        call_id: call.external_id,
        ...analysis,
      });
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    return results;
  }

  /**
   * Get service stats
   */
  getStats() {
    return {
      ...this.stats,
      isInitialized: this.isInitialized,
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
module.exports = new CallAnalyzer();

