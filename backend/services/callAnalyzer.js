/**
 * Call Analyzer Service
 *
 * Summarizes call transcripts behind a thin provider seam.
 *
 * PROVIDER (PRD D2/D7 — HIPAA): summaries run on **Azure OpenAI**, covered by
 * Microsoft's BAA in the Azure Product Terms. Managed-identity auth is preferred (the
 * container apps already run with a user-assigned MI); an API key from Key Vault is the
 * fallback. Config comes from AZURE_OPENAI_* env (endpoint/deployment/api-version),
 * provisioned separately.
 *
 * The legacy OpenAI-direct (gpt-3.5) path is BAA-LESS and must NOT touch real patient
 * audio — it's kept only behind an explicit ALLOW_OPENAI_DIRECT=true opt-in for local
 * dev. When no LLM provider is configured, summaries degrade to the regex fallback.
 */

const OpenAI = require('openai');

// Cognitive Services token audience for Entra/MI auth against Azure OpenAI.
const AZURE_OPENAI_SCOPE = 'https://cognitiveservices.azure.com/.default';

class CallAnalyzer {
  constructor() {
    this.client = null;
    this.provider = null; // 'azure' | 'openai-direct' | null
    this.model = null;    // Azure deployment name, or the OpenAI model id
    this.isInitialized = false;
    this.stats = {
      totalAnalyses: 0,
      totalTokens: 0,
      estimatedCost: 0,
    };
  }

  /**
   * Initialize the summarization client. Order:
   *   1. Azure OpenAI (BAA-covered) via MI, else Azure OpenAI via KV api-key.
   *   2. OpenAI-direct ONLY if ALLOW_OPENAI_DIRECT=true (BAA-less; local dev only).
   *   3. Otherwise unconfigured → callers fall back to regex analysis.
   */
  initialize() {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';

    if (endpoint && deployment) {
      try {
        const { AzureOpenAI } = require('openai');
        // Managed identity is the DEFAULT and preferred path (PRD D2). Key-auth engages
        // ONLY when AZURE_OPENAI_AUTH_MODE is explicitly 'api_key' — it is never a silent
        // fallback (loading the KV key never flips us off MI, and a failed MI token
        // acquisition throws → regex fallback, it does NOT retry with the key).
        const authMode = process.env.AZURE_OPENAI_AUTH_MODE || 'managed_identity';
        // Enforce credential exclusivity at construction. The openai SDK defaults
        // `apiKey` to readEnv('AZURE_OPENAI_API_KEY') ONLY when apiKey is `undefined`, and
        // throws if both apiKey and azureADTokenProvider are set. SECRET_MAP loads
        // azure-openai-key into that env in production, so on the MI path we MUST pass
        // apiKey:null to suppress the env default (else: "apiKey and azureADTokenProvider
        // are mutually exclusive"). AUTH_MODE picks exactly one credential — never both.
        if (authMode === 'api_key') {
          const apiKey = process.env.AZURE_OPENAI_API_KEY;
          if (!apiKey) {
            console.error('❌ AZURE_OPENAI_AUTH_MODE=api_key but AZURE_OPENAI_API_KEY is not set.');
            return false;
          }
          this.client = new AzureOpenAI({ endpoint, apiVersion, deployment, apiKey });
          console.log('✅ Call analyzer initialized (Azure OpenAI, api-key)');
        } else {
          // Preferred: managed identity — no secret. Reuses the container app's MI.
          const { ManagedIdentityCredential, getBearerTokenProvider } = require('@azure/identity');
          const clientId = process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;
          const credential = new ManagedIdentityCredential(clientId ? { clientId } : {});
          const azureADTokenProvider = getBearerTokenProvider(credential, AZURE_OPENAI_SCOPE);
          this.client = new AzureOpenAI({ endpoint, apiVersion, deployment, azureADTokenProvider, apiKey: null });
          console.log('✅ Call analyzer initialized (Azure OpenAI, managed identity)');
        }
        this.provider = 'azure';
        this.model = deployment;
        this.isInitialized = true;
        return true;
      } catch (error) {
        console.error('❌ Failed to initialize Azure OpenAI:', error.message);
        return false;
      }
    }

    // Legacy OpenAI-direct — BAA-less. Disabled unless explicitly opted in (local dev).
    if (process.env.OPENAI_API_KEY && process.env.ALLOW_OPENAI_DIRECT === 'true') {
      try {
        this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.provider = 'openai-direct';
        this.model = 'gpt-3.5-turbo';
        this.isInitialized = true;
        console.warn('⚠️ Call analyzer initialized (OpenAI-direct, BAA-LESS — dev only, ALLOW_OPENAI_DIRECT=true)');
        return true;
      } catch (error) {
        console.error('❌ Failed to initialize OpenAI-direct:', error.message);
        return false;
      }
    }

    console.warn(
      '⚠️ No BAA-covered LLM configured (AZURE_OPENAI_ENDPOINT/AZURE_OPENAI_DEPLOYMENT missing). ' +
      'Call summaries will use the regex fallback.'
    );
    return false;
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

    console.log(`🧠 Analyzing ${call.source === 'mango' ? 'staff' : 'AI'} call ${call.external_id || 'unknown'} (${this.provider})...`);

    try {
      // Route by source: Mango = human staff↔patient call; Retell = AI-agent call.
      const isHumanCall = call.source === 'mango';
      const systemPrompt = isHumanCall
        ? `You analyze recordings of phone calls that a dental office's front-desk STAFF answered while talking with a patient (or prospective patient). Extract structured information. Always respond with valid JSON only.`
        : `You are a dental office call analyzer. Analyze call transcripts and extract structured information. Always respond with valid JSON.`;
      const prompt = isHumanCall
        ? this.buildHumanCallPrompt(transcript, call)
        : this.buildAnalysisPrompt(transcript, call);

      // Provider-specific params: GPT-5-class Azure minis require max_completion_tokens and
      // only support the default temperature; OpenAI-direct (dev) uses the classic params.
      const params = {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      };
      if (this.provider === 'azure') {
        params.max_completion_tokens = 600;
        params.response_format = { type: 'json_object' };
      } else {
        params.temperature = 0.3;
        params.max_tokens = 500;
      }

      const response = await this.client.chat.completions.create(params);

      const content = response.choices[0]?.message?.content || '{}';

      // Track usage (cost is an estimate; Azure mini ≈ $0.003/call).
      const usage = response.usage;
      this.stats.totalAnalyses++;
      this.stats.totalTokens += usage?.total_tokens || 0;
      const perThousand = this.provider === 'azure' ? 0.0006 : 0.002;
      this.stats.estimatedCost += ((usage?.total_tokens || 0) / 1000) * perThousand;

      // Parse JSON response
      const analysis = this.parseAnalysisResponse(content);

      // Proof the LLM path actually ran (not the regex fallback): names the provider +
      // token usage per summarized call. Regex fallback never logs this line.
      console.log(`✅ Call analyzed via ${this.provider} (${usage?.total_tokens || 0} tokens): ${analysis.caller_name || 'Unknown'}, Sentiment: ${analysis.sentiment}`);
      return analysis;

    } catch (error) {
      console.error('❌ Call analysis failed:', error.message);
      return this.fallbackAnalysis(call);
    }
  }

  /**
   * Prompt for a HUMAN staff↔patient call (Mango). Same output schema as the AI-agent
   * prompt so downstream consumers (worklist chips, commlog) are untouched.
   */
  buildHumanCallPrompt(transcript, call) {
    return `A front-desk STAFF member at a dental office answered this phone call. Read the transcript and summarize it from the office's point of view.

TRANSCRIPT:
"""
${String(transcript).substring(0, 2000)}
"""

CALLER PHONE NUMBER: ${call.caller_number || 'Unknown'}

Focus on: who called and for whom, why they called, what the staff member did or promised, whether any follow-up is needed and by whom, and any emergency indicators.

Be TERSE — each field below is one short line (it becomes a compact chart note). No prose.

Respond with ONLY valid JSON with these fields:
{
  "caller_name": "The caller's name if stated, else null",
  "call_reason": "ONE short line — the reason (e.g., 'Reschedule cleaning', 'Billing question about statement', 'Broken tooth — emergency')",
  "action_needed": "ONE short line — what the office must do / what staff promised, or 'None' (e.g., 'Call back to confirm Tue 2:30', 'Send itemized statement')",
  "callback_number": "The best callback number if the caller gave one, digits only, else null",
  "sentiment": "positive | neutral | negative (the caller's tone)",
  "is_emergency": true or false (is this a dental emergency?),
  "summary": "2-3 sentence summary of the call and what was done or promised",
  "appointment_requested": true or false (did the caller want to book/change an appointment?),
  "callback_needed": true or false (does the office need to call this person back?),
  "key_details": ["short", "list", "of", "important", "details"]
}

Respond ONLY with valid JSON, no other text.`;
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
          // Compact-summary fields (item 2). action_needed = one terse line; callback_number
          // = digits the caller gave, else null. Absent on the AI-agent prompt → null.
          action_needed: parsed.action_needed || null,
          callback_number: parsed.callback_number ? String(parsed.callback_number) : null,
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
      action_needed: null,
      callback_number: null,
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

