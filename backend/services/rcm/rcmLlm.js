'use strict';

/**
 * Azure OpenAI seam for the RCM module.
 *
 * SAME PROVIDER, SAME AUTH, SAME REASONS as services/callAnalyzer.js: Azure
 * OpenAI is covered by Microsoft's BAA in the Azure Product Terms; managed
 * identity is the default and preferred credential (the container apps already
 * run with a user-assigned MI); an API key from Key Vault is the explicit
 * opt-in fallback for local dev.
 *
 * WHAT IS DELIBERATELY DIFFERENT FROM callAnalyzer:
 *  - There is NO regex fallback and NO OpenAI-direct escape hatch. A call
 *    summary degrading to a heuristic costs a worse summary; an EOB extraction
 *    degrading to a heuristic would put invented dollar amounts into a claim.
 *    Unconfigured means UNAVAILABLE, and the upload waits.
 *  - EOB text is PHI in a way a "which model shall we use" decision must not
 *    quietly override. ALLOW_OPENAI_DIRECT is not honored here at all.
 *
 * Config (env) — the platform's existing AZURE_OPENAI_* path, unchanged:
 *   AZURE_OPENAI_ENDPOINT        https://<name>.openai.azure.com
 *   AZURE_OPENAI_DEPLOYMENT      the platform default deployment
 *   AZURE_OPENAI_API_VERSION     default '2024-10-21'
 *   AZURE_OPENAI_AUTH_MODE       'managed_identity' (default) | 'api_key'
 *   AZURE_OPENAI_API_KEY 🔒      only read when AUTH_MODE=api_key
 * plus one RCM-local override, so a heavier extraction deployment can be used
 * without moving the voice summaries onto it:
 *   RCM_AZURE_OPENAI_DEPLOYMENT  overrides AZURE_OPENAI_DEPLOYMENT for RCM only
 *   RCM_LLM_MAX_COMPLETION_TOKENS default 16384
 */

const AZURE_OPENAI_SCOPE = 'https://cognitiveservices.azure.com/.default';

/** Azure 400s a completion cap above the deployment's window; 16384 is the gpt-4o-class ceiling. */
const DEFAULT_MAX_COMPLETION_TOKENS = 16384;

/** @type {import('openai').AzureOpenAI | null} */
let client = null;
/** @type {string | null} */
let deployment = null;

class RcmLlmError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'RcmLlmError';
    this.code = code;
  }
}

/** The deployment RCM extraction runs on. RCM-local override wins. */
function deploymentName() {
  return process.env.RCM_AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT || null;
}

/** Is a BAA-covered extraction provider configured? Unconfigured is a legal state. */
function isConfigured() {
  return Boolean(process.env.AZURE_OPENAI_ENDPOINT && deploymentName());
}

/**
 * Build (once) the Azure OpenAI client.
 *
 * The credential-exclusivity dance is copied from callAnalyzer.js and is
 * load-bearing: the openai SDK defaults `apiKey` from AZURE_OPENAI_API_KEY when
 * apiKey is `undefined`, and THROWS if both apiKey and azureADTokenProvider are
 * set. SECRET_MAP loads that key into the env in production, so on the MI path
 * we must pass `apiKey: null` to suppress the default. AUTH_MODE picks exactly
 * one credential — never both, and never a silent fallback from one to the other.
 */
function getClient() {
  if (client) return client;

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const dep = deploymentName();
  if (!endpoint || !dep) {
    throw new RcmLlmError(
      'Azure OpenAI is not configured for RCM extraction (AZURE_OPENAI_ENDPOINT + ' +
        'AZURE_OPENAI_DEPLOYMENT). Extraction is unavailable; uploads are kept.',
      'LLM_UNAVAILABLE'
    );
  }

  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
  const { AzureOpenAI } = require('openai');
  const authMode = process.env.AZURE_OPENAI_AUTH_MODE || 'managed_identity';

  if (authMode === 'api_key') {
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    if (!apiKey) {
      throw new RcmLlmError(
        'AZURE_OPENAI_AUTH_MODE=api_key but AZURE_OPENAI_API_KEY is not set.',
        'LLM_UNAVAILABLE'
      );
    }
    client = new AzureOpenAI({ endpoint, apiVersion, deployment: dep, apiKey });
    console.log(`✅ RCM extraction LLM ready (Azure OpenAI ${dep}, api-key)`);
  } else {
    const { ManagedIdentityCredential, getBearerTokenProvider } = require('@azure/identity');
    const clientId = process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;
    const credential = new ManagedIdentityCredential(clientId ? { clientId } : {});
    const azureADTokenProvider = getBearerTokenProvider(credential, AZURE_OPENAI_SCOPE);
    client = new AzureOpenAI({ endpoint, apiVersion, deployment: dep, azureADTokenProvider, apiKey: null });
    console.log(`✅ RCM extraction LLM ready (Azure OpenAI ${dep}, managed identity)`);
  }

  deployment = dep;
  return client;
}

/**
 * One structured-output completion.
 *
 * Returns the RAW parsed JSON plus the usage block — pricing the call is the
 * budget's job, and parsing the answer into claims is the engine's. This
 * function does neither, so it stays swappable.
 *
 * @param {{ systemPrompt: string, userPrompt: string, jsonSchema: object }} args
 * @returns {Promise<{ json: unknown, usage: { prompt_tokens: number, completion_tokens: number, total_tokens: number } }>}
 */
async function completeJson({ systemPrompt, userPrompt, jsonSchema }) {
  const api = getClient();

  // GPT-5-class Azure deployments require max_completion_tokens (not
  // max_tokens) and only support the default temperature — the same
  // provider-specific split callAnalyzer.js documents. Temperature is therefore
  // not set here at all rather than set to a value some deployments reject.
  const params = {
    model: deployment,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_completion_tokens: Number(process.env.RCM_LLM_MAX_COMPLETION_TOKENS) || DEFAULT_MAX_COMPLETION_TOKENS,
    response_format: { type: 'json_schema', json_schema: jsonSchema },
  };

  let response;
  try {
    response = await api.chat.completions.create(params);
  } catch (err) {
    // The message can name the deployment and the HTTP status; it never
    // contains the document, because the document went up in the request body
    // and Azure errors echo the failure, not the payload.
    throw new RcmLlmError(
      `Azure OpenAI extraction call failed: ${err && err.message ? err.message : String(err)}`,
      'LLM_CALL_FAILED'
    );
  }

  const choice = response.choices && response.choices[0];
  // A truncated answer is a REFUSAL, not a partial success: JSON.parse would
  // throw anyway, and a length-stopped extraction that happened to parse would
  // be a claim missing its last procedure lines with nothing to say so.
  if (choice && choice.finish_reason === 'length') {
    throw new RcmLlmError(
      'Extraction response hit the completion token limit before finishing. ' +
        'Raise RCM_LLM_MAX_COMPLETION_TOKENS or split the remittance.',
      'LLM_RESPONSE_TRUNCATED'
    );
  }

  const content = choice && choice.message && choice.message.content;
  if (!content || typeof content !== 'string') {
    throw new RcmLlmError('Azure OpenAI returned an empty extraction response', 'LLM_EMPTY_RESPONSE');
  }

  let json;
  try {
    json = JSON.parse(content);
  } catch (err) {
    throw new RcmLlmError('Azure OpenAI returned an extraction response that is not JSON', 'LLM_BAD_JSON');
  }

  const usage = response.usage || {};
  return {
    json,
    usage: {
      prompt_tokens: Number(usage.prompt_tokens) || 0,
      completion_tokens: Number(usage.completion_tokens) || 0,
      total_tokens: Number(usage.total_tokens) || 0,
    },
  };
}

/** Test seam — drop the cached client so a suite can re-point the env. */
function _resetForTests() {
  client = null;
  deployment = null;
}

module.exports = { isConfigured, completeJson, deploymentName, RcmLlmError, _resetForTests };
