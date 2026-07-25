import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { callAI } from '../ai.js';

const router = Router();

// প্রতিটা API key-এর নিজের দৈনিক লিমিট ট্র্যাক করে; নতুন দিন শুরু হলে counter রিসেট হয়
async function requireApiKey(req, res, next) {
  const key = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!key) return res.status(401).json({ error: 'Missing API key. Use: Authorization: Bearer YOUR_KEY' });

  const row = await queryOne('SELECT * FROM api_keys WHERE key = $1', [key]);
  if (!row || !row.active) return res.status(401).json({ error: 'Invalid or inactive API key.' });

  const today = new Date().toISOString().slice(0, 10);
  let requestsToday = row.requests_today;
  if (row.last_reset_date.toISOString().slice(0, 10) !== today) {
    requestsToday = 0;
    await query('UPDATE api_keys SET requests_today = 0, last_reset_date = $1 WHERE id = $2', [today, row.id]);
  }

  if (requestsToday >= row.daily_limit) {
    return res.status(429).json({ error: `Daily limit of ${row.daily_limit} requests reached for this key.` });
  }

  req.apiKeyRow = row;
  next();
}

router.post('/chat/completions', requireApiKey, async (req, res) => {
  try {
    const { messages, system } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required, e.g. [{ "role": "user", "content": "hi" }]' });
    }

    const systemPrompt = system || 'You are a helpful assistant.';
    const result = await callAI(systemPrompt, messages, {});

    await query(
      'UPDATE api_keys SET requests_today = requests_today + 1, last_used_at = now() WHERE id = $1',
      [req.apiKeyRow.id]
    );

    if (!result.ok) return res.status(502).json({ error: result.error });

    res.json({
      id: 'chatcmpl-' + Date.now(),
      reply: result.text,
      provider: result.provider || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

export default router;
