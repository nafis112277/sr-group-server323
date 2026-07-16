const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const apiKeys = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);
let nextKeyIndex = 0;

function isQuotaOrKeyError(status) {
  return status === 429 || status === 403 || status === 401;
}

// Groq-এর free/on_demand tier-এ per-minute token limit খুবই কম (~12000)।
// Gemini/OpenAI/Anthropic fail করলে fallback হিসেবে Groq কল হয়, তাই এখানে
// history + system prompt ছোট করে পাঠানো হয় যাতে বড় conversation-এও রিকোয়েস্ট রিজেক্ট না হয়।
const TOKEN_BUDGET = 9000; // 12000-এর একটু নিচে, safety margin সহ
const MAX_TOKENS_OUT = 1200; // reply-র জন্য বরাদ্দ, TOKEN_BUDGET থেকে আলাদা রাখা হয়
const CHARS_PER_TOKEN = 4; // rough estimate, exact tokenizer ছাড়া এটাই সবচেয়ে ব্যবহারযোগ্য approximation

function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

// একটা একক মেসেজ যদি নিজেই অনেক বড় হয় (যেমন বড় code snippet), সেটাকে
// শুরু আর শেষটুকু রেখে মাঝখান কেটে ছোট করে — পুরো বাদ দেওয়ার চেয়ে ভালো
function truncateMessageContent(content, maxChars) {
  if (!content || content.length <= maxChars) return content;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = maxChars - headLen - 50;
  return (
    content.slice(0, headLen) +
    '\n\n...[message shortened for length]...\n\n' +
    content.slice(content.length - tailLen)
  );
}

// system prompt + history-কে টোকেন বাজেটের মধ্যে আনতে ট্রিম করে:
// 1) system prompt নিজেই বড় হলে ছোট করে
// 2) সবচেয়ে পুরনো history messages ফেলে দেয় (সাম্প্রতিক কথোপকথনটাই বেশি জরুরি)
// 3) তাও না মিললে বড় individual message-গুলো ভেতর থেকে কেটে ছোট করে
function buildTrimmedMessages(systemPrompt, history) {
  let system = systemPrompt || '';
  const systemBudget = Math.floor(TOKEN_BUDGET * 0.35) * CHARS_PER_TOKEN;
  if (system.length > systemBudget) {
    system = system.slice(0, systemBudget) + '\n\n[Instructions shortened for length.]';
  }

  let remainingTokens = TOKEN_BUDGET - estimateTokens(system);
  if (remainingTokens < 500) remainingTokens = 500;

  // পেছন থেকে (সাম্প্রতিক মেসেজ) শুরু করে যতগুলো বাজেটে ধরে ততগুলো রাখি
  const kept = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const msgTokens = estimateTokens(msg.content);
    if (msgTokens <= remainingTokens) {
      kept.unshift(msg);
      remainingTokens -= msgTokens;
    } else if (remainingTokens > 300) {
      // এই একটা মেসেজ কেটে ছোট করে হলেও রাখার চেষ্টা করি (বিশেষ করে সবচেয়ে শেষের ইউজার মেসেজ)
      const maxChars = remainingTokens * CHARS_PER_TOKEN;
      kept.unshift({ ...msg, content: truncateMessageContent(msg.content, maxChars) });
      remainingTokens = 0;
      break;
    } else {
      break;
    }
  }

  return [
    { role: 'system', content: system },
    ...kept.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
  ];
}

export async function callGroq(systemPrompt, history) {
  if (apiKeys.length === 0) {
    return { ok: false, error: 'Groq is not configured (no GROQ_API_KEY / GROQ_API_KEYS).' };
  }

  const messages = buildTrimmedMessages(systemPrompt, history);

  let lastError = 'The AI did not return a reply.';
  for (let attempt = 0; attempt < apiKeys.length; attempt++) {
    const key = apiKeys[nextKeyIndex];
    nextKeyIndex = (nextKeyIndex + 1) % apiKeys.length;
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          max_tokens: MAX_TOKENS_OUT,
        }),
      });
      const data = await response.json();
      if (response.ok) {
        const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (text) return { ok: true, text, provider: 'groq' };
        lastError = 'The AI did not return a reply.';
        continue;
      }
      lastError = (data && data.error && data.error.message) || `Groq returned an error (status ${response.status}).`;
      if (isQuotaOrKeyError(response.status) && attempt < apiKeys.length - 1) {
        continue;
      }
      if (!isQuotaOrKeyError(response.status)) {
        return { ok: false, error: lastError };
      }
    } catch (err) {
      lastError = 'Could not reach Groq.';
    }
  }
  return { ok: false, error: lastError };
}
