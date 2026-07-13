// TEXT + IMAGE dutoi ekshathe generate korte pare emon model — "Nano Banana"
// pura chat-e always eita use hobe, jate AI nijei prompt onujayi image ditey pare.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-image';
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
// history: [{ role: 'user' | 'assistant', content: string, images?: [{base64, mimeType}] }]
// options: { webSearch?: boolean } — true hole Google Search grounding tool jog hoy.
export async function callGemini(systemPrompt, history, options = {}) {
  const { webSearch = false } = options;
  if (apiKeys.length === 0) {
    return { ok: false, error: 'Gemini is not configured (no GEMINI_API_KEY / GEMINI_API_KEYS).' };
  }

  // FIX: age shudhu text pathano hoto, image data ignore hoye jeto.
  // ekhon prottek message-er images (thakle) inlineData part hishebe jure dei,
  // jate Gemini customer-er uploaded chobi ta actually dekhte pay.
  const contents = history.map((m) => {
    const parts = [];
    if (m.content) parts.push({ text: m.content });
    if (Array.isArray(m.images)) {
      for (const img of m.images) {
        if (img && img.base64) {
          parts.push({
            inlineData: {
              mimeType: img.mimeType || 'image/png',
              data: img.base64,
            },
          });
        }
      }
    }
    // dutoi khali hoile Gemini empty parts array niye error dey, tai fallback text rakhi
    if (parts.length === 0) parts.push({ text: '' });
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts,
    };
  });

  // NOTE: Google Search grounding shadharonoto text-only model-er jonno design kora.
  // ei model TEXT+IMAGE dutoi generate kore, tai googleSearch tool combine korle
  // API bhalo error dite pare — shei khetre niche catch kore lastError set hoy,
  // ar ai.js-er fallback chain porer provider-e switch kore.
  const requestBody = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      maxOutputTokens: 8000,
      // Model-ke text ebong image duitai generate korar permission deওয়া hocche;
      // model nijei bujhe dorkar mone korle image return korbe, na hole shudhu text.
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };
  if (webSearch) {
    requestBody.tools = [{ googleSearch: {} }];
  }

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
          body: JSON.stringify(requestBody),
        }
      );
      const data = await response.json();
      if (response.ok) {
        const candidate = data && data.candidates && data.candidates[0];
        const parts = candidate && candidate.content && candidate.content.parts;
        if (parts && parts.length) {
          const textChunks = [];
          const images = [];
          for (const p of parts) {
            if (p.text) {
              textChunks.push(p.text);
            } else if (p.inlineData && p.inlineData.data) {
              images.push({
                base64: p.inlineData.data,
                mimeType: p.inlineData.mimeType || 'image/png',
              });
            }
          }
          let text = textChunks.join('\n');

          // webSearch on thakle ebong grounding metadata thakle, source link-gulo
          // reply-r niche short list hishebe jure dei jate customer source dekhte pare.
          const groundingChunks =
            candidate && candidate.groundingMetadata && candidate.groundingMetadata.groundingChunks;
          if (webSearch && Array.isArray(groundingChunks) && groundingChunks.length) {
            const links = groundingChunks
              .map((c) => c.web && c.web.uri && c.web.title ? `- [${c.web.title}](${c.web.uri})` : null)
              .filter(Boolean)
              .slice(0, 5);
            if (links.length) {
              text += '\n\nSources:\n' + links.join('\n');
            }
          }

          if (text || images.length) {
            return {
              ok: true,
              text,
              images: images.length ? images : null,
              provider: 'gemini',
            };
          }
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
