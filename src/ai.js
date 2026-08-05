import { callGemini } from './providers/gemini.js';
import { callOpenAI } from './providers/openai.js';
import { callAnthropicAI } from './providers/anthropic.js';
import { callGroq } from './providers/groq.js';
import { callLocal } from './providers/local.js';
import { callDeepSeek } from './providers/deepseek.js';

const PROVIDERS = {
  gemini: callGemini,
  openai: callOpenAI,
  anthropic: callAnthropicAI,
  groq: callGroq,
  deepseek: callDeepSeek,
  local: callLocal,
};

// Default provider order - can be overridden by AI_PROVIDER_ORDER env var
// AI_PROVIDER_ORDER=gemini,openai,anthropic,groq
const order = (process.env.AI_PROVIDER_ORDER || 'gemini,openai,anthropic,groq')
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

  // If a specific provider is forced, only try that one
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

/**
 * Get list of configured providers
 * @returns {Array} List of provider names that have API keys
 */
export function configuredProviders() {
  return order;
}

/**
 * Check if a specific provider is available
 * @param {string} providerName - Provider name to check
 * @returns {boolean}
 */
export function isProviderAvailable(providerName) {
  return order.includes(providerName.toLowerCase());
}

/**
 * Get all available providers
 * @returns {Object} { name: boolean }
 */
export function getAllProvidersStatus() {
  const hasKey = (...envVars) => envVars.some((v) => process.env[v] && process.env[v].trim());

  return {
    gemini: hasKey('GEMINI_API_KEY', 'GEMINI_API_KEYS'),
    openai: hasKey('OPENAI_API_KEY', 'OPENAI_API_KEYS'),
    anthropic: hasKey('ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEYS'),
    groq: hasKey('GROQ_API_KEY', 'GROQ_API_KEYS'),
    deepseek: hasKey('DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEYS'),
    local: true, // Local always available
  };
}
