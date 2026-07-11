import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

import { initDb, query, queryOne } from './db.js';
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
    await query(`INSERT INTO ai_settings (id, description, tone, facts) VALUES (1, '', '', '')`);
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

  if (!process.env.GEMINI_API_KEY) {
    console.warn('[SR Group] সতর্কতা: .env-এ GEMINI_API_KEY নেই। চ্যাট কাজ করবে না যতক্ষণ না এটা সেট করা হয়।');
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
