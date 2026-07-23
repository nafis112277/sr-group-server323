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

// FIX: আগে flat CHARS_PER_TOKEN=4 ব্যবহার হতো, যেটা ইংরেজির জন্য ঠিক থাকলেও
// বাংলা/অন্যান্য non-Latin script-এ ভুল — Bangla Unicode text BPE tokenizer-এ
// সাধারণত char-per-token অনেক কম (প্রায় 1.3-1.8), মানে flat 4 ধরলে token count
// বাস্তবে যা লাগবে তার চেয়ে অনেক কম দেখাবে, এবং budget-এর ভেতরে আছে ভেবে
// আসলে Groq-এর real per-minute limit-এ গিয়ে ধাক্কা খাবে।
// এখানে Bangla block (\u0980–\u09FF) ধরে সেই characters-এর জন্য আলাদা,
// বেশি রক্ষণশীল ratio ব্যবহার করা হয় এবং বাকি (Latin/সংখ্যা/স্পেস) অংশের জন্য
// আগের 4-char ratio-ই রাখা হয়েছে। ফলাফল একটা mixed-script-aware estimate।
const BANGLA_CHARS_PER_TOKEN = 1.6;
const LATIN_CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
  if (!text) return 0;
  let banglaChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x0980 && code <= 0x09ff) {
      banglaChars++;
    } else if (!/\s/.test(ch)) {
      // whitespace token cost নগণ্য, শুধু non-space non-Bangla char count করি
      otherChars++;
    }
  }
  return Math.ceil(banglaChars / BANGLA_CHARS_PER_TOKEN) + Math.ceil(otherChars / LATIN_CHARS_PER_TOKEN);
}

// একটা টেক্সটের মধ্যে maxChars না, বরং maxTokens বাজেটে ফিট করার জন্য
// প্রয়োজনীয় char length বের করে দেয় — mixed script-এ char count আর token
// count সরাসরি সমানুপাতিক না, তাই আগের মতো "tokens * 4 = chars" হিসাব ভুল ছিল।
// এখানে প্রথমে ধরে নিই পুরো টেক্সট বাংলা-heavy (worst case, বেশি রক্ষণশীল),
// তারপর actual estimate দিয়ে যাচাই করে দরকার হলে ছোট করি।
function charsForTokenBudget(text, maxTokens) {
  if (!text) return 0;
  // worst-case ধরে নেই: pure Bangla হলে char count সবচেয়ে কম লাগবে token budget পূরণ করতে,
  // তাই conservative bound হিসেবে BANGLA ratio দিয়ে upper-bound char count বের করি,
  // তারপর actual mixed-script estimate দিয়ে বাইনারি-স্টাইল ট্রিম করে সঠিক জায়গায় আনি।
  let approxChars = Math.floor(maxTokens * BANGLA_CHARS_PER_TOKEN);
  if (approxChars >= text.length) return text.length;
  // approxChars থেকে শুরু করে ছোট করতে করতে actual estimate বাজেটে না ঢোকা পর্যন্ত
  while (approxChars > 0 && estimateTokens(text.slice(0, approxChars)) > maxTokens) {
    approxChars = Math.floor(approxChars * 0.9);
  }
  return approxChars;
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
  const systemTokenBudget = Math.floor(TOKEN_BUDGET * 0.35);
  if (estimateTokens(system) > systemTokenBudget) {
    const maxChars = charsForTokenBudget(system, systemTokenBudget);
    system = system.slice(0, maxChars) + '\n\n[Instructions shortened for length.]';
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
      const maxChars = charsForTokenBudget(msg.content, remainingTokens);
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
