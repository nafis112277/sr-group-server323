import { callGemini } from './providers/gemini.js';
import { callOpenAI } from './providers/openai.js';
import { callAnthropicAI } from './providers/anthropic.js';
import { callGroq } from './providers/groq.js';

const PROVIDERS = {
  gemini: callGemini,
  openai: callOpenAI,
  anthropic: callAnthropicAI,
  groq: callGroq,
};

// কোন provider আগে ট্রাই হবে, কমা দিয়ে .env-এ সেট করা যায়:
//   AI_PROVIDER_ORDER=gemini,openai,anthropic,groq
// একটা provider-এর সব key fail করলে (quota শেষ / invalid) পরের provider দিয়ে চেষ্টা হয়।
const order = (process.env.AI_PROVIDER_ORDER || 'gemini,openai,anthropic,groq')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((name) => PROVIDERS[name]);

// history: [{ role: 'user' | 'assistant', content: string }]
// options: { webSearch?: boolean } — customer composer-er "+" menu theke web search
// toggle on korle eta true hoye ashe, prottek provider function-e forward kora hoy.
// jei provider-e web search support kora nei (openai, groq), oira ei extra option
// shudhu ignore kore normal reply dibe — kono crash hobe na.
export async function callAI(systemPrompt, history, options = {}) {
  const { webSearch = false } = options;
  let lastError = 'No AI provider is configured on the server. Add at least one API key in the Environment Variables (Render dashboard or .env).';
  for (const name of order) {
    const fn = PROVIDERS[name];
    const result = await fn(systemPrompt, history, { webSearch });
    if (result.ok) return result;
    lastError = result.error || lastError;
  }
  return { ok: false, error: lastError };
}

export function configuredProviders() {
  return order;
}
