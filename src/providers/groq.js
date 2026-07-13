const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// একাধিক key: GROQ_API_KEYS=key1,key2,key3  (অথবা একটাই হলে GROQ_API_KEY)
const apiKeys = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

let nextKeyIndex = 0;

function isQuotaOrKeyError(status) {
  return status === 429 || status === 403 || status === 401;
}

// history: [{ role: 'user' | 'assistant', content: string }]
export async function callGroq(systemPrompt, history) {
  if (apiKeys.length === 0) {
    return { ok: false, error: 'Groq is not configured (no GROQ_API_KEY / GROQ_API_KEYS).' };
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
  ];

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
          max_tokens: 4000,
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
