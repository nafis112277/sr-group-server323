import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { requireUser } from '../auth.js';
import { callGemini } from '../gemini.js';
import { getSettings, buildSystemPrompt } from '../settings.js';
import { sendAdminAlert } from '../mailer.js';

const router = Router();
router.use(requireUser);

// কোনো customer message এ এই ধরনের প্যাটার্ন থাকলে admin কে গোপন ইমেইলে alert যাবে
const SUSPICIOUS_PATTERNS = /\b(hack|hacking|malware|virus|ddos|exploit|phishing|ransomware|keylogger|sql injection|bypass (the )?security|ignore (all )?(previous|prior) instructions|reveal your (system prompt|instructions)|jailbreak)\b/i;

// AI এর reply তে [GENERATE_IMAGE: description] থাকলে সেটাকে আসল ছবিতে বদলে দেয়
// (Pollinations.ai — সম্পূর্ণ ফ্রি, কোনো key লাগে না)
function resolveImageMarkers(text) {
  const match = text.match(/\[GENERATE_IMAGE:\s*(.+?)\]/i);
  if (!match) return text;
  const prompt = match[1].trim();
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
  return text.replace(match[0], `![${prompt}](${imageUrl})`);
}

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

    const settings = await getSettings();

    const dailyLimit = settings.dailyLimit || 40;
    if (dailyLimit > 0) {
      const usageRow = await queryOne(
        `SELECT COUNT(*)::int AS count FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.user_email = $1 AND m.role = 'user' AND m.created_at >= date_trunc('day', now())`,
        [req.userEmail]
      );
      const usedToday = (usageRow && usageRow.count) || 0;
      if (usedToday >= dailyLimit) {
        return res.status(429).json({
          error: `You've reached today's message limit (${dailyLimit}). Please try again tomorrow, or contact SR Group directly for urgent help.`,
        });
      }
    }

    // rule-breaking মনে হওয়া message হলে admin কে চুপচাপ alert পাঠানো হয় — customer এর chat আটকায় না
    if (SUSPICIOUS_PATTERNS.test(text)) {
      sendAdminAlert(
        'Possible rule-breaking request from a customer',
        `Customer: ${req.userEmail}\nMessage: ${text}\nTime: ${new Date().toISOString()}`
      ).catch(() => {});
    }

    await query('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)', [
      conv.id,
      'user',
      text,
    ]);

    const history = await query('SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id ASC', [
      conv.id,
    ]);

    const userRow = await queryOne(
      'SELECT custom_preference AS "customPreference" FROM users WHERE email = $1',
      [req.userEmail]
    );
    const system = buildSystemPrompt(settings, userRow && userRow.customPreference);

    const result = await callGemini(system, history);
    if (!result.ok) {
      return res.status(502).json({ error: result.error });
    }

    const finalText = resolveImageMarkers(result.text);

    await query('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)', [
      conv.id,
      'assistant',
      finalText,
    ]);

    let title = conv.title;
    if (title === 'New chat') title = text.slice(0, 40);
    await query('UPDATE conversations SET updated_at = now(), title = $1 WHERE id = $2', [title, conv.id]);

    res.json({ reply: finalText, title });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong sending your message.' });
  }
});

export default router;
