const LOCAL_AI_URL = process.env.LOCAL_AI_URL || 'http://127.0.0.1:8000';

export async function callLocal(systemPrompt, history, options = {}) {
  try {
    const messages = (history || []).map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch(`${LOCAL_AI_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: systemPrompt, messages }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: `Local AI error (${res.status}): ${errText.slice(0, 200)}` };
    }

    const data = await res.json();
    return { ok: true, text: data.text || '' };
  } catch (err) {
    return { ok: false, error: 'Local AI service is not reachable: ' + err.message };
  }
}
