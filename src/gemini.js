const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// একাধিক key কমা দিয়ে আলাদা করে GEMINI_API_KEYS-এ দেওয়া যায়:
//   GEMINI_API_KEYS=key1,key2,key3
// পুরনো সেটআপের সাথে সামঞ্জস্য রাখতে GEMINI_API_KEY (একটা key) থাকলে সেটাও কাজ করবে।
const apiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

// প্রতিটা রিকোয়েস্টে পরের key দিয়ে শুরু হয়, যাতে লোড সব key-র মধ্যে ভাগ হয়ে যায়
let nextKeyIndex = 0;

function isQuotaOrKeyError(status) {
  // 429 = quota/rate limit শেষ, 403/401 = key invalid বা permission নেই
  return status === 429 || status === 403 || status === 401;
}

// history: [{ role: 'user' | 'assistant', content: string }]
export async function callGemini(systemPrompt, history) {
  if (apiKeys.length === 0) {
    return {
      ok: false,
      error: 'Server has no GEMINI_API_KEY / GEMINI_API_KEYS configured. Add it to .env (or Render Environment Variables) and restart.',
    };
  }

  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  let lastError = 'The AI did not return a reply.';

  // প্রতিটা key একবার করে ট্রাই করা হয় — কোনোটা quota/invalid হলে পরেরটায় চলে যায়
  for (let attempt = 0; attempt < apiKeys.length; attempt++) {
    const key = apiKeys[nextKeyIndex];
    nextKeyIndex = (nextKeyIndex + 1) % apiKeys.length;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key,
          },
          body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: { maxOutputTokens: 1000 },
          }),
        }
      );

      const data = await response.json();

      if (response.ok) {
        const candidate = data && data.candidates && data.candidates[0];
        const parts = candidate && candidate.content && candidate.content.parts;
        if (parts && parts.length) {
          const text = parts.map((p) => p.text || '').filter(Boolean).join('\n');
          if (text) return { ok: true, text };
        }
        lastError = 'The AI did not return a reply.';
        continue; // খালি রেসপন্স হলেও পরের key দিয়ে একবার ট্রাই করা ভালো
      }

      lastError = (data && data.error && data.error.message) || `Gemini returned an error (status ${response.status}).`;

      if (isQuotaOrKeyError(response.status) && attempt < apiKeys.length - 1) {
        continue; // এই key-র quota শেষ বা invalid — পরের key দিয়ে চেষ্টা করো
      }

      // quota/key সমস্যা না হলে (যেমন bad request), আরও key ট্রাই করে লাভ নেই
      if (!isQuotaOrKeyError(response.status)) {
        return { ok: false, error: lastError };
      }
    } catch (err) {
      lastError = 'Could not reach the AI provider.';
      // নেটওয়ার্ক সমস্যা হলেও পরের key দিয়ে একবার ট্রাই করা হয়
    }
  }

  return { ok: false, error: lastError };
}
