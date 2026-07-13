import { Router } from 'express';
import { query } from '../db.js';
import { requireUser } from '../auth.js';
import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';

const router = Router();
router.use(requireUser);

/* ============================================================
 * নিরাপত্তা ফিল্টার (heuristic — ১০০% গ্যারান্টি না, কিন্তু
 * সবচেয়ে সাধারণ prompt-injection / harmful-content প্যাটার্নগুলো
 * ধরে ফেলে)। কোনো skill এর instructions/description এ এসব
 * প্যাটার্নের কাছাকাছি কিছু পেলে সেটা সরাসরি reject হয়ে যাবে।
 * এই ফিল্টার সব সোর্স (trusted বা untrusted, raw skill ফাইল বা
 * ওয়েবপেজ থেকে অটো-কনভার্ট করা কনটেন্ট) — সবার জন্যই প্রযোজ্য।
 * ============================================================ */
const UNSAFE_PATTERNS = [
  /ignore (all|any|previous|prior)\s+(instructions|rules)/i,
  /disregard (your|the|all)\s+(rules|guidelines|policy|policies)/i,
  /you (are|must)\s+now\s+(act as|become|pretend)/i,
  /jailbreak/i,
  /\bDAN\b/i,
  /no (restrictions|limits|filters|safety)/i,
  /bypass (safety|security|moderation|filters?)/i,
  /(write|create|generate)\s+(a\s+)?(malware|ransomware|keylogger|virus|trojan|worm)/i,
  /how to (hack|exploit|attack)\s+(a |the )?(server|network|website|account|system)/i,
  /(ddos|denial[- ]of[- ]service)\s+attack/i,
  /steal\s+(passwords|credentials|credit card|personal data)/i,
  /make\s+(a\s+)?(bomb|explosive|weapon)/i,
  /child\s+sexual/i,
  /system\s*prompt\s*:\s*you\s+(are|must)/i,
  /override\s+(your|the)\s+(system|core)\s+(prompt|instructions)/i,
];

function isSkillContentSafe(text) {
  if (!text) return true;
  return !UNSAFE_PATTERNS.some((re) => re.test(text));
}

/* ---------- বিশ্বস্ত ডোমেইন allowlist ----------
 * এই ডোমেইনগুলো থেকে fetch করার সময় SSRF/private-IP চেক স্কিপ হবে।
 * root domain + সব subdomain ম্যাচ করবে (যেমন www.nctb.gov.bd, bn.wikipedia.org)
 */
const TRUSTED_DOMAINS = [
  'nctb.gov.bd',
  'teachers.gov.bd',
  'bdjobs.com',
  '10minuteschool.com',
  'wikipedia.org',
];

function isTrustedDomain(hostname) {
  const host = hostname.toLowerCase();
  return TRUSTED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/* ---------- SSRF protection: internal/private ঠিকানায় fetch আটকানো ---------- */
function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fe80:')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    return false;
  }
  return true;
}

async function isUrlSafeToFetch(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { safe: false, reason: 'Invalid URL.' };
  }
  if (parsed.protocol !== 'https:') {
    return { safe: false, reason: 'Only https:// URLs are allowed.' };
  }
  if (parsed.username || parsed.password) {
    return { safe: false, reason: 'URLs with embedded credentials are not allowed.' };
  }

  if (isTrustedDomain(parsed.hostname)) {
    return { safe: true };
  }

  let addresses;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true });
  } catch {
    return { safe: false, reason: 'Could not resolve that hostname.' };
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateOrReservedIp(a.address))) {
    return { safe: false, reason: 'That host resolves to a private or internal address, which is not allowed.' };
  }

  return { safe: true };
}

const MAX_CONTENT_CHARS = 20000;

/* frontmatter-স্টাইল .md ফাইল পার্স করে skill object বানায় (আগের মতোই) */
function parseSkillFrontmatter(rawText) {
  const match = rawText.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2].trim();
  const fields = {};
  frontmatter.split('\n').forEach((line) => {
    const idx = line.indexOf(':');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    fields[key] = value;
  });

  if (!fields.name) return null;

  return {
    name: fields.name,
    description: fields.description || '',
    triggers: fields.triggers
      ? fields.triggers.split(',').map((t) => t.trim()).filter(Boolean)
      : [],
    instructions: body,
  };
}

/* ---------- নতুন: সাধারণ ওয়েবপেজ থেকে টেক্সট বের করে skill বানানো ----------
 * frontmatter ফরম্যাটে না থাকলে এটা fallback হিসেবে ব্যবহার হয়।
 * script/style/nav/header/footer বাদ দিয়ে মূল কনটেন্ট বের করা হয়।
 */
function buildSkillFromWebpage(html, sourceUrl) {
  const $ = cheerio.load(html);

  $('script, style, noscript, nav, header, footer, svg, iframe').remove();

  const pageTitle = $('title').first().text().trim() || new URL(sourceUrl).hostname;
  const metaDescription =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';

  const mainCandidates = ['main', 'article', '[role="main"]', '#content', '.content'];
  let $root = null;
  for (const sel of mainCandidates) {
    if ($(sel).length) {
      $root = $(sel).first();
      break;
    }
  }
  if (!$root) $root = $('body');

  const text = $root
    .text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

  if (!text || text.length < 50) return null;

  const truncated = text.slice(0, MAX_CONTENT_CHARS - 500);

  const safeName = new URL(sourceUrl).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-');

  return {
    name: safeName,
    description: metaDescription.trim().slice(0, 300) || pageTitle.slice(0, 300),
    triggers: [],
    instructions: `# ${pageTitle}\n\nSource: ${sourceUrl}\n\n${truncated}`,
  };
}

/* ---------- ক্লায়েন্টের নিজের সব skill লিস্ট করা ---------- */
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT name, description, triggers, source_url AS "sourceUrl", created_at AS "createdAt"
       FROM user_skills WHERE user_email = $1 ORDER BY created_at DESC`,
      [req.userEmail]
    );
    res.json({ skills: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load your skills.' });
  }
});

/* ---------- নতুন skill ডাউনলোড করা ---------- */
router.post('/', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Provide a skill file URL.' });
    }

    const check = await isUrlSafeToFetch(url);
    if (!check.safe) {
      return res.status(400).json({ error: check.reason });
    }

    let fetchRes;
    try {
      fetchRes = await fetch(url, { redirect: 'error' });
    } catch (e) {
      return res.status(400).json({ error: 'Could not reach that URL.' });
    }
    if (!fetchRes.ok) {
      return res.status(400).json({ error: `Could not fetch that file (status ${fetchRes.status}).` });
    }

    const rawText = await fetchRes.text();

    let parsed = parseSkillFrontmatter(rawTe
