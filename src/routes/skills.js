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
// সাধারণ github.com/USER/REPO/blob/BRANCH/path.md লিংককে
// raw.githubusercontent.com/USER/REPO/BRANCH/path.md এ অটো-কনভার্ট করে,
// যাতে ইউজার হাতে raw URL না বানিয়ে সরাসরি normal GitHub লিংক পেস্ট করলেও কাজ করে।
function toRawGithubUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'github.com') {
      const parts = u.pathname.split('/').filter(Boolean); // [user, repo, blob, branch, ...path]
      if (parts.length >= 5 && parts[2] === 'blob') {
        const [user, repo, , branch, ...pathParts] = parts;
        return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${pathParts.join('/')}`;
      }
    }
    return url;
  } catch {
    return url;
  }
}

router.post('/import', async (req, res) => {
  try {
    let url = (req.body || {}).url;
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'Provide a valid http(s) URL.' });
    }
    url = toRawGithubUrl(url);

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

// ============ Default / built-in skills (Claude-এর সাধারণ ক্ষমতাগুলোর অনুকরণে) ============
const DEFAULT_SKILLS = [
  {
    name: 'Word Document Helper',
    description: 'Word (.docx) ডকুমেন্ট তৈরি বা এডিট করার সময় সাহায্য করে',
    triggers: 'word document, .docx, রিপোর্ট, চিঠি, cv, resume, ফরম্যাল ডকুমেন্ট',
    instructions:
      'ইউজার যদি Word ডকুমেন্ট, রিপোর্ট, চিঠি বা ফরম্যাল ডকুমেন্ট চায়, তাহলে প্রথমে কনটেন্টের একটা পরিষ্কার আউটলাইন তৈরি করো, তারপর হেডিং, প্যারাগ্রাফ, বুলেট পয়েন্ট ও প্রয়োজনে টেবিল ব্যবহার করে সুন্দরভাবে সাজাও। উত্তর প্রফেশনাল টোনে দাও।',
  },
  {
    name: 'PDF Helper',
    description: 'PDF ফাইল তৈরি, পড়া বা তথ্য বের করার জন্য সাহায্য করে',
    triggers: 'pdf, পিডিএফ, ফাইল থেকে টেক্সট বের করো, পিডিএফ পড়ো',
    instructions:
      'ইউজার PDF নিয়ে কাজ করতে চাইলে, PDF-এর কনটেন্ট বিশ্লেষণ করে সংক্ষিপ্ত ও পরিষ্কারভাবে দরকারি তথ্য বের করে দাও। বড় PDF হলে গুরুত্বপূর্ণ অংশগুলো হাইলাইট করো।',
  },
  {
    name: 'Excel / Spreadsheet Helper',
    description: 'স্প্রেডশিট, হিসাব-নিকাশ ও ডেটা বিশ্লেষণে সাহায্য করে',
    triggers: 'excel, spreadsheet, .xlsx, csv, হিসাব, বাজেট, ডেটা এনালাইসিস',
    instructions:
      'ইউজার স্প্রেডশিট বা ডেটা নিয়ে কাজ করতে চাইলে, ফর্মুলা, ফরম্যাটিং ও ডেটা গুছানোর ব্যাপারে সুনির্দিষ্ট পরামর্শ দাও। সম্ভব হলে ধাপে ধাপে (step-by-step) বুঝিয়ে দাও।',
  },
  {
    name: 'PowerPoint / Slide Helper',
    description: 'প্রেজেন্টেশন বা স্লাইড ডেক তৈরিতে সাহায্য করে',
    triggers: 'presentation, powerpoint, slide, .pptx, ডেক, পিচ ডেক',
    instructions:
      'ইউজার প্রেজেন্টেশন চাইলে, প্রতিটি স্লাইডের টাইটেল ও মূল পয়েন্টগুলো আলাদা আলাদা করে সাজিয়ে দাও, যাতে সহজেই স্লাইডে রূপান্তর করা যায়। খুব বেশি টেক্সট এক স্লাইডে না রেখে সংক্ষিপ্ত বুলেট পয়েন্ট ব্যবহার করো।',
  },
  {
    name: 'Code Helper',
    description: 'কোড লেখা, ডিবাগ করা ও ব্যাখ্যা করতে সাহায্য করে',
    triggers: 'code, কোড, বাগ ফিক্স, javascript, python, error',
    instructions:
      'ইউজার কোডিং সমস্যা নিয়ে আসলে, প্রথমে সমস্যাটা বুঝে নাও, তারপর পরিষ্কার, কমেন্টসহ কোড দাও এবং সংক্ষেপে ব্যাখ্যা করো কেন এভাবে করা হলো। ক্ষতিকর/ম্যালওয়্যার জাতীয় কোড কখনো লিখো না।',
  },
  {
    name: 'Image Prompt Helper',
    description: 'AI ইমেজ জেনারেশনের জন্য ভালো প্রম্পট লিখতে সাহায্য করে',
    triggers: 'ছবি বানাও, image prompt, midjourney, dall-e, ai image',
    instructions:
      'ইউজার ছবি তৈরির প্রম্পট চাইলে, বিষয়বস্তু, স্টাইল, লাইটিং, ক্যামেরা এঙ্গেল ইত্যাদি বিস্তারিতভাবে উল্লেখ করে একটা প্রফেশনাল মানের প্রম্পট লিখে দাও।',
  },
];

// লগইন করা ইউজারের জন্য ডিফল্ট skill গুলো ইন্সটল করে (যেগুলো আগে থেকে নেই সেগুলোই যোগ হবে)
router.post('/install-defaults', async (req, res) => {
  try {
    const existing = await query('SELECT name FROM user_skills WHERE user_email = $1', [req.userEmail]);
    const existingNames = new Set(existing.map((r) => r.name));

    const toInsert = DEFAULT_SKILLS.filter((s) => !existingNames.has(s.name));
    if (toInsert.length === 0) {
      return res.json({ added: 0, message: 'সব ডিফল্ট স্কিল আগে থেকেই আছে।' });
    }

    const countRow = await queryOne('SELECT COUNT(*)::int AS count FROM user_skills WHERE user_email = $1', [
      req.userEmail,
    ]);
    const remainingSlots = 20 - countRow.count;
    const finalList = toInsert.slice(0, Math.max(remainingSlots, 0));

    for (const s of finalList) {
      await query(
        `INSERT INTO user_skills (user_email, name, description, triggers, instructions)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.userEmail, s.name, s.description, s.triggers, s.instructions]
      );
    }

    res.json({ added: finalList.length, message: `${finalList.length}টি ডিফল্ট স্কিল যোগ করা হয়েছে।` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ডিফল্ট স্কিল ইন্সটল করা যায়নি।' });
  }
});

export default router;
