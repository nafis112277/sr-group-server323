// providers/deepseek.js
// DeepSeek-এর API OpenAI-compatible (একই request/response shape),
// তাই সরাসরি fetch দিয়ে কল করা হচ্ছে — কোনো আলাদা SDK লাগছে না।

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

// history: [{ role: 'user' | 'assistant', content: string, images?: [{base64, mimeType}] }]
// DeepSeek-এর chat model (deepseek-chat) ছবি সাপোর্ট করে না, তাই ছবি থাকলে
// শুধু টেক্সট অংশটা পাঠানো হচ্ছে (crash না করে গ্রেসফুলি skip)।
export async function callDeepSeek(systemPrompt, history, options = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'DEEPSEEK_API_KEY is not set in environment variables.' };
  }

  const messages = [
    { role: 'system', content: systemPrompt || '' },
    ...history.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || '',
    })),
  ];

  try {
    const res = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        temperature: 0.7,
        max_tokens: 2000,
      }),
    });

    if (!res.ok) {
      let errBody = '';
      try { errBody = JSON.stringify(await res.json()); } catch (e) { /* ignore */ }
      return { ok: false, error: `DeepSeek API error (${res.status}): ${errBody || res.statusText}` };
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      return { ok: false, error: 'DeepSeek returned an empty response.' };
    }

    return { ok: true, text, images: null };
  } catch (err) {
    return { ok: false, error: `DeepSeek request failed: ${err.message}` };
  }
}
