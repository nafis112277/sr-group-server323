import { callGemini } from './providers/gemini.js';
import { callOpenAI } from './providers/openai.js';
import { callAnthropicAI } from './providers/anthropic.js';
import { callGroq } from './providers/groq.js';
import { callDeepSeek } from './providers/deepseek.js';

const PROVIDERS = {
  gemini: callGemini,
  openai: callOpenAI,
  anthropic: callAnthropicAI,
  groq: callGroq,
  deepseek: callDeepSeek,
};

// কোন provider আগে ট্রাই হবে, কমা দিয়ে .env-এ সেট করা যায়:
//   AI_PROVIDER_ORDER=gemini,openai,anthropic,groq
// একটা provider-এর সব key fail করলে (quota শেষ / invalid) পরের provider দিয়ে চেষ্টা হয়।
// FIX: deepseek ইচ্ছাকৃতভাবে এই default chain-এ নেই — এটা paid API, শুধু forceProvider
// (Max plan থেকে সরাসরি সিলেক্ট করলে) দিয়েই কল হওয়া উচিত, silent fallback দিয়ে না।
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
  const { webSearch = false, forceProvider = null } = options;
  let lastError = 'No AI provider is configured on the server. Add at least one API key in the Environment Variables (Render dashboard or .env).';

  // customer je model select korche, thakle shudhu oitai try hobe (fallback chain skip)
  const tryOrder = (forceProvider && PROVIDERS[forceProvider]) ? [forceProvider] : order;

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
