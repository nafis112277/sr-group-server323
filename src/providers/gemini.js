const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// একাধিক key কমা দিয়ে আলাদা করে GEMINI_API_KEYS-এ দেওয়া যায়:
//   GEMINI_API_KEYS=key1,key2,key3
// পুরনো সেটআপের সাথে সামঞ্জস্য রাখতে GEMINI_API_KEY (একটা key) থাকলে সেটাও কাজ করবে।
const apiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

let nextKeyIndex = 0;

function isQuotaOrKeyError(status) {
  return status === 429 || status === 403 || status === 401;
}

// history: [{ role: 'user' | 'assistant', content: string }]
export async function callGemini(systemPrompt, history) {
  if (apiKeys.length === 0) {
    return { ok: false, error: 'Gemini is not configured (no GEMINI_API_KEY / GEMINI_API_KEYS).' };
  }

  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  let lastError = 'The AI did not return a reply.';

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
            generationConfig: { maxOutputTokens: 8000 },
          }),
        }
      );

      const data = await response.json();

      if (response.ok) {
        const candidate = data && data.candidates && data.candidates[0];
        const parts = candidate && candidate.content && candidate.content.parts;
        if (parts && parts.length) {
          const text = parts.map((p) => p.text || '').filter(Boolean).join('\n');
          if (text) return { ok: true, text, provider: 'gemini' };
        }
        lastError = 'The AI did not return a reply.';
        continue;
      }

      lastError = (data && data.error && data.error.message) || `Gemini returned an error (status ${response.status}).`;

      if (isQuotaOrKeyError(response.status) && attempt < apiKeys.length - 1) {
        continue;
      }
      if (!isQuotaOrKeyError(response.status)) {
        return { ok: false, error: lastError };
      }
    } catch (err) {
      lastError = 'Could not reach Gemini.';
    }
  }

  return { ok: false, error: lastError };
}
