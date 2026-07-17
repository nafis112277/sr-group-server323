import { getSettings, setSettings, buildSystemPrompt } from '../settings.js';
import { callAI } from '../ai.js';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db.js';
import { signAdminToken, requireAdmin, requireSuperAdmin } from '../auth.js';
import { getSettings, setSettings } from '../settings.js';

const router = Router();

// ---- Login: email + password ----
router.post('/login', async (req, res) => {
  try {
    const { email: rawEmail, password } = req.body || {};
    const email = (rawEmail || '').trim().toLowerCase();
    if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });

    const admin = await queryOne('SELECT * FROM admins WHERE email = $1', [email]);
    if (!admin) return res.status(404).json({ error: 'No admin account found with that email.' });

    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password.' });

    const token = signAdminToken(admin);
    res.json({ token, admin: { name: admin.name, email: admin.email, role: admin.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// এর নিচের সব রুটে admin token লাগবে
router.use(requireAdmin);
// Admin panel theke shorashori assistant test korar jonno — kono conversation save hoy na,
// kono customer quota-o count hoy na, shudhu current AI settings diye ekbar reply dey.
router.post('/test-chat', async (req, res) => {
  try {
    const { content, history } = req.body || {};
    const text = (content || '').trim();
    if (!text) return res.status(400).json({ error: 'Message is empty.' });

    const settings = await getSettings();
    const system = buildSystemPrompt(settings, '');

    const safeHistory = Array.isArray(history) ? history.slice(-20) : [];
    const fullHistory = [...safeHistory, { role: 'user', content: text }];

    const result = await callAI(system, fullHistory, {});
    if (!result.ok) return res.status(502).json({ error: result.error });

    res.json({ reply: result.text || '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Test chat failed.' });
  }
});
router.get('/customers', async (req, res) => {
  try {
    const rows = await query(
      `SELECT name, email, created_at AS "createdAt", last_login_at AS "lastLoginAt", blocked,
              daily_limit AS "dailyLimit"
       FROM users ORDER BY created_at DESC`
    );
    res.json({ customers: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load customers.' });
  }
});

router.post('/customers/:email/block', requireSuperAdmin, async (req, res) => {
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

router.post('/customers/:email/quota', requireSuperAdmin, async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    let { dailyLimit } = req.body || {};

    if (dailyLimit === null || dailyLimit === undefined || dailyLimit === '') {
      dailyLimit = null;
    } else {
      dailyLimit = parseInt(dailyLimit, 10);
      if (Number.isNaN(dailyLimit) || dailyLimit < 0) {
        return res.status(400).json({ error: 'Enter a valid non-negative number, or leave it empty for the default.' });
      }
    }

    const user = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
    if (!user) return res.status(404).json({ error: 'Customer not found.' });

    await query('UPDATE users SET daily_limit = $1 WHERE email = $2', [dailyLimit, email]);
    res.json({ ok: true, dailyLimit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update this customer's limit." });
  }
});

router.post('/customers/:email/reset-password', requireSuperAdmin, async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const user = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
    if (!user) return res.status(404).json({ error: 'Customer not found.' });

    const tempPassword = Math.random().toString(36).slice(-5) + Math.random().toString(36).slice(-5);
    const newHash = await bcrypt.hash(tempPassword, 10);
    await query('UPDATE users SET password_hash = $1 WHERE email = $2', [newHash, email]);

    res.json({ ok: true, tempPassword });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not reset this customer's password." });
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

router.get('/settings', requireSuperAdmin, async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load settings.' });
  }
});

router.post('/settings', requireSuperAdmin, async (req, res) => {
  try {
    const { desc, tone, facts, dailyLimit } = req.body || {};
    await setSettings({ desc, tone, facts, dailyLimit });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save settings.' });
  }
});

// ---- নিজের password change (My account tab) ----
router.post('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Fill in all fields.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password should be at least 6 characters.' });
    }

    const admin = await queryOne('SELECT password_hash FROM admins WHERE id = $1', [req.adminId]);
    if (!admin) return res.status(404).json({ error: 'Admin account not found.' });

    const match = await bcrypt.compare(currentPassword, admin.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE admins SET password_hash = $1 WHERE id = $2', [newHash, req.adminId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update password.' });
  }
});

// ---- Admins CRUD (super admin only) ----
router.get('/admins', requireSuperAdmin, async (req, res) => {
  try {
    const admin = await queryOne('SELECT email FROM admins WHERE id = $1', [req.adminId]);
    const rows = await query(
      'SELECT id, name, email, role, created_at AS "createdAt" FROM admins ORDER BY created_at ASC'
    );
    res.json({ admins: rows, selfEmail: admin ? admin.email : '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load admins.' });
  }
});

router.post('/admins', requireSuperAdmin, async (req, res) => {
  try {
    const { name, email: rawEmail, password, role } = req.body || {};
    const email = (rawEmail || '').trim().toLowerCase();
    if (!name || !email || !password) return res.status(400).json({ error: 'Fill in name, email, and password.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password should be at least 6 characters.' });
    const finalRole = role === 'super_admin' ? 'super_admin' : 'viewer';

    const existing = await queryOne('SELECT id FROM admins WHERE email = $1', [email]);
    if (existing) return res.status(409).json({ error: 'An admin with this email already exists.' });

    const hash = await bcrypt.hash(password, 10);
    await query('INSERT INTO admins (name, email, password_hash, role) VALUES ($1, $2, $3, $4)', [
      name, email, hash, finalRole,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not add this admin.' });
  }
});

router.post('/admins/:id/role', requireSuperAdmin, async (req, res) => {
  try {
    const { role } = req.body || {};
    const finalRole = role === 'super_admin' ? 'super_admin' : 'viewer';
    const id = parseInt(req.params.id, 10);

    if (id === req.adminId) return res.status(400).json({ error: "You can't change your own role." });

    const target = await queryOne('SELECT id FROM admins WHERE id = $1', [id]);
    if (!target) return res.status(404).json({ error: 'Admin not found.' });

    await query('UPDATE admins SET role = $1 WHERE id = $2', [finalRole, id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update this admin's role." });
  }
});

router.delete('/admins/:id', requireSuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.adminId) return res.status(400).json({ error: "You can't remove your own account." });

    const target = await queryOne('SELECT id FROM admins WHERE id = $1', [id]);
    if (!target) return res.status(404).json({ error: 'Admin not found.' });

    await query('DELETE FROM admins WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove this admin.' });
  }
});

// ---- Analytics (both roles can view) ----
router.get('/analytics', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));

    const dauRows = await query(
      `SELECT to_char(d::date, 'YYYY-MM-DD') AS date,
              COALESCE(cnt.count, 0)::int AS count
       FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
       LEFT JOIN (
         SELECT date_trunc('day', m.created_at)::date AS day, COUNT(DISTINCT c.user_email)::int AS count
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.role = 'user' AND m.created_at >= current_date - ($1::int - 1)
         GROUP BY 1
       ) cnt ON cnt.day = d::date
       ORDER BY d`,
      [days]
    );

    const volumeRows = await query(
      `SELECT to_char(d::date, 'YYYY-MM-DD') AS date,
              COALESCE(cnt.count, 0)::int AS count
       FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
       LEFT JOIN (
         SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
         FROM messages
         WHERE role = 'user' AND created_at >= current_date - ($1::int - 1)
         GROUP BY 1
       ) cnt ON cnt.day = d::date
       ORDER BY d`,
      [days]
    );

    const topQuestions = await query(
      `SELECT content AS question, COUNT(*)::int AS count
       FROM messages
       WHERE role = 'user' AND content <> '' AND created_at >= current_date - ($1::int - 1)
       GROUP BY content
       HAVING COUNT(*) > 1
       ORDER BY count DESC
       LIMIT 8`,
      [days]
    );

    res.json({ dailyActiveUsers: dauRows, messageVolume: volumeRows, topQuestions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load analytics.' });
  }
});

export default router;
