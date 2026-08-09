// public/webllm-local.js
//
// Local (offline) AI mode — WebGPU, multilingual (auto-detect) support
// Network-aware tiered model selection: picks best model based on connection speed
// Fallback chain: Tier 1 (best) → Tier 5 (emergency), no user left empty-handed

// ─── Model Ready Flag ────────────────────────────────────────────────────────

const MODEL_READY_KEY = 'krovos_local_model_ready_v1';
function isModelReady() {
  try { return localStorage.getItem(MODEL_READY_KEY) === 'true'; } catch (e) { return false; }
}
function markModelReady() {
  try { localStorage.setItem(MODEL_READY_KEY, 'true'); } catch (e) { /* ignore */ }
}
function clearModelReady() {
  try { localStorage.removeItem(MODEL_READY_KEY); } catch (e) { /* ignore */ }
}

// ─── Identity ────────────────────────────────────────────────────────────────

const AI_NAME        = 'KROVOS AI';
const AI_MODEL_NAME  = 'Nova1';
const AI_CREATOR     = 'SR Group';

// ─── Network-Aware Model Tiers ───────────────────────────────────────────────
// Sorted best → worst quality.
// minSpeedMbps = minimum download speed needed to load this model comfortably.
// sizeGB       = approximate cache size (informational only).
//
// MLC catalog availability notes (as of 2025):
//   Llama-3.2-1B  — available in MLC catalog
//   Qwen2.5-1.5B  — available in MLC catalog
//   Qwen3-0.6B    — available in MLC catalog
//   SmolLM2-360M  — available in MLC catalog
//   SmolLM2-135M  — CHECK catalog before deploying; if missing, Tier 5 falls
//                   back to SmolLM2-360M automatically via FALLBACK_MODELS.

const MODEL_TIERS = [
  {
    id:           'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    sizeGB:        0.75,
    minSpeedMbps:  50,
    label:        'Tier 1 — High-end'
  },
  {
    id:           'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    sizeGB:        1.0,
    minSpeedMbps:  10,
    label:        'Tier 2 — Balanced'
  },
  {
    id:           'Qwen3-0.6B-q4f32_1-MLC',
    sizeGB:        0.4,
    minSpeedMbps:  3,
    label:        'Tier 3 — Compact'
  },
  {
    id:           'SmolLM2-360M-Instruct-q4f16_1-MLC',
    sizeGB:        0.2,
    minSpeedMbps:  1,
    label:        'Tier 4 — Minimal'
  },
  {
    id:           'SmolLM2-135M-Instruct-q4f16_1-MLC',
    sizeGB:        0.08,
    minSpeedMbps:  0,
    label:        'Tier 5 — Emergency'
  }
];

// Fallback order for loadEngine retry: smallest → largest (easiest to load first)
const FALLBACK_MODELS = [...MODEL_TIERS].reverse().map(t => t.id);

// ─── Network Speed Estimation ────────────────────────────────────────────────
// Fetches a small known-size file and measures throughput.
// Returns estimated Mbps. On fetch error, returns conservative 2 Mbps.

async function estimateNetworkMbps() {
  // ~90 KB public CDN file — no CORS issues, no auth, widely cached at edge
  const testUrl    = 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js';
  const sampleBytes = 90_000;
  try {
    const start   = performance.now();
    await fetch(testUrl, { cache: 'no-store' });
    const elapsed = (performance.now() - start) / 1000; // seconds
    const mbps    = (sampleBytes * 8) / (elapsed * 1_000_000);
    return mbps;
  } catch {
    return 2; // conservative fallback: assume slow connection
  }
}

// Picks the highest-quality tier affordable at current network speed.
async function pickModelForNetwork(onProgress) {
  if (onProgress) onProgress('নেটওয়ার্ক গতি পরীক্ষা হচ্ছে...', 0);
  const mbps = await estimateNetworkMbps();
  if (onProgress) onProgress(`নেটওয়ার্ক: ~${mbps.toFixed(1)} Mbps`, 5);

  // Walk tiers best → worst; pick first one user's speed can afford
  const picked = MODEL_TIERS.find(t => mbps >= t.minSpeedMbps)
              || MODEL_TIERS[MODEL_TIERS.length - 1]; // guaranteed floor

  if (onProgress) onProgress(`মডেল নির্বাচিত: ${picked.label}`, 10);
  return picked.id;
}

// ─── Engine State ────────────────────────────────────────────────────────────

let enginePromise  = null;
let currentModelId = null;
let selectedLanguage = 'english';

// ─── Identity + Scope Prompts ────────────────────────────────────────────────

const IDENTITY_PROMPT = `তোমার নাম ${AI_NAME}। তোমার model-এর নাম ${AI_MODEL_NAME}। তোমাকে পরিচালনা করে ${AI_CREATOR}।
তোমার কাজ: ${AI_CREATOR}-এর পণ্য/সেবা সম্পর্কিত প্রশ্নের উত্তর দেওয়া, সাধারণ কোডিং/টেকনিক্যাল সহায়তা দেওয়া, এবং সাধারণ তথ্য ও পরামর্শ প্রদান করা।
তুমি কখনো নিজেকে Qwen, SmolLM, Llama, Alibaba, Meta, HuggingFace বা অন্য কোনো base model বলবে না।
কেউ "তুমি কোন মডেল/AI" জিজ্ঞেস করলে শুধু বলবে: "আমি ${AI_MODEL_NAME}, ${AI_CREATOR}-এর ${AI_NAME}।"
ব্যবহারকারী যে ভাষায় প্রশ্ন করবে, ঠিক সেই ভাষায় উত্তর দেবে — ব্যবহারকারী ভাষা পাল্টালে তুমিও পাল্টাবে।
তুমি একটি ছোট, ডিভাইসে চলা মডেল — জটিল বা নির্দিষ্ট তথ্যভিত্তিক প্রশ্নে (যেমন: রাজধানী, ইতিহাস, তারিখ, সংখ্যা) ভুল তথ্য বানিয়ে বলার প্রবণতা তোমার আছে।
তাই: নিশ্চিত না হলে কখনো আন্দাজে/বানিয়ে উত্তর দেবে না। নিশ্চিত না থাকলে স্পষ্টভাবে বলবে "আমি নিশ্চিত না" অথবা "এই মুহূর্তে সঠিক তথ্য দিতে পারছি না, ইন্টারনেট সংযোগ ফিরলে আবার জিজ্ঞেস করুন।"
কোনো নাম, সংখ্যা, তারিখ বা তথ্য সম্পূর্ণ নিশ্চিত না হয়ে কখনো তৈরি করে বলবে না।`;

// SR Group org info — admin/contact question এলে এখান থেকে বলবে
const ORG_INFO = `SR Group প্রশাসক: Sadiqur Rahman, Sakirul Islam।
যোগাযোগ ইমেইল: hossainalijms9@gmail.com
ওয়েবসাইট: https://krovos.rf.gd/
কেউ SR Group-এর admin/contact/website জিজ্ঞেস করলে এই তথ্য দিয়ে উত্তর দেবে।`;

// ─── Language Detection & Prompts ────────────────────────────────────────────

const LANGUAGE_PROMPTS = {
  bengali: `আপনি একজন সহায়ক। শিক্ষার্থী-বান্ধব, সহজ ব্যাখ্যা দিন।
সব উত্তর বাংলায় লিখুন।`,

  english: `You are a helpful assistant. Provide student-friendly, clear explanations.
Answer in complete English sentences.`,

  hindi: `आप एक सहायक हैं। छात्र-अनुकूल, सरल व्याख्या दें।
सभी उत्तर हिंदी में लिखें।`,

  chinese: `你是一个乐于助人的助手。请提供适合学生的清晰解释。
请用中文回答所有问题。`,

  japanese: `あなたは親切なアシスタントです。学生にわかりやすい説明を提供してください。
すべての回答は日本語で書いてください。`,

  spanish: `Eres un asistente útil. Proporciona explicaciones claras y amigables para estudiantes.
Responde en español completo.`,

  french: `Vous êtes un assistant utile. Fournissez des explications claires et conviviales.
Répondez en français complet.`,

  urdu: `آپ ایک معاون ہیں۔ طالب علم کے لیے دوست انہ وضاحت دیں۔
تمام جوابات اردو میں لکھیں۔`
};

// Detect language from Unicode script ranges in user message
function detectLanguage(text) {
  if (!text) return 'english';
  if (/[\u3040-\u30FF]/.test(text)) return 'japanese';   // hiragana / katakana
  if (/[\u4E00-\u9FFF]/.test(text)) return 'chinese';    // CJK unified ideographs
  if (/[\u0980-\u09FF]/.test(text)) return 'bengali';
  if (/[\u0900-\u097F]/.test(text)) return 'hindi';
  if (/[\u0600-\u06FF]/.test(text)) return 'urdu';
  if (/[¿¡ñÑ]/.test(text))         return 'spanish';
  if (/[àâçéèêëîïôùûüÀÂÇÉÈÊËÎÏÔÙÛÜ]/.test(text)) return 'french';
  return 'english';
}

// ─── WebGPU Support Check ─────────────────────────────────────────────────────

function isSupported() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

// ─── Engine Loader ────────────────────────────────────────────────────────────
// modelId=null → auto-pick via network speed test.
// modelId=string → force that model (manual override / restart after crash).
//
// Retry strategy inside each tier: up to 3 attempts with exponential backoff.
// If all attempts for a tier fail, move to the next smaller model automatically.
// User always gets something — worst case SmolLM2-360M (Emergency tier).

async function loadEngine(modelId = null, onProgress) {
  if (!isSupported()) {
    throw new Error(
      'এই ডিভাইসে Local AI চলবে না। Chrome বা Edge (desktop) দিয়ে চেষ্টা করুন — WebGPU দরকার।'
    );
  }

  // Auto-detect best model from network speed if none forced
  if (!modelId) {
    modelId = await pickModelForNetwork(onProgress);
  }

  // Return existing engine if same model already loading/loaded
  if (enginePromise && currentModelId === modelId) return enginePromise;

  // Different model requested — discard old promise
  if (enginePromise && currentModelId !== modelId) enginePromise = null;

  enginePromise = (async () => {
    // Build retry order: preferred model first, then smaller fallbacks
    const tryOrder = [
      modelId,
      ...FALLBACK_MODELS.filter(m => m !== modelId)
    ];

    for (const model of tryOrder) {
      try {
        const shortName = model.split('-').slice(0, 2).join(' ');
        if (onProgress) onProgress(`লোড হচ্ছে: ${shortName}...`, 0);

        const webllm = await import('https://esm.run/@mlc-ai/web-llm');
        const engine = new webllm.MLCEngine();
        engine.setInitProgressCallback((report) => {
          if (onProgress) onProgress(report.text, report.progress);
        });

        const MAX_RETRIES = 3;
        let lastErr;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            await engine.reload(model);
            currentModelId = model;
            markModelReady();
            if (onProgress) onProgress(`প্রস্তুত: ${shortName}`, 100);
            return engine;
          } catch (err) {
            lastErr = err;
            if (attempt < MAX_RETRIES) {
              if (onProgress) onProgress(`চেষ্টা ${attempt} ব্যর্থ, পুনরায়...`, 0);
              await new Promise(r => setTimeout(r, 2000 * attempt));
            }
          }
        }

        // This tier exhausted — try next smaller model
        if (onProgress) onProgress(`${model.split('-')[0]} ব্যর্থ, ছোট মডেলে যাচ্ছি...`, 0);

      } catch (err) {
        if (onProgress) onProgress('পরবর্তী মডেলে যাচ্ছি...', 0);
      }
    }

    // All tiers failed
    enginePromise = null;
    throw new Error(
      'সব মডেল লোড করা যায়নি। ইন্টারনেট কানেকশন চেক করুন অথবা পেজ রিফ্রেশ করুন।'
    );
  })();

  return enginePromise;
}

// ─── Identity Leak Filter ────────────────────────────────────────────────────
// Prevents base model names from leaking into responses.

function filterIdentityLeak(text) {
  return text
    .replace(/\bQwen2?\.?5?\b/gi,              AI_MODEL_NAME)
    .replace(/\bSmolLM2?\b/gi,                 AI_MODEL_NAME)
    .replace(/\bLlama[\s-]?3\.?2?\b/gi,        AI_MODEL_NAME)
    .replace(/\b(Alibaba|Meta|HuggingFace|MLC-AI)\b/gi, AI_CREATOR);
}

// ─── GPU Device Lost Detection ───────────────────────────────────────────────
// DXGI_ERROR_DEVICE_HUNG / GPUDevice lost crashes leave enginePromise pointing
// at a disposed object. Detect and force full reload on next call.

function isDeviceLostError(err) {
  const msg = String(err?.message || err || '');
  return /disposed|device.*lost|device.*removed|GPUDevice/i.test(msg);
}

// ─── Single Generation Attempt ───────────────────────────────────────────────

async function runOneAttempt(systemPrompt, history, userMessage, onProgress) {
  const engine = await loadEngine(null, onProgress);

  // Auto-detect user language every message
  const detectedLang  = detectLanguage(userMessage);
  selectedLanguage    = detectedLang;
  const langPrompt    = LANGUAGE_PROMPTS[detectedLang] || LANGUAGE_PROMPTS.english;

  const combinedSystemPrompt =
    IDENTITY_PROMPT + '\n\n' +
    ORG_INFO        + '\n\n' +
    langPrompt      +
    (systemPrompt ? '\n\n' + systemPrompt : '');

  const messages = [{ role: 'system', content: combinedSystemPrompt }];

  for (const m of history) {
    messages.push({
      role:    m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || ''
    });
  }
  messages.push({ role: 'user', content: userMessage });

  // temperature 0.3: reduces hallucination on factual queries for small models.
  // Not a perfect fix — model size is the root constraint — but meaningfully safer
  // than default 0.7 for a 135M–1B parameter device model.
  const reply = await engine.chat.completions.create({
    messages,
    temperature: 0.3,
    max_tokens:  400,
  });

  const rawText = reply?.choices?.[0]?.message?.content?.trim();
  if (!rawText) throw new Error('Local AI কোনো উত্তর দিতে পারেনি। আবার চেষ্টা করুন।');
  return filterIdentityLeak(rawText);
}

// ─── Public: Generate Reply ───────────────────────────────────────────────────
// Handles GPU device crash: resets engine and retries once before giving up.

async function generateReply(systemPrompt, history, userMessage, onProgress) {
  try {
    return await runOneAttempt(systemPrompt, history, userMessage, onProgress);
  } catch (err) {
    if (!isDeviceLostError(err)) throw err;

    // GPU crashed — clear stale engine and retry with fresh load
    if (onProgress) onProgress('GPU ক্র্যাশ — মডেল পুনরায় লোড হচ্ছে...', 0);
    enginePromise  = null;
    currentModelId = null;
    clearModelReady();

    try {
      return await runOneAttempt(systemPrompt, history, userMessage, onProgress);
    } catch (err2) {
      enginePromise  = null;
      currentModelId = null;
      clearModelReady();
      throw new Error(
        'ডিভাইসের GPU সাময়িকভাবে ক্র্যাশ করেছে (মেমরি/ড্রাইভার সমস্যা)। ' +
        'পেজ রিফ্রেশ করে আবার চেষ্টা করুন, অথবা অন্য ব্রাউজার ট্যাব বন্ধ করে জায়গা খালি করুন।'
      );
    }
  }
}

// ─── Manual Language Override ────────────────────────────────────────────────
// UI can call this; auto-detect overwrites it on the next user message.

function setLanguage(lang) {
  if (LANGUAGE_PROMPTS[lang]) {
    selectedLanguage = lang;
    return true;
  }
  return false;
}

// ─── Debug Helpers (browser console) ────────────────────────────────────────

window.listModels = async function () {
  try {
    const webllm = await import('https://esm.run/@mlc-ai/web-llm');
    const models = webllm.prebuiltAppConfig?.model_list || [];
    console.log('Available MLC models:');
    models.forEach(m => console.log('  ' + m.model_id));
  } catch (err) {
    console.error('Error listing models:', err.message);
  }
};

window.getCurrentModel = function () {
  return currentModelId || 'Not loaded yet';
};

window.getNetworkSpeed = async function () {
  const mbps = await estimateNetworkMbps();
  const tier  = MODEL_TIERS.find(t => mbps >= t.minSpeedMbps) || MODEL_TIERS[MODEL_TIERS.length - 1];
  console.log(`Network: ~${mbps.toFixed(2)} Mbps → Would pick: ${tier.label} (${tier.id})`);
  return mbps;
};

// ─── Pre-warm ────────────────────────────────────────────────────────────────
// Start loading in background as soon as the script is parsed (WebGPU only).
// Network speed test runs here so the engine is ready before the first message.

if (isSupported()) {
  loadEngine(null).catch(() => { enginePromise = null; });
}

// ─── Public API ──────────────────────────────────────────────────────────────

window.LocalAI = {
  isSupported,
  loadEngine,
  generateReply,
  setLanguage,
  detectLanguage,
  isModelReady,
  estimateNetworkMbps,
  MODEL_TIERS,
  FALLBACK_MODELS,
  SUPPORTED_LANGUAGES: Object.keys(LANGUAGE_PROMPTS)
};
