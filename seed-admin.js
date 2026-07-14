// One-time script: set/reset the admin passcode.
// Run: node seed-admin.js "your-new-passcode"
import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;
const passcode = process.argv[2];

if (!passcode || passcode.length < 6) {
  console.error('Usage: node seed-admin.js "passcode" (min 6 chars)');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

const hash = await bcrypt.hash(passcode, 10);

await pool.query(
  `INSERT INTO admin_auth (id, passcode_hash) VALUES (1, $1)
   ON CONFLICT (id) DO UPDATE SET passcode_hash = $1`,
  [hash]
);

console.log('Admin passcode set successfully.');
await pool.end();
