const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

// একাধিক key: ANTHROPIC_API_KEYS=key1,key2,key3  (অথবা একটাই হলে ANTHROPIC_API_KEY)
const apiKeys = (process.env.ANTHROPIC_API_KEYS || process.env.ANTHROPIC_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

let nextKeyIndex = 0;

function isQuotaOrKeyError(status) {
  return status === 429 || status === 403 || status === 401;
}

// history: [{ role: 'user' | 'assistant', content: string }]
export async function callAnthropicAI(systemPrompt, history) {
  if (apiKeys.length === 0) {
    return { ok: false, error: 'Anthropic is not configured (no ANTHROPIC_API_KEY / ANTHROPIC_API_KEYS).' };
  }

  const messages = history.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  let lastError = 'The AI did not return a reply.';

  for (let attempt = 0; attempt < apiKeys.length; attempt++) {
    const key = apiKeys[nextKeyIndex];
    nextKeyIndex = (nextKeyIndex + 1) % apiKeys.length;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          system: systemPrompt,
          messages,
          max_tokens: 8000,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        const block = data && data.content && data.content.find((c) => c.type === 'text');
        if (block && block.text) return { ok: true, text: block.text, provider: 'anthropic' };
        lastError = 'The AI did not return a reply.';
        continue;
      }

      lastError = (data && data.error && data.error.message) || `Anthropic returned an error (status ${response.status}).`;

      if (isQuotaOrKeyError(response.status) && attempt < apiKeys.length - 1) {
        continue;
      }
      if (!isQuotaOrKeyError(response.status)) {
        return { ok: false, error: lastError };
      }
    } catch (err) {
      lastError = 'Could not reach Anthropic.';
    }
  }

  return { ok: false, error: lastError };
}
