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
