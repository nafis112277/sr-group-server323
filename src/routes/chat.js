import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { requireUser } from '../auth.js';
import { callGemini } from '../gemini.js';
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

router.post('/conversations/:id/message', async (req, res) => {
  try {
    const conv = await queryOne('SELECT * FROM conversations WHERE id = $1 AND user_email = $2', [
      req.params.id,
      req.userEmail,
    ]);
    if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

    const text = ((req.body || {}).content || '').trim();
    if (!text) return res.status(400).json({ error: 'Message is empty.' });

    await query('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)', [
      conv.id,
      'user',
      text,
    ]);

    const history = await query('SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id ASC', [
      conv.id,
    ]);
    const system = buildSystemPrompt(await getSettings());
    const result = await callGemini(system, history);

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
