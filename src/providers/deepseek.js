// DeepSeek provider — OpenAI-compatible Chat Completions API ব্যবহার করে (base URL শুধু আলাদা)।
// Env var: DEEPSEEK_API_KEY (একাধিক key থাকলে কমা দিয়ে দেওয়া যায়, যেমন: "key1,key2,key3")
//   একটা key rate-limit/invalid হলে পরের key দিয়ে চেষ্টা হবে, সব key fail করলে
//   ai.js-এর fallback chain অনুযায়ী পরের provider-এ চলে যাবে।
//
// DeepSeek-এর chat model (deepseek-chat / deepseek-reasoner) vision support করে না,
// তাই history-তে কোনো image থাকলে সেটা শুধু ignore করা হয় (crash করবে না, gemini-এর মতো
// image response ও ফেরত দেয় না) — ঠিক openai/groq-এর মতোই best-effort আচরণ।

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

function getApiKeys() {
  return (process.env.DEEPSEEK_API_KEY || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

// history: [{ role: 'user' | 'assistant', content: string, images?: [...] }]
// image thakleo shudhu text part pathai, DeepSeek-e vision nei tai.
function toDeepSeekMessages(systemPrompt, history) {
  const messages = [{ role: 'system', content: systemPrompt || '' }];
  for (const m of history) {
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || '',
    });
  }
  return messages;
}

async function callWithKey(apiKey, systemPrompt, history) {
  const res = await fetch(DEEPSEEK_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: toDeepSeekMessages(systemPrompt, history),
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, error: `DeepSeek error (${res.status}): ${errText.slice(0, 300)}` };
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return { ok: true, text, images: null };
}

// options.webSearch: DeepSeek-এর native web search tool নেই, তাই এই option শুধু ignore
// করা হয় — normal reply দেয়, কোনো crash হয় না (openai/groq-এর মতোই behavior)।
export async function callDeepSeek(systemPrompt, history, options = {}) {
  const keys = getApiKeys();
  if (keys.length === 0) {
    return { ok: false, error: 'DEEPSEEK_API_KEY set করা নেই।' };
  }

  let lastError = 'DeepSeek call failed.';
  for (const key of keys) {
    try {
      const result = await callWithKey(key, systemPrompt, history);
      if (result.ok) return result;
      lastError = result.error;
    } catch (err) {
      lastError = `DeepSeek request failed: ${err.message}`;
    }
  }
  return { ok: false, error: lastError };
}
