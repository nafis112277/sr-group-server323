# SR Group AI Assistant — ব্যাকএন্ড সার্ভার (Neon + Render, সম্পূর্ণ ফ্রি)

এই ভার্সনে ডাটাবেস **SQLite থেকে PostgreSQL (Neon)-এ** পরিবর্তন করা হয়েছে, যাতে ডেটা কোনো লোকাল ফাইলে না থেকে একটা স্থায়ী, ফ্রি হোস্টেড ডাটাবেসে থাকে — Render-এ ডিপ্লয় করলে প্রতিবার রিডিপ্লয়েও ডেটা মুছে যাবে না।

- **Express.js** সার্ভার
- **PostgreSQL (Neon)** ডাটাবেস — স্থায়ীভাবে ফ্রি, কোনো মেয়াদ শেষ হয় না
- **JWT** দিয়ে ইউজার/অ্যাডমিন সেশন
- **bcrypt** দিয়ে পাসওয়ার্ড হ্যাশিং
- **Gemini API key শুধু সার্ভারে থাকে** — ব্রাউজার কখনো এটা দেখতে পারে না

## ধাপ ১: Neon-এ ডাটাবেস বানান

1. [neon.tech](https://neon.tech) এ যান, ফ্রি অ্যাকাউন্ট বানান (GitHub/Google দিয়েও সাইন আপ করা যায়)
2. **"Create a project"** ক্লিক করুন, একটা নাম দিন (যেমন `sr-group`)
3. প্রজেক্ট তৈরি হলে ড্যাশবোর্ডে **"Connection string"** নামে একটা বক্স দেখবেন
4. সেটা কপি করুন — এরকম দেখতে হবে:
   ```
   postgresql://user:password@ep-xxxxx.region.aws.neon.tech/dbname?sslmode=require
   ```
   এটাই আপনার `DATABASE_URL`, পরে লাগবে।

## ধাপ ২: Render-এ অ্যাকাউন্ট বানান

1. [render.com](https://render.com) এ যান, ফ্রি অ্যাকাউন্ট বানান (GitHub দিয়ে সাইন আপ করাই সহজ)

## ধাপ ৩: কোড GitHub-এ আপলোড করুন

Render মূলত GitHub রিপো থেকেই ডিপ্লয় করে। **GitHub Desktop** ব্যবহার করুন (ব্রাউজারে ফোল্ডার ড্র্যাগ করলে ক্র্যাশ হতে পারে, তাই এই অ্যাপটাই নিরাপদ):

1. [desktop.github.com](https://desktop.github.com) থেকে ইনস্টল করে GitHub অ্যাকাউন্ট দিয়ে সাইন-ইন করুন
2. **File → Add local repository** → আপনার `sr-group-server` ফোল্ডার সিলেক্ট করুন (এমন ফোল্ডার যেটার ভেতরে সরাসরি `public`, `src`, `package.json` আছে)
3. "create a repository" লিংকে ক্লিক → **Create Repository**
4. উপরে নীল **"Publish repository"** বাটন → নাম `sr-group-server`, **Private** টিক দিন → **Publish Repository**

## ধাপ ৪: Render-এ ডিপ্লয় করুন

1. Render ড্যাশবোর্ডে **"New +"** → **"Web Service"**
2. আপনার GitHub অ্যাকাউন্ট কানেক্ট করুন, `sr-group-server` রিপো সিলেক্ট করুন
3. এই সেটিংসগুলো দিন:
   - **Name**: `sr-group-server` (বা যা খুশি)
   - **Region**: Singapore (বাংলাদেশের কাছাকাছি, দ্রুত হবে)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
4. **"Environment Variables"** সেকশনে এই চারটা যোগ করুন:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | Neon থেকে কপি করা connection string |
   | `JWT_SECRET` | যেকোনো লম্বা র‍্যান্ডম লেখা |
   | `GEMINI_API_KEY` | আপনার Gemini key (একটাই থাকলে) |
   | `GEMINI_MODEL` | `gemini-2.5-flash` |
   | `ADMIN_DEFAULT_PASSCODE` | আপনার পছন্দের অ্যাডমিন পাসকোড |

   **একাধিক Gemini key থাকলে (recommended — quota দ্রুত শেষ হয় বলে):**
   `GEMINI_API_KEY`-এর বদলে `GEMINI_API_KEYS` নামে একটা ভ্যারিয়েবল বসান, ভ্যালুতে সব key কমা দিয়ে আলাদা করে দিন, যেমন:
   ```
   key-one,key-two,key-three
   ```
   একটা key-র quota শেষ হয়ে গেলে বা invalid হলে সার্ভার নিজে থেকেই পরের key দিয়ে চেষ্টা করবে, আর প্রতিটা নতুন মেসেজে পালা করে ভিন্ন key ব্যবহার করে লোড ভাগ করে দেয়।

5. **"Create Web Service"** ক্লিক করুন

Render বিল্ড করে ডিপ্লয় শুরু করবে (২-৫ মিনিট লাগতে পারে)। শেষ হলে উপরে একটা লিংক পাবেন, যেমন:
```
https://sr-group-server.onrender.com
```
এটাই আপনার লাইভ সাইট।

## ⚠️ Render ফ্রি টিয়ারের একটা বিষয় জেনে রাখুন

Render-এর ফ্রি ওয়েব সার্ভিস ১৫ মিনিট কেউ ব্যবহার না করলে "ঘুমিয়ে" যায় (spin down)। এরপর কেউ ভিজিট করলে জেগে উঠতে ৩০-৬০ সেকেন্ড সময় লাগতে পারে (প্রথম রিকোয়েস্ট স্লো হবে, এরপর স্বাভাবিক)। এটা সম্পূর্ণ ফ্রি রাখার একটা স্বাভাবিক ট্রেড-অফ — পেইড প্ল্যানে ($7/মাস থেকে) এই সমস্যা থাকে না।

## নিরাপত্তা নোট

- পাসওয়ার্ড bcrypt দিয়ে হ্যাশ হয়ে সেভ হয়, plaintext কখনো না
- `DATABASE_URL` আর `GEMINI_API_KEY` GitHub-এ কখনো যাবে না (`.gitignore`-এ `.env` বাদ দেওয়া আছে) — এগুলো শুধু Render-এর Environment Variables সেকশনে থাকবে
- প্রোডাকশনে `JWT_SECRET` অবশ্যই শক্তিশালী র‍্যান্ডম ভ্যালু হতে হবে

## লোকালি টেস্ট করতে চাইলে

```bash
npm install
cp .env.example .env
# .env খুলে DATABASE_URL (Neon থেকে), GEMINI_API_KEY, JWT_SECRET বসান
npm start
```
তারপর `http://localhost:3000` এ ব্রাউজারে খুলুন।

## API endpoints (সংক্ষেপে)

| Method | Path | কাজ |
|---|---|---|
| POST | `/api/auth/signup` | নতুন কাস্টমার অ্যাকাউন্ট |
| POST | `/api/auth/login` | কাস্টমার লগইন |
| POST | `/api/auth/forgot/find` | ইমেইল যাচাই |
| POST | `/api/auth/forgot/reset` | পাসওয়ার্ড রিসেট |
| GET | `/api/chat/conversations` | নিজের কনভারসেশন লিস্ট |
| POST | `/api/chat/conversations` | নতুন চ্যাট শুরু |
| GET | `/api/chat/conversations/:id/messages` | মেসেজ হিস্ট্রি |
| POST | `/api/chat/conversations/:id/message` | মেসেজ পাঠানো (AI রিপ্লাই দেয়) |
| POST | `/api/admin/login` | অ্যাডমিন লগইন |
| GET | `/api/admin/customers` | সব কাস্টমারের লিস্ট |
| POST | `/api/admin/customers/:email/block` | ব্লক/আনব্লক |
| GET | `/api/admin/settings` | AI সেটিংস পড়া |
| POST | `/api/admin/settings` | AI সেটিংস সেভ করা |
| POST | `/api/admin/passcode` | অ্যাডমিন পাসকোড বদলানো |

সব `/api/chat/*` এবং `/api/admin/*` (login বাদে) রুটে `Authorization: Bearer <token>` হেডার লাগবে।
