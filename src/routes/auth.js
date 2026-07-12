import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db.js';
import { signUserToken, requireUser } from '../auth.js';

const router = Router();
const FIXED_SECURITY_QUESTION = "What's a word only you would know?";

router.post('/signup', async (req, res) => {
  try {
    const { name, email: rawEmail, password, securityAnswer } = req.body || {};
    const email = (rawEmail || '').trim().toLowerCase();

    if (!name || !email || !password || !securityAnswer) {
      return res.status(400).json({ error: 'Fill in all fields, including the security answer.' });
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const securityHash = await bcrypt.hash(securityAnswer.trim().toLowerCase(), 10);

    await query(
      `INSERT INTO users (name, email, password_hash, security_answer_hash) VALUES ($1, $2, $3, $4)`,
      [name, email, passwordHash, securityHash]
    );

    const token = signUserToken({ email });
    res.json({ token, user: { name, email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email: rawEmail, password } = req.body || {};
    const email = (rawEmail || '').trim().toLowerCase();

    if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });

    const user = await queryOne('SELECT * FROM users WHERE email = $1', [email]);
    if (!user) return res.status(404).json({ error: 'No account found with that email.' });
    if (user.blocked) {
      return res.status(403).json({
        error: 'This account has been suspended by SR Group. Please contact SR Group directly if you think this is a mistake.',
      });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password.' });

    await query('UPDATE users SET last_login_at = now() WHERE email = $1', [email]);
    const token = signUserToken({ email });
    res.json({ token, user: { name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/forgot/find', async (req, res) => {
  try {
    const email = ((req.body || {}).email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Enter your email.' });

    const user = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
    if (!user) return res.status(404).json({ error: 'No account found with that email.' });

    res.json({ question: FIXED_SECURITY_QUESTION });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/forgot/reset', async (req, res) => {
  try {
    const { email: rawEmail, answer, newPassword } = req.body || {};
    const email = (rawEmail || '').trim().toLowerCase();

    if (!email || !answer || !newPassword) return res.status(400).json({ error: 'Fill in all fields.' });

    const user = await queryOne('SELECT * FROM users WHERE email = $1', [email]);
    if (!user) return res.status(404).json({ error: 'No account found with that email.' });

    const match = await bcrypt.compare(answer.trim().toLowerCase(), user.security_answer_hash);
    if (!match) return res.status(401).json({ error: "That answer doesn't match." });

    const newHash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password_hash = $1 WHERE email = $2', [newHash, email]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// সাইন-ইন থাকা অবস্থায় নিজের পাসওয়ার্ড বদলানোর জন্য (forgot-password ফ্লো থেকে আলাদা)
router.post('/change-password', requireUser, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Fill in both your current and new password.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password should be at least 6 characters.' });
    }

    const user = await queryOne('SELECT * FROM users WHERE email = $1', [req.userEmail]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password_hash = $1 WHERE email = $2', [newHash, req.userEmail]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update your password.' });
  }
});

export default router;
