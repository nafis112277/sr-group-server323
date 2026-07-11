import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db.js';
import { signAdminToken, requireAdmin } from '../auth.js';
import { getSettings, setSettings } from '../settings.js';

const router = Router();

router.post('/login', async (req, res) => {
  try {
    const { passcode } = req.body || {};
    if (!passcode) return res.status(400).json({ error: 'Enter the admin passcode.' });

    const row = await queryOne('SELECT passcode_hash FROM admin_auth WHERE id = 1');
    if (!row) return res.status(500).json({ error: 'Admin account not initialized yet.' });

    const match = await bcrypt.compare(passcode, row.passcode_hash);
    if (!match) return res.status(401).json({ error: 'Wrong passcode.' });

    res.json({ token: signAdminToken() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// এর নিচের সব রুটে admin token লাগবে
router.use(requireAdmin);

router.get('/customers', async (req, res) => {
  try {
    const rows = await query(
      `SELECT name, email, created_at AS "createdAt", last_login_at AS "lastLoginAt", blocked
       FROM users ORDER BY created_at DESC`
    );
    res.json({ customers: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load customers.' });
  }
});

router.post('/customers/:email/block', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const user = await queryOne('SELECT blocked FROM users WHERE email = $1', [email]);
    if (!user) return res.status(404).json({ error: 'Customer not found.' });

    await query('UPDATE users SET blocked = $1 WHERE email = $2', [!user.blocked, email]);
    res.json({ blocked: !user.blocked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update this customer.' });
  }
});

router.get('/customers/:email/conversations', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const rows = await query(
      'SELECT id, title, updated_at AS "updatedAt" FROM conversations WHERE user_email = $1 ORDER BY updated_at DESC',
      [email]
    );
    res.json({ conversations: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load conversations.' });
  }
});

router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const rows = await query('SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id ASC', [
      req.params.id,
    ]);
    res.json({ messages: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load messages.' });
  }
});

router.get('/settings', async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load settings.' });
  }
});

router.post('/settings', async (req, res) => {
  try {
    const { desc, tone, facts } = req.body || {};
    await setSettings({ desc, tone, facts });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save settings.' });
  }
});

router.post('/passcode', async (req, res) => {
  try {
    const { current, next } = req.body || {};
    if (!current || !next) return res.status(400).json({ error: 'Fill in all fields.' });
    if (next.length < 6) return res.status(400).json({ error: 'New passcode should be at least 6 characters.' });

    const row = await queryOne('SELECT passcode_hash FROM admin_auth WHERE id = 1');
    const match = await bcrypt.compare(current, row.passcode_hash);
    if (!match) return res.status(401).json({ error: 'Current passcode is incorrect.' });

    const newHash = await bcrypt.hash(next, 10);
    await query('UPDATE admin_auth SET passcode_hash = $1 WHERE id = 1', [newHash]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update passcode.' });
  }
});

export default router;
