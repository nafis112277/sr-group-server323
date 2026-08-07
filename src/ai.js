import { callGemini } from './providers/gemini.js';
import { callOpenAI } from './providers/openai.js';
import { callAnthropicAI } from './providers/anthropic.js';
import { callGroq } from './providers/groq.js';
import { callDeepSeek } from './providers/deepseek.js';
// FIX: './providers/local.js' (server-e transformers.js diye chholo, RAM-heavy,
// Render free tier-e crash risk) ar import kora hocche na. "local" model ekhon
// shudhu browser-e (WebLLM) chole — routes/chat.js e forceProvider === 'local'
// hole ei fallback chain-e ashe i na, tai eta ekhane thakar dorkar nai.

const PROVIDERS = {
  gemini: callGemini,
  openai: callOpenAI,
  anthropic: callAnthropicAI,
  groq: callGroq,
  deepseek: callDeepSeek,
};

// Default provider order - can be overridden by AI_PROVIDER_ORDER env var
// AI_PROVIDER_ORDER=gemini,openai,anthropic,groq
// FIX: 'local' default order theke shore fela hoyeche (upore-r note dekho).
const order = (
  process.env.AI_PROVIDER_ORDER ||
  'gemini,openai,anthropic,groq,deepseek'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((name) => PROVIDERS[name]);

/**
 * Main AI call function
 * @param {string} systemPrompt - System message for AI
 * @param {Array} history - Chat history [{ role: 'user'|'assistant', content: string }]
 * @param {Object} options - { webSearch?: boolean, forceProvider?: string }
 * @returns {Object} { ok: boolean, response?: string, error?: string }
 */
export async function callAI(systemPrompt, history, options = {}) {
  const { webSearch = false, forceProvider = null } = options;
  let lastError =
    'No AI provider is configured on the server. Add at least one API key in the Environment Variables (Render dashboard or .env).';

  // FIX: forceProvider === 'local' ei function porjonto ashar kotha na
  // (routes/chat.js e age-i client-generated reply diye handle hoye jay).
  // Tabu keu bhul kore pathiye dile, jate crash na kore, ekhane clear error dei.
  if (forceProvider === 'local') {
    return { ok: false, error: 'Local AI runs in the browser and should not be routed through callAI().' };
  }

  const tryOrder = forceProvider && PROVIDERS[forceProvider] ? [forceProvider] : order;
  for (const name of tryOrder) {
    const fn = PROVIDERS[name];
    const result = await fn(systemPrompt, history, { webSearch });
    console.log(`[AI] ${name}:`, result.ok ? 'SUCCESS' : result.error);
    if (result.ok) return result;
    lastError = result.error || lastError;
  }
  return { ok: false, error: lastError };
}

export function configuredProviders() {
  return order;
}

export function isProviderAvailable(providerName) {
  return order.includes(providerName.toLowerCase());
}

export function getAllProvidersStatus() {
  const hasKey = (...envVars) => envVars.some((v) => process.env[v] && process.env[v].trim());
  return {
    gemini: hasKey('GEMINI_API_KEY', 'GEMINI_API_KEYS'),
    openai: hasKey('OPENAI_API_KEY', 'OPENAI_API_KEYS'),
    anthropic: hasKey('ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEYS'),
    groq: hasKey('GROQ_API_KEY', 'GROQ_API_KEYS'),
    deepseek: hasKey('DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEYS'),
    // FIX: 'local' ekhon server provider na — status hisebe "always ready" dekhano
    // biddhroshi hobe, tai ei list theke shorie deya holo. Frontend model-picker-e
    // 'local'-er jonno already MODEL_INFO/MODEL_ACCESS (chat.js) ache, ota alada.
  };
}
