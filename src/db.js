import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn('[SR Group] সতর্কতা: .env-এ DATABASE_URL নেই। Neon থেকে connection string বসান, নাহলে সার্ভার ডাটাবেসে কানেক্ট করতে পারবে না।');
}

// Neon-সহ বেশিরভাগ hosted Postgres SSL লাগে
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      security_answer_hash TEXT NOT NULL,
      blocked BOOLEAN NOT NULL DEFAULT FALSE,
      daily_limit INTEGER,
      custom_instructions TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS admin_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      passcode_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      description TEXT NOT NULL DEFAULT '',
      tone TEXT NOT NULL DEFAULT '',
      facts TEXT NOT NULL DEFAULT '',
      daily_limit INTEGER NOT NULL DEFAULT 40
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New chat',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS user_skills (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      triggers TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_email ON conversations(user_email);
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_user_skills_email ON user_skills(user_email);

    -- আগে থেকে চলা ডাটাবেসে নতুন কলামগুলো নিরাপদে যোগ করে (already-running প্রজেক্টের জন্য মাইগ্রেশন)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_limit INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_instructions TEXT NOT NULL DEFAULT '';
    ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS daily_limit INTEGER NOT NULL DEFAULT 40;
    ALTER TABLE user_skills ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE user_skills ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  `);
}

// ছোট হেল্পার — pg-এর query() সরাসরি ব্যবহার করা যায়, কিন্তু এভাবে কল-সাইট পরিষ্কার থাকে
export async function query(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}

export async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows[0] || null;
}

export default pool;
