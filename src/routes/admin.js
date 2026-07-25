import { getSettings, setSettings, buildSystemPrompt, getBroadcast, setBroadcast } from '../settings.js';
import { callAI } from '../ai.js';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db.js';
import { signAdminToken, requireAdmin, requireSuperAdmin } from '../auth.js';

const router = Router();

// email params সবসময় এভাবে normalize করা হবে যাতে encoded/uppercase email-এও lookup ঠিকমতো কাজ করে
function normalizeEmailParam(raw) {
  return decodeURIComponent(raw || '').trim().toLowerCase();
}

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
router.get('/maintenance-status', async (req, res) => {
  try {
    res.json(await getMaintenanceStatus());
  } catch (err) {
    console.error(err);
    res.json({ active: false, message: '' }); // ব্যর্থ হলে "বন্ধ" ধরে নেওয়াই নিরাপদ
  }
});
// এর নিচের সব রুটে admin token লাগবে
router.use(requireAdmin);
// ---- API keys (super admin only) ----
router.get('/api-keys', requireSuperAdmin, async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, label, key, active, daily_limit AS "dailyLimit", requests_today AS "requestsToday",
              created_at AS "createdAt", last_used_at AS "lastUsedAt"
       FROM api_keys ORDER BY created_at DESC`
    );
    res.json({ keys: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load API keys.' });
  }
});

router.post('/api-keys', requireSuperAdmin, async (req, res) => {
  try {
    const { label, dailyLimit } = req.body || {};
    if (!label) return res.status(400).json({ error: 'Enter a label for this key.' });

    const key = 'sk-' + [...Array(40)].map(() => Math.random().toString(36)[2] || '0').join('');
    const limit = parseInt(dailyLimit, 10) || 200;

    await query('INSERT INTO api_keys (label, key, daily_limit) VALUES ($1, $2, $3)', [label, key, limit]);
    res.json({ ok: true, key });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create API key.' });
  }
});

router.post('/api-keys/:id/toggle', requireSuperAdmin, async (req, res) => {
  try {
    const row = await queryOne('SELECT active FROM api_keys WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Key not found.' });
    await query('UPDATE api_keys SET active = $1 WHERE id = $2', [!row.active, req.params.id]);
    res.json({ ok: true, active: !row.active });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update key.' });
  }
});

router.delete('/api-keys/:id', requireSuperAdmin, async (req, res) => {
  try {
    await query('DELETE FROM api_keys WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete key.' });
  }
});

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
              daily_limit AS "dailyLimit", payment_due_date AS "paymentDueDate"
       FROM users ORDER BY created_at DESC`
    );
    res.json({ customers: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load customers.' });
  }
});
// FIX: নতুন রুট — client payment করলে admin এখান থেকে তার plan (free/pro/max) বদলাতে পারবে।
const VALID_PLANS = ['free', 'pro', 'max'];

router.post('/customers/:email/plan', requireSuperAdmin, async (req, res) => {
  try {
    const { plan } = req.body || {};
    if (!VALID_PLANS.includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Must be free, pro, or max.' });
    }

    const email = normalizeEmailParam(req.params.email);
    const user = await queryOne('SELECT email FROM users WHERE email = $1', [email]);
    if (!user) return res.status(404).json({ error: 'Customer not found.' });

    await query('UPDATE users SET plan = $1 WHERE email = $2', [plan, email]);
    res.json({ ok: true, email, plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update plan.' });
  }
});
router.post('/customers/:email/payment-due', requireSuperAdmin, async (req, res) => {
  try {
    const email = normalizeEmailParam(req.params.email);
    let { dueDate } = req.body || {};

    if (dueDate === null || dueDate === undefined || dueDate === '') {
      dueDate = null;
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return res.status(400).json({ error: 'তারিখ সঠিক ফরম্যাটে দিন (YYYY-MM-DD)।' });
    }

    const user = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
    if (!user) return res.status(404).json({ error: 'Customer not found.' });

    await query('UPDATE users SET payment_due_date = $1, blocked = false WHERE email = $2', [dueDate, email]);
    res.json({ ok: true, dueDate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update payment due date.' });
  }
});
router.post('/customers/:email/block', requireSuperAdmin, async (req, res) => {
  try {
    const email = normalizeEmailParam(req.params.email);
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
    const email = normalizeEmailParam(req.params.email);
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
    const email = normalizeEmailParam(req.params.email);
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

// ---- Delete an inactive customer (never logged in) — super admin only ----
// "কখনো ব্যবহার করেনি" মানে last_login_at NULL — সার্ভার সাইডেও এটা যাচাই করা হয়,
// শুধু frontend-এর চেকের উপর নির্ভর করা হয় না। User + তার conversations, messages,
// এবং user_skills সব cascade delete করা হয়।
router.post('/customers/:email/delete', requireSuperAdmin, async (req, res) => {
  try {
    const email = normalizeEmailParam(req.params.email);
    const user = await queryOne('SELECT id, last_login_at FROM users WHERE email = $1', [email]);
    if (!user) return res.status(404).json({ error: 'Customer not found.' });

    if (user.last_login_at) {
      return res.status(400).json({ error: 'This customer has used the chatbot before and cannot be deleted this way.' });
    }

    const convRows = await query('SELECT id FROM conversations WHERE user_email = $1', [email]);
    const convIds = convRows.map((c) => c.id);

    if (convIds.length > 0) {
      await query('DELETE FROM messages WHERE conversation_id = ANY($1::int[])', [convIds]);
      await query('DELETE FROM conversations WHERE user_email = $1', [email]);
    }

    await query('DELETE FROM user_skills WHERE user_email = $1', [email]).catch(() => { /* skills table/column না থাকলেও বাকি ডিলিট চলবে */ });

    await query('DELETE FROM users WHERE email = $1', [email]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete this customer account.' });
  }
});

router.get('/customers/:email/conversations', async (req, res) => {
  try {
    const email = normalizeEmailParam(req.params.email);
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

// ---- Broadcast/announcement banner (super admin only) ----
// GET: admin panel-এর Broadcast ট্যাব লোড হওয়ার সময় বর্তমান broadcast state দেখায়।
// POST: title/message/active সেভ করে। settings.js-এর getBroadcast/setBroadcast ব্যবহার করে,
// যেটা ai_settings টেবিলের একই singleton row-এ (id=1) রাখে — তাই টেবিলে নতুন কলাম লাগবে
// (settings.js-এর কমেন্টে মাইগ্রেশন দেওয়া আছে)।
router.get('/broadcast', requireSuperAdmin, async (req, res) => {
  try {
    res.json(await getBroadcast());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the current broadcast.' });
  }
});

router.post('/broadcast', requireSuperAdmin, async (req, res) => {
  try {
    const { title, message, active } = req.body || {};
    if (active && !(message || '').trim()) {
      return res.status(400).json({ error: 'Write a message before turning the banner on.' });
    }
    await setBroadcast({ title, message, active });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the broadcast.' });
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
// ==================================================================
// Policy / Niti Mala — সম্পূর্ণ নতুন, স্বনির্ভর ব্লক। উপরের কোনো রুট/কোড
// স্পর্শ করা হয়নি। নিজস্ব আলাদা টেবিল ব্যবহার করে।
// ==================================================================
let __policyTableReady = false;
async function ensurePolicyTable() {
  if (__policyTableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS policy_rules (
      id INT PRIMARY KEY DEFAULT 1,
      content TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      CHECK (id = 1)
    )
  `);
  await query(
    `INSERT INTO policy_rules (id, content) VALUES (1, '') ON CONFLICT (id) DO NOTHING`
  );
  __policyTableReady = true;
}

// chat.js থেকে ইমপোর্ট করে ব্যবহার হবে
export async function getPolicy() {
  await ensurePolicyTable();
  const row = await queryOne('SELECT content FROM policy_rules WHERE id = 1');
  return { content: (row && row.content) || '' };
}

router.get('/policy', requireSuperAdmin, async (req, res) => {
  try {
    res.json(await getPolicy());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load policy.' });
  }
});

router.post('/policy', requireSuperAdmin, async (req, res) => {
  try {
    const { content } = req.body || {};
    await ensurePolicyTable();
    await query('UPDATE policy_rules SET content = $1, updated_at = now() WHERE id = 1', [
      (content || '').slice(0, 20000),
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save policy.' });
  }
});
// ==================================================================
// Maintenance Mode — সম্পূর্ণ নতুন, স্বনির্ভর ব্লক। উপরের কোনো রুট/কোড
// স্পর্শ করা হয়নি। নিজস্ব আলাদা টেবিল ব্যবহার করে (settings.js/ai_settings
// এর কিছুই ছোঁয়া হয়নি) — প্রথম কলেই টেবিল নিজে থেকে তৈরি হয়ে যায়।
// ==================================================================
let __maintenanceTableReady = false;
async function ensureMaintenanceTable() {
  if (__maintenanceTableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS maintenance_mode (
      id INT PRIMARY KEY DEFAULT 1,
      active BOOLEAN NOT NULL DEFAULT false,
      message TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      CHECK (id = 1)
    )
  `);
  await query(
    `INSERT INTO maintenance_mode (id, active, message) VALUES (1, false, '') ON CONFLICT (id) DO NOTHING`
  );
  __maintenanceTableReady = true;
}

// chat.js থেকে ইমপোর্ট করে ব্যবহার হবে — টোকেন লাগে না, শুধু বর্তমান স্ট্যাটাস জানায়
export async function getMaintenanceStatus() {
  await ensureMaintenanceTable();
  const row = await queryOne('SELECT active, message FROM maintenance_mode WHERE id = 1');
  return { active: !!(row && row.active), message: (row && row.message) || '' };
}

router.get('/maintenance', requireSuperAdmin, async (req, res) => {
  try {
    res.json(await getMaintenanceStatus());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load maintenance status.' });
  }
});

router.post('/maintenance', requireSuperAdmin, async (req, res) => {
  try {
    const { active, message } = req.body || {};
    if (active && !(message || '').trim()) {
      return res.status(400).json({ error: 'মেইনটেন্যান্স চালু করার আগে একটা মেসেজ লিখুন।' });
    }
    await ensureMaintenanceTable();
    await query(
      'UPDATE maintenance_mode SET active = $1, message = $2, updated_at = now() WHERE id = 1',
      [!!active, message || '']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save maintenance settings.' });
  }
});
// ==================================================================
// API Access Toggle — সম্পূর্ণ নতুন, স্বনির্ভর ব্লক। উপরের কোনো রুট/কোড
// স্পর্শ করা হয়নি। নিজস্ব আলাদা টেবিল ব্যবহার করে (ai_settings/settings.js
// এর কিছুই ছোঁয়া হয়নি) — প্রথম কলেই টেবিল নিজে থেকে তৈরি হয়ে যায়।
// ==================================================================
let __apiAccessTableReady = false;
async function ensureApiAccessTable() {
  if (__apiAccessTableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS api_access_control (
      id INT PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      CHECK (id = 1)
    )
  `);
  await query(
    `INSERT INTO api_access_control (id, enabled) VALUES (1, true) ON CONFLICT (id) DO NOTHING`
  );
  __apiAccessTableReady = true;
}

// chat.js থেকে ইমপোর্ট করে ব্যবহার হবে — টোকেন লাগে না, শুধু বর্তমান স্ট্যাটাস জানায়
export async function getApiAccessStatus() {
  await ensureApiAccessTable();
  const row = await queryOne('SELECT enabled FROM api_access_control WHERE id = 1');
  return { enabled: row ? !!row.enabled : true };
}

router.get('/api-access', requireSuperAdmin, async (req, res) => {
  try {
    res.json(await getApiAccessStatus());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load API access status.' });
  }
});

router.post('/api-access', requireSuperAdmin, async (req, res) => {
  try {
    const { enabled } = req.body || {};
    await ensureApiAccessTable();
    await query(
      'UPDATE api_access_control SET enabled = $1, updated_at = now() WHERE id = 1',
      [!!enabled]
    );
    res.json({ ok: true, enabled: !!enabled });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save API access setting.' });
  }
});

export default router;
