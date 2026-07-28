import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db.js';
import { signUserToken, requireUser } from '../auth.js';

const router = Router();
const FIXED_SECURITY_QUESTION = "What's a word only you would know?";

const MAX_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 min
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 min window

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

async function checkLockout(identifier) {
  const record = await queryOne('SELECT * FROM login_attempts WHERE identifier = $1', [identifier]);
  if (!record) return { locked: false };

  if (record.locked_until && new Date(record.locked_until) > new Date()) {
    const msLeft = new Date(record.locked_until) - new Date();
    return { locked: true, minutesLeft: Math.ceil(msLeft / 60000) };
  }

  if (record.first_attempt_at && (new Date() - new Date(record.first_attempt_at)) > ATTEMPT_WINDOW_MS) {
    await query('DELETE FROM login_attempts WHERE identifier = $1', [identifier]);
    return { locked: false };
  }

  return { locked: false };
}

async function recordFailedAttempt(identifier) {
  const record = await queryOne('SELECT * FROM login_attempts WHERE identifier = $1', [identifier]);

  if (!record) {
    await query(
      `INSERT INTO login_attempts (identifier, attempt_count, first_attempt_at) VALUES ($1, 1, now())`,
      [identifier]
    );
    return;
  }

  const windowExpired = (new Date() - new Date(record.first_attempt_at)) > ATTEMPT_WINDOW_MS;
  const newCount = windowExpired ? 1 : record.attempt_count + 1;

  if (newCount >= MAX_ATTEMPTS) {
    await query(
      `UPDATE login_attempts SET attempt_count = $1, first_attempt_at = $2, locked_until = $3 WHERE identifier = $4`,
      [newCount, windowExpired ? new Date() : record.first_attempt_at, new Date(Date.now() + LOCK_DURATION_MS), identifier]
    );
  } else {
    await query(
      `UPDATE login_attempts SET attempt_count = $1, first_attempt_at = $2, locked_until = NULL WHERE identifier = $3`,
      [newCount, windowExpired ? new Date() : record.first_attempt_at, identifier]
    );
  }
}

async function clearAttempts(identifier) {
  await query('DELETE FROM login_attempts WHERE identifier = $1', [identifier]);
}

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
    const ip = getClientIp(req);

    if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });

    const emailKey = `email:${email}`;
    const ipKey = `ip:${ip}`;

    const emailLock = await checkLockout(emailKey);
    if (emailLock.locked) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${emailLock.minutesLeft} minute(s).` });
    }
    const ipLock = await checkLockout(ipKey);
    if (ipLock.locked) {
      return res.status(429).json({ error: `Too many failed attempts from this location. Try again in ${ipLock.minutesLeft} minute(s).` });
    }

    const user = await queryOne('SELECT * FROM users WHERE email = $1', [email]);
    if (!user) {
      await recordFailedAttempt(emailKey);
      await recordFailedAttempt(ipKey);
      return res.status(404).json({ error: 'No account found with that email.' });
    }
    if (user.blocked) {
      return res.status(403).json({
        error: 'This account has been suspended by SR Group. Please contact SR Group directly if you think this is a mistake.',
      });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      await recordFailedAttempt(emailKey);
      await recordFailedAttempt(ipKey);
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    await clearAttempts(emailKey);
    await clearAttempts(ipKey);
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
