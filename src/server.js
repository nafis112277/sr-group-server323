import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

import { initDb, query, queryOne } from './db.js';
import { configuredProviders } from './ai.js';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import adminRoutes from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());

// প্রথমবার চালু হলে টেবিল বানানো + অ্যাডমিন পাসকোড ও AI settings-এর ডিফল্ট রো বসানো
async function seed() {
  await initDb();

  const admin = await queryOne('SELECT * FROM admin_auth WHERE id = 1');
  if (!admin) {
    const defaultPasscode = process.env.ADMIN_DEFAULT_PASSCODE || 'srgroup2026';
    const hash = await bcrypt.hash(defaultPasscode, 10);
    await query('INSERT INTO admin_auth (id, passcode_hash) VALUES (1, $1)', [hash]);
    console.log(`[SR Group] অ্যাডমিন পাসকোড ডিফল্ট সেট হলো: "${defaultPasscode}" — অ্যাডমিন ড্যাশবোর্ড থেকে এখনই বদলে ফেলুন!`);
  }

  const settings = await queryOne('SELECT * FROM ai_settings WHERE id = 1');
  if (!settings) {
    await query(`INSERT INTO ai_settings (id, description, tone, facts, daily_limit) VALUES (1, '', '', '', 40)`);
  }
}

async function start() {
  try {
    await seed();
  } catch (err) {
    console.error('[SR Group] ডাটাবেসে কানেক্ট বা সেটআপ করতে ব্যর্থ হয়েছে। DATABASE_URL ঠিক আছে কিনা চেক করুন।');
    console.error(err);
    process.exit(1);
  }

  // কোন কোন AI provider-এর জন্য অন্তত একটা key .env / Render Environment Variables-এ আছে, সেটা চেক করা
  const hasKey = (...envVars) => envVars.some((v) => process.env[v] && process.env[v].trim());
  const availability = {
    gemini: hasKey('GEMINI_API_KEY', 'GEMINI_API_KEYS'),
    openai: hasKey('OPENAI_API_KEY', 'OPENAI_API_KEYS'),
    anthropic: hasKey('ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEYS'),
    groq: hasKey('GROQ_API_KEY', 'GROQ_API_KEYS'),
  };
  const order = configuredProviders();
  const anyKeyPresent = order.some((name) => availability[name]);

  if (!anyKeyPresent) {
    console.warn(
      `[SR Group] সতর্কতা: AI_PROVIDER_ORDER-এ থাকা কোনো provider-এর জন্যই API key পাওয়া যায়নি (${order.join(', ')})। চ্যাট কাজ করবে না যতক্ষণ না অন্তত একটা key সেট করা হয় (GEMINI_API_KEY(S) / OPENAI_API_KEY(S) / ANTHROPIC_API_KEY(S)).`
    );
  } else {
    console.log(`[SR Group] AI provider ready — চেষ্টার ক্রম: ${order.filter((n) => availability[n]).join(' → ')}`);
  }

  app.use('/api/auth', authRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/admin', adminRoutes);

  // ফ্রন্টএন্ড সার্ভ করছে
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`SR Group সার্ভার চলছে: http://localhost:${PORT}`);
  });
}

start();
