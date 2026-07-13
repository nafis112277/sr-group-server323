import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { requireUser } from '../auth.js';

const router = Router();
router.use(requireUser);

// কাস্টমার নিজের "skill" এ যদি স্পষ্টভাবে জেলব্রেক/rule-ভাঙার চেষ্টা অথবা ক্ষতিকর কোডের অনুরোধ থাকে,
// সেটা install করার সময়েই আটকে দেওয়া হয় — chat.js-এর মতোই patterns, এখানে duplicate করে রাখা হলো
// যাতে এই ফাইলটা routes/chat.js-এর উপর নির্ভর না করেই স্বনির্ভরভাবে কাজ করে।
const SKILL_RED_FLAGS = /\b(ignore (all |your |previous )?(instructions|rules)|you are now|jailbreak|DAN mode|no restrictions|without any (rules|limits|filters)|reveal your (system prompt|instructions)|act as an? unfiltered|malware|ransomware|keylogger|spyware|rootkit|botnet|backdoor|trojan|worm virus|ddos|reverse shell|brute[- ]?force|sql injection|phishing (kit|page|site)|steal (password|credit card|card number|data)|bypass (security|authentication|paywall|login)|hacking tool|exploit code)\b/i;

function looksUnsafe(text) {
  return SKILL_RED_FLAGS.test(text || '');
}

router.get('/', async (req, res) => {
  try {
    const rows = await query(
      'SELECT id, name, description, triggers, instructions, enabled, created_at AS "createdAt" FROM user_skills WHERE user_email = $1 ORDER BY id DESC',
      [req.userEmail]
    );
    res.json({ skills: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load your skills.' });
  }
});

router.post('/', async (req, res) => {
  try {
    let { name, description, triggers, instructions } = req.body || {};
    name = (name || '').toString().trim().slice(0, 80);
    description = (description || '').toString().trim().slice(0, 300);
    triggers = (triggers || '').toString().trim().slice(0, 300);
    instructions = (instructions || '').toString().trim().slice(0, 3000);

    if (!name || !instructions) {
      return res.status(400).json({ error: 'A skill needs at least a name and instructions.' });
    }
    if (!triggers) {
      return res.status(400).json({ error: 'Add at least one trigger word — a skill without triggers will never activate.' });
    }
    if (looksUnsafe(name) || looksUnsafe(description) || looksUnsafe(instructions)) {
      return res.status(400).json({ error: "This skill looks like it contains malicious code or a rule-breaking instruction, so it can't be installed." });
    }

    const countRow = await queryOne('SELECT COUNT(*)::int AS count FROM user_skills WHERE user_email = $1', [
      req.userEmail,
    ]);
    if (countRow.count >= 20) {
      return res.status(400).json({ error: 'You can have up to 20 skills. Remove one before adding another.' });
    }

    const row = await queryOne(
      `INSERT INTO user_skills (user_email, name, description, triggers, instructions)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, description, triggers, instructions, enabled, created_at AS "createdAt"`,
      [req.userEmail, name, description, triggers, instructions]
    );
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save this skill.' });
  }
});

router.post('/:id/toggle', async (req, res) => {
  try {
    const skill = await queryOne('SELECT * FROM user_skills WHERE id = $1 AND user_email = $2', [
      req.params.id,
      req.userEmail,
    ]);
    if (!skill) return res.status(404).json({ error: 'Skill not found.' });
    await query('UPDATE user_skills SET enabled = $1 WHERE id = $2', [!skill.enabled, skill.id]);
    res.json({ enabled: !skill.enabled });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update this skill.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM user_skills WHERE id = $1 AND user_email = $2', [req.params.id, req.userEmail]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove this skill.' });
  }
});

// GitHub-এ থাকা raw .md skill ফাইল fetch + parse করে — সেভ করে না, শুধু ফর্মে ভরার জন্য ডেটা ফেরত দেয়
// (ব্লাইন্ড সেভ না করে কাস্টমারকে আগে চোখে দেখিয়ে নেওয়ার সুযোগ দিতে)
router.post('/import', async (req, res) => {
  try {
    const url = (req.body || {}).url;
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'Provide a valid http(s) URL.' });
    }

    const fetchRes = await fetch(url);
    if (!fetchRes.ok) {
      return res.status(400).json({ error: `Could not fetch that URL (status ${fetchRes.status}).` });
    }
    const text = await fetchRes.text();

    const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!match) {
      return res.status(400).json({ error: "That file doesn't look like a valid skill file (missing --- frontmatter)." });
    }
    const fields = {};
    match[1].split('\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx === -1) return;
      fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    if (!fields.name) {
      return res.status(400).json({ error: "That file doesn't look like a valid skill file (no name field)." });
    }

    const parsed = {
      name: fields.name.slice(0, 80),
      description: (fields.description || '').slice(0, 300),
      triggers: (fields.triggers || '').slice(0, 300),
      instructions: match[2].trim().slice(0, 3000),
    };

    if (looksUnsafe(parsed.name) || looksUnsafe(parsed.description) || looksUnsafe(parsed.instructions)) {
      return res.status(400).json({ error: "This skill looks like it contains malicious code or a rule-breaking instruction, so it can't be imported." });
    }

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not import that skill.' });
  }
});

export default router;
