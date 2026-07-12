import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { requireUser } from '../auth.js';
import { callAI } from '../ai.js';
import { getSettings, buildSystemPrompt } from '../settings.js';

const router = Router();
router.use(requireUser);

router.get('/conversations', async (req, res) => {
  try {
    const rows = await query(
      'SELECT id, title, updated_at AS "updatedAt" FROM conversations WHERE user_email = $1 ORDER BY updated_at DESC',
      [req.userEmail]
    );
    res.json({ conversations: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load conversations.' });
  }
});

router.post('/conversations', async (req, res) => {
  try {
    const row = await queryOne(
      `INSERT INTO conversations (user_email, title) VALUES ($1, 'New chat')
       RETURNING id, title, updated_at AS "updatedAt"`,
      [req.userEmail]
    );
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start a new chat.' });
  }
});

router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const conv = await queryOne('SELECT * FROM conversations WHERE id = $1 AND user_email = $2', [
      req.params.id,
      req.userEmail,
    ]);
    if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

    const rows = await query('SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id ASC', [
      conv.id,
    ]);
    res.json({ messages: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load messages.' });
  }
});

// এই কাস্টমার নিজের জন্য AI-কে কীভাবে চলতে বলছে (স্টাইল/টপিক পছন্দ) — admin-এর core rules-এর উপরে বসে, নিচে না
router.get('/preferences', async (req, res) => {
  try {
    const row = await queryOne('SELECT custom_instructions AS "customInstructions" FROM users WHERE email = $1', [
      req.userEmail,
    ]);
    res.json({ customInstructions: (row && row.customInstructions) || '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load your preferences.' });
  }
});

router.post('/preferences', async (req, res) => {
  try {
    let { customInstructions } = req.body || {};
    customInstructions = (customInstructions || '').toString().slice(0, 2000);
    await query('UPDATE users SET custom_instructions = $1 WHERE email = $2', [customInstructions, req.userEmail]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save your preferences.' });
  }
});

router.post('/conversations/:id/message', async (req, res) => {
  try {
    const conv = await queryOne('SELECT * FROM conversations WHERE id = $1 AND user_email = $2', [
      req.params.id,
      req.userEmail,
    ]);
    if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

    const text = ((req.body || {}).content || '').trim();
    if (!text) return res.status(400).json({ error: 'Message is empty.' });

    const [user, aiSettings] = await Promise.all([
      queryOne('SELECT daily_limit AS "dailyLimit", custom_instructions AS "customInstructions" FROM users WHERE email = $1', [
        req.userEmail,
      ]),
      getSettings(),
    ]);

    const limit =
      user && user.dailyLimit !== null && user.dailyLimit !== undefined ? user.dailyLimit : aiSettings.dailyLimit;

    if (limit && limit > 0) {
      const countRow = await queryOne(
        `SELECT COUNT(*)::int AS count FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.user_email = $1 AND m.role = 'user' AND m.created_at >= date_trunc('day', now())`,
        [req.userEmail]
      );
      if (countRow.count >= limit) {
        return res.status(429).json({
          error: `You've reached today's message limit (${limit}). Please try again tomorrow, or contact SR Group.`,
        });
      }
    }

    await query('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)', [
      conv.id,
      'user',
      text,
    ]);

    const history = await query('SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id ASC', [
      conv.id,
    ]);
    const system = buildSystemPrompt(aiSettings, user && user.customInstructions);
    const result = await callAI(system, history);

    if (!result.ok) {
      return res.status(502).json({ error: result.error });
    }

    await query('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)', [
      conv.id,
      'assistant',
      result.text,
    ]);

    let title = conv.title;
    if (title === 'New chat') title = text.slice(0, 40);

    await query('UPDATE conversations SET updated_at = now(), title = $1 WHERE id = $2', [title, conv.id]);

    res.json({ reply: result.text, title });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong sending your message.' });
  }
});

export default router;
