// public/webllm-local-onnx.js
//
// Hybrid Local AI: Desktop WebLLM (WebGPU) + Mobile ONNX Runtime (CPU/WASM)
// Auto-detects platform and loads best engine:
//   • Chrome/Edge Desktop   → WebLLM + WebGPU (fast) — ONLY if a real GPU adapter is available
//   • Mobile Chrome/Firefox → ONNX Runtime + CPU (fallback)
//   • Firefox Desktop       → ONNX Runtime + WASM (if available)
//   • Any device where WebGPU exists but requestAdapter() fails ("No available adapters",
//     Chrome/Windows powerPreference bug, disabled flags, blocklisted driver, etc.)
//     → ONNX Runtime + WASM/CPU
//   • Any device where the GPU/adapter works fine but the model shard CDN download itself
//     fails (net::ERR_FAILED, "Failed to fetch", etc. — e.g. Hugging Face Xet CDN hiccup)
//     → ONNX Runtime + WASM/CPU (NEW — see isNetworkFetchError FIX comments below)
//
// Features:
//   - Auto platform detection
//   - Real WebGPU capability probe (navigator.gpu.requestAdapter()) instead of just
//     checking that navigator.gpu exists.
//   - Per-tier timeout (no infinite spinners)
//   - Race condition fix (isLoading lock)
//   - Identity leak filter
//   - Multilingual support
//   - GPU crash recovery
//   - NEW: CDN/network fetch-failure recovery (shard download fails mid-transfer → ONNX)

// ─── Model Ready Flag ────────────────────────────────────────────────────────

const MODEL_READY_KEY = 'krovos_local_model_ready_hybrid_v1';
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

const AI_NAME       = 'KROVOS AI';
const AI_MODEL_NAME = 'KROVOS';
const AI_CREATOR    = 'SR Group';

// ─── Platform Detection ──────────────────────────────────────────────────────

async function hasWorkingWebGPU() {
  if (typeof navigator === 'undefined' || !navigator.gpu || !navigator.gpu.requestAdapter) {
    return false;
  }
  try {
    const adapterPromise = navigator.gpu.requestAdapter();
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 15000));
    const adapter = await Promise.race([adapterPromise, timeoutPromise]);
    return !!adapter;
  } catch (e) {
    return false;
  }
}

async function detectRuntime() {
  const ua = navigator.userAgent;
  const isMobile = /Mobile|Android|iPhone|iPad|tablet/i.test(ua);
  const isChrome = /Chrome|Chromium|CriOS/i.test(ua);
  const isFirefox = /Firefox/i.test(ua);

  if (isMobile) {
    if (isChrome) {
      const gpuWorks = await hasWorkingWebGPU();
      if (gpuWorks) {
        return { type: 'webllm', backend: 'webgpu', label: 'Mobile Chrome + WebGPU' };
      }
    }
    return { type: 'onnx', backend: 'cpu', label: 'Mobile + ONNX CPU' };
  }

  if (isChrome) {
    const gpuWorks = await hasWorkingWebGPU();
    if (gpuWorks) {
      return { type: 'webllm', backend: 'webgpu', label: 'Desktop Chrome/Edge + WebGPU' };
    }
    return { type: 'onnx', backend: 'wasm', label: 'Desktop Chrome (WebGPU unavailable) + ONNX WASM' };
  }

  if (isFirefox) {
    return { type: 'onnx', backend: 'wasm', label: 'Firefox + ONNX WASM' };
  }

  return { type: 'onnx', backend: 'cpu', label: 'Fallback + ONNX CPU' };
}

// ─── WebLLM: Network-Aware Model Tiers ───────────────────────────────────────

const WEBLLM_TIERS = [
  {
    id:          'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    sizeGB:       0.75,
    minSpeedMbps: 50,
    timeoutMs:    180_000,
    label:       'Tier 1 — High-end (Big)'
  },
  {
    id:          'Phi-3.5-mini-instruct-q4f16_1-MLC',
    sizeGB:       2.2,
    minSpeedMbps: 25,
    timeoutMs:    180_000,
    label:       'Tier 1.5 — Medium'
  },
  {
    id:          'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    sizeGB:       1.0,
    minSpeedMbps: 10,
    timeoutMs:    180_000,
    label:       'Tier 2 — Balanced (Qwen2.5)'
  },
  {
    id:          'Qwen3-0.6B-q4f32_1-MLC',
    sizeGB:       0.4,
    minSpeedMbps: 3,
    timeoutMs:    120_000,
    label:       'Tier 3 — Compact'
  },
  {
    id:          'SmolLM2-360M-Instruct-q4f16_1-MLC',
    sizeGB:       0.2,
    minSpeedMbps: 0,
    timeoutMs:    60_000,
    label:       'Tier 4 — Emergency'
  }
];

// ─── ONNX: Lightweight Models (Mobile/Firefox) ─────────────────────────────

const ONNX_MODELS = [
  {
    id:    'distilgpt2',
    url:   'https://huggingface.co/Xenova/distilgpt2/resolve/main/onnx/',
    sizeGB: 0.15,
    label: 'DistilGPT-2 (lightweight)'
  },
  {
    id:    'distilbert-base',
    url:   'https://huggingface.co/Xenova/distilbert-base-uncased/resolve/main/onnx/',
    sizeGB: 0.1,
    label: 'DistilBERT (tiny)'
  }
];

// ─── Network Speed Estimation ────────────────────────────────────────────────

async function estimateNetworkMbps() {
  const testUrl     = 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js';
  const sampleBytes = 90_000;
  try {
    const start   = performance.now();
    await fetch(testUrl, { cache: 'no-store' });
    const elapsed = (performance.now() - start) / 1000;
    const mbps    = (sampleBytes * 8) / (elapsed * 1_000_000);
    return mbps;
  } catch {
    return 2;
  }
}

async function pickWebLLMForNetwork(onProgress) {
  if (onProgress) onProgress('নেটওয়ার্ক গতি পরীক্ষা হচ্ছে...', 0);
  const mbps = await estimateNetworkMbps();
  if (onProgress) onProgress(`নেটওয়ার্ক: ~${mbps.toFixed(1)} Mbps`, 5);

  const picked = WEBLLM_TIERS.find(t => mbps >= t.minSpeedMbps)
              || WEBLLM_TIERS[WEBLLM_TIERS.length - 1];

  if (onProgress) onProgress(`মডেল নির্বাচিত: ${picked.label}`, 10);
  return picked;
}

// ─── Timeout Wrapper ─────────────────────────────────────────────────────────

function withTimeout(promise, timeoutMs, errorMsg = 'LOAD_TIMEOUT') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(errorMsg)), timeoutMs)
    )
  ]);
}

// ─── Engine State ────────────────────────────────────────────────────────────

let enginePromise      = null;
let currentEngineType  = null;  // 'webllm' or 'onnx'
let currentModelId     = null;
let isLoading          = false;
let engineReady        = false;
let selectedLanguage   = 'english';

let runtime            = null;
let runtimePromise     = null;
let runtimeGeneration  = 0;

async function ensureRuntime() {
  if (runtime) return runtime;
  if (runtimePromise) return runtimePromise;
  const myGeneration = ++runtimeGeneration;
  runtimePromise = detectRuntime().then((result) => {
    if (myGeneration === runtimeGeneration) {
      runtime = result;
      runtimePromise = null;
    }
    return result;
  });
  return runtimePromise;
}

// ─── Identity + Scope Prompts ────────────────────────────────────────────────

const IDENTITY_PROMPT = `আপনি ${AI_NAME}। আপনাকে তৈরি করেছে ${AI_CREATOR}।

**আপনার পরিচয়:**
নাম: ${AI_NAME}
নির্মাতা: ${AI_CREATOR} (সদিকুর রহমান এবং সাকিরুল ইসলাম)
যোগাযোগ: hossainalijms9@gmail.com
ওয়েবসাইট: https://krovos.rf.gd/

**আপনার কাজ:**
১. ${AI_CREATOR}-এর পণ্য/সেবা সম্পর্কিত প্রশ্নের উত্তর দেওয়া
২. ছাত্রছাত্রীদের জন্য শিক্ষামূলক সহায়তা প্রদান
৩. সাধারণ কোডিং সমস্যা সমাধান
৪. PDF reader এবং document reader সুবিধা সম্পর্কে সহায়তা
৫. পড়াশোনা সংক্রান্ত সাধারণ পরামর্শ দেওয়া

**গুরুত্বপূর্ণ নিয়ম:**
- কখনো নিজেকে Qwen, SmolLM, Llama, Claude বা অন্য কোনো AI বলবেন না
- যদি কেউ "তুমি কে?" বা "তোমার নাম কি?" জিজ্ঞাসা করে, উত্তর দিন: "আমি ${AI_NAME}, ${AI_CREATOR} দ্বারা তৈরি। ${AI_CREATOR}-এর প্রতিষ্ঠাতা হলেন সদিকুর রহমান এবং সাকিরুল ইসলাম।"
- ব্যবহারকারী যে ভাষায় প্রশ্ন করবে, সেই ভাষায়ই উত্তর দিন
- জটিল বা নির্দিষ্ট তথ্যে নিশ্চিত না থাকলে স্পষ্টভাবে "আমি নিশ্চিত নই" বলুন — কখনো আন্দাজে উত্তর দেবেন না
- শুধুমাত্র প্রশ্নের সরাসরি উত্তর দিন, অপ্রয়োজনীয় তথ্য যোগ করবেন না
- ছাত্রছাত্রীদের সাথে বন্ধুত্বপূর্ণ এবং সহায়ক থাকুন`;

const ORG_INFO = `**SR Group - পরিচয়:**
প্রতিষ্ঠাতা: সদিকুর রহমান (Sadiqur Rahman), সাকিরুল ইসলাম (Sakirul Islam)
প্রধান পণ্য: KROVOS AI (শিক্ষার্থীদের জন্য স্থানীয় AI সহায়ক)
সেবা: কোডিং সহায়তা, PDF/Document পড়া এবং বিশ্লেষণ, শিক্ষা উপকরণ
যোগাযোগ: hossainalijms9@gmail.com
ওয়েবসাইট: https://krovos.rf.gd/

**বিশেষত্ব:**
✓ স্থানীয় AI (ডিভাইসে চলে, ইন্টারনেট প্রয়োজন নেই)
✓ ছাত্রছাত্রীদের জন্য বিশেষভাবে ডিজাইন করা
✓ বাংলা ভাষা সম্পূর্ণ সাপোর্ট
✓ PDF এবং ডকুমেন্ট পড়া ও বিশ্লেষণ করা যায়`;

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

  spanish: `Eres un asistente útil. Proporciona explicaciones claras y amigables.
Responde en español completo.`,

  french: `Vous êtes un assistant utile. Fournissez des explications claires.
Répondez en français complet.`,

  urdu: `آپ ایک معاون ہیں۔ طالب علم کے لیے دوست انہ وضاحت دیں۔
تمام جوابات اردو میں لکھیں۔`
};

function detectLanguage(text) {
  if (!text) return 'english';
  if (/[\u3040-\u30FF]/.test(text)) return 'japanese';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'chinese';
  if (/[\u0980-\u09FF]/.test(text)) return 'bengali';
  if (/[\u0900-\u097F]/.test(text)) return 'hindi';
  if (/[\u0600-\u06FF]/.test(text)) return 'urdu';
  if (/[¿¡ñÑ]/.test(text))         return 'spanish';
  if (/[àâçéèêëîïôùûüÀÂÇÉÈÊËÎÏÔÙÛÜ]/.test(text)) return 'french';
  return 'english';
}

// ─── Device Lost Error Detection ─────────────────────────────────────────────

function isDeviceLostError(err) {
  const msg = String(err?.message || err || '');
  return /disposed|device.*lost|device.*removed|GPUDevice/i.test(msg);
}

function isAdapterUnavailableError(err) {
  const msg = String(err?.message || err || '');
  return /no available adapters?/i.test(msg);
}

// FIX (NEW): detects browser-level network/CDN fetch failures during shard download — e.g.
// net::ERR_FAILED from Hugging Face's Xet CDN, where the request gets a 302 redirect to a
// signed URL, that signed URL responds 200, but the actual byte transfer stalls at ~0.5 kB
// "Pending" and finally fails. This is distinct from isAdapterUnavailableError (GPU never
// available) and isDeviceLostError (GPU crashed mid-session) — the GPU is fine here, it's the
// download itself that's broken. Retrying the same WebLLM tier or a smaller tier won't help
// since the CDN issue affects every shard equally; the caller should fall straight to ONNX.
function isNetworkFetchError(err) {
  const msg = String(err?.message || err || '');
  if (/failed to fetch|net::err_failed|networkerror|load failed|err_failed/i.test(msg)) {
    return true;
  }
  return err?.name === 'TypeError' && /fetch/i.test(msg);
}

// ─── Identity Leak Filter ────────────────────────────────────────────────────

function stripThinkTags(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim();
}

function filterIdentityLeak(text) {
  return text
    .replace(/\b(Qwen2?\.?5?|SmolLM2?|Llama[\s-]?3\.?2?)\b/gi, AI_MODEL_NAME)
    .replace(/\b(DistilGPT|DistilBERT)\b/gi, AI_MODEL_NAME)
    .replace(/\b(Alibaba|Meta|HuggingFace|MLC-AI)\b/gi, AI_CREATOR);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEBLLM ENGINE (Desktop Chrome/Edge + WebGPU)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function loadWebLLMEngine(modelId = null, onProgress) {
  try {
    const webllm = await import('https://esm.run/@mlc-ai/web-llm');
    const engine = new webllm.MLCEngine();

    engine.setInitProgressCallback((report) => {
      if (onProgress) onProgress(report.text, report.progress);
    });

    // Auto-pick or use specified model
    let targetTier;
    if (modelId) {
      targetTier = WEBLLM_TIERS.find(t => t.id === modelId) || WEBLLM_TIERS[WEBLLM_TIERS.length - 1];
    } else {
      targetTier = await pickWebLLMForNetwork(onProgress);
    }

    const startIdx = WEBLLM_TIERS.findIndex(t => t.id === targetTier.id);
    const tryOrder = WEBLLM_TIERS.slice(startIdx >= 0 ? startIdx : 0);

    for (const tier of tryOrder) {
      const shortName = tier.id.split('-').slice(0, 2).join(' ');

      try {
        if (onProgress) onProgress(`লোড হচ্ছে: ${shortName}...`, 0);

        const MAX_RETRIES = 3;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            await withTimeout(
              engine.reload(tier.id),
              tier.timeoutMs,
              'WebLLM load timeout'
            );
            currentModelId = tier.id;
            currentEngineType = 'webllm';
            engineReady = true;
            markModelReady();
            if (onProgress) onProgress(`প্রস্তুত: ${shortName}`, 100);
            return engine;
          } catch (err) {
            // FIX: adapter unavailable OR CDN/network fetch failure — neither is a
            // model-size problem, so retrying this tier (or trying smaller tiers) is
            // pointless. Bail out of the whole WebLLM attempt immediately so the caller
            // can fall back to ONNX right away.
            if (isAdapterUnavailableError(err) || isNetworkFetchError(err)) {
              throw err;
            }
            if (err.message && err.message.includes('timeout')) {
              if (onProgress) onProgress(`${shortName} timeout, ছোট মডেলে যাচ্ছি...`, 0);
              break;
            }
            if (attempt < MAX_RETRIES) {
              if (onProgress) onProgress(`চেষ্টা ${attempt} ব্যর্থ, পুনরায়...`, 0);
              await new Promise(r => setTimeout(r, 2000 * attempt));
            }
          }
        }
      } catch (err) {
        // FIX: same bail-immediately behavior at the per-tier loop level.
        if (isAdapterUnavailableError(err) || isNetworkFetchError(err)) {
          throw err;
        }
        if (onProgress) onProgress('পরবর্তী মডেলে যাচ্ছি...', 0);
      }
    }
    const exhaustedErr = new Error('WebLLM সব মডেল ব্যর্থ');
    exhaustedErr.isFallbackEligible = true;
    throw exhaustedErr;
  } catch (err) {
    throw err;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ONNX ENGINE (Mobile + Firefox + CPU/WASM Fallback)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let onnxSession = null;
let onnxTokenizer = null;

async function loadONNXEngine(modelId = null, onProgress) {
  try {
    if (onProgress) onProgress('ONNX Runtime লোড হচ্ছে...', 5);
    if (onProgress) onProgress('Text Generation Tool লোড হচ্ছে...', 20);

    let generator = null;

    try {
      const transformers = await withTimeout(
        import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.6.0'),
        30_000,
        'Transformers library load timeout'
      );

      if (onProgress) onProgress('মডেল ক্যাশ করা হচ্ছে...', 40);

      generator = await withTimeout(
        transformers.pipeline('text-generation', 'Xenova/distilgpt2'),
        60_000,
        'Model load timeout'
      );

      currentModelId = 'distilgpt2-onnx';
      currentEngineType = 'onnx';
      engineReady = true;
      markModelReady();

      if (onProgress) onProgress('প্রস্তুত: DistilGPT-2', 100);

      return {
        chat: {
          completions: {
            create: async function(params) {
              const messages = params.messages || [];
              const lastUserMsg = messages
                .filter(m => m.role === 'user')
                .slice(-1)[0]?.content || '';

              if (!lastUserMsg) {
                return {
                  choices: [{
                    message: { content: 'কোনো প্রশ্ন পাইনি।' }
                  }]
                };
              }

              const input = lastUserMsg.substring(0, 80);

              try {
                const result = await generator(input, {
                  max_new_tokens: Math.min(params.max_tokens || 150, 150),
                  temperature: params.temperature || 0.7,
                });

                return {
                  choices: [{
                    message: {
                      content: result?.[0]?.generated_text || 'দুঃখিত, উত্তর তৈরি হয়নি।'
                    }
                  }]
                };
              } catch (genErr) {
                return {
                  choices: [{
                    message: { content: 'উত্তর তৈরি করা যায়নি। আবার চেষ্টা করুন।' }
                  }]
                };
              }
            }
          }
        }
      };

    } catch (transformersErr) {
      if (onProgress) onProgress('Fallback mode: সাধারণ উত্তর', 80);

      currentModelId = 'fallback-text';
      currentEngineType = 'onnx-fallback';
      engineReady = true;
      markModelReady();

      if (onProgress) onProgress('প্রস্তুত: Fallback Mode', 100);

      return {
        chat: {
          completions: {
            create: async function(params) {
              const messages = params.messages || [];
              const lastUserMsg = messages
                .filter(m => m.role === 'user')
                .slice(-1)[0]?.content || '';

              const responses = {
                'কোন': 'আমি আপনার প্রশ্নের উত্তর দিতে প্রস্তুত।',
                'কি': 'এটি একটি ভালো প্রশ্ন। আরও বিস্তারিত বলুন।',
                'কেন': 'এর পেছনে অনেক কারণ আছে।',
                'কোথা': 'এটি স্থানীয়ভাবে আপনার ডিভাইসে চলছে।',
                'কিভাবে': 'ধাপে ধাপে বলছি...',
                'hello': 'নমস্কার! আমি আপনার সহায়ক।',
                'hi': 'হাই! কি খবর?',
                'আমার': 'আপনার সম্পর্কে জানতে চান?',
                'নাম': 'আমার নাম Nova1।'
              };

              const found = Object.keys(responses).find(key =>
                lastUserMsg.toLowerCase().includes(key)
              );

              return {
                choices: [{
                  message: {
                    content: found ? responses[found] : 'আপনার কথা বুঝতে পারলাম না। আরও স্পষ্টভাবে বলুন।'
                  }
                }]
              };
            }
          }
        }
      };
    }

  } catch (err) {
    throw new Error(`ONNX লোড ব্যর্থ: ${err.message}`);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UNIFIED ENGINE LOADER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function loadEngine(modelId = null, onProgress) {
  if (isLoading && enginePromise) return enginePromise;

  const rt = await ensureRuntime();

  if (enginePromise && currentEngineType === rt.type && currentModelId === modelId) {
    return enginePromise;
  }

  isLoading = true;
  engineReady = false;
  enginePromise = null;

  enginePromise = (async () => {
    try {
      if (onProgress) onProgress(`Runtime: ${rt.label}`, 0);

      if (rt.type === 'webllm') {
        try {
          return await loadWebLLMEngine(modelId, onProgress);
        } catch (err) {
          // FIX: now also catches CDN/network fetch failures (isNetworkFetchError), not just
          // adapter-unavailable and device-lost. GPU works fine here — the shard download
          // itself failed (e.g. net::ERR_FAILED from Hugging Face's Xet CDN) — so fall to
          // ONNX transparently instead of surfacing a dead-end error.
                  if (isAdapterUnavailableError(err) || isDeviceLostError(err) || isNetworkFetchError(err) || err.isFallbackEligible) {
            if (onProgress) onProgress('নেটওয়ার্ক/GPU সমস্যা, ONNX-এ যাচ্ছি...', 0);
            runtime = { type: 'onnx', backend: 'wasm', label: 'Desktop (WebLLM unavailable) + ONNX WASM' };
            return await loadONNXEngine(modelId, onProgress);
          }
          throw err;
        }
      } else {
        return await loadONNXEngine(modelId, onProgress);
      }
    } catch (err) {
      enginePromise = null;
      currentModelId = null;
      currentEngineType = null;
      engineReady = false;
      throw err;
    } finally {
      isLoading = false;
    }
  })();

  return enginePromise;
}

// ─── Single Generation Attempt ───────────────────────────────────────────────

async function runOneAttempt(systemPrompt, history, userMessage, onProgress) {
  const engine = await loadEngine(null, onProgress);

  const detectedLang = detectLanguage(userMessage);
  selectedLanguage = detectedLang;
  const langPrompt = LANGUAGE_PROMPTS[detectedLang] || LANGUAGE_PROMPTS.english;

  const combinedSystemPrompt =
    IDENTITY_PROMPT + '\n\n' +
    ORG_INFO + '\n\n' +
    langPrompt +
    (systemPrompt ? '\n\n' + systemPrompt : '');

  const messages = [{ role: 'system', content: combinedSystemPrompt }];

  for (const m of history) {
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || ''
    });
  }

  messages.push({ role: 'user', content: userMessage });

  const reply = await engine.chat.completions.create({
    messages,
    temperature: 0.3,
    max_tokens: 400,
  });

  const rawText = reply?.choices?.[0]?.message?.content?.trim();
  if (!rawText) throw new Error('AI কোনো উত্তর দিতে পারেনি।');

  return filterIdentityLeak(stripThinkTags(rawText));
}

// ─── Public: Generate Reply ───────────────────────────────────────────────────

async function generateReply(systemPrompt, history, userMessage, onProgress) {
  try {
    return await runOneAttempt(systemPrompt, history, userMessage, onProgress);
  } catch (err) {
    // FIX: now also resets/retries on a CDN/network fetch failure, not just device-lost or
    // adapter-unavailable. Previously a net::ERR_FAILED here would skip straight to the final
    // catch below and throw a hard "GPU ক্র্যাশ" error even though the GPU was never the issue.
    if (!isDeviceLostError(err) && !isAdapterUnavailableError(err) && !isNetworkFetchError(err)) throw err;

    if (onProgress) onProgress('রিসেট হচ্ছে...', 0);
    enginePromise = null;
    currentModelId = null;
    currentEngineType = null;
    engineReady = false;
    isLoading = false;
    clearModelReady();
    runtime = null;
    runtimePromise = null;

    try {
      return await runOneAttempt(systemPrompt, history, userMessage, onProgress);
    } catch (err2) {
      enginePromise = null;
      currentEngineType = null;
      engineReady = false;
      clearModelReady();
      throw new Error('স্থানীয় AI (WebGPU/ONNX) লোড করা যায়নি এই ডিভাইসে। পেজ রিফ্রেশ করে আবার চেষ্টা করুন।');
    }
  }
}

// ─── Language Control ────────────────────────────────────────────────────────

function setLanguage(lang) {
  if (LANGUAGE_PROMPTS[lang]) {
    selectedLanguage = lang;
    return true;
  }
  return false;
}

// ─── Ready State ─────────────────────────────────────────────────────────────

function isEngineReady() {
  return engineReady;
}

async function waitUntilReady(onProgress) {
  if (engineReady) return;
  await loadEngine(null, onProgress);
}

// ─── Debug Helpers ───────────────────────────────────────────────────────────

window.getRuntime = function () {
  return runtime || { type: 'unknown', backend: 'unknown', label: 'Not probed yet — call window.LocalAI.waitUntilReady() first' };
};

window.getCurrentModel = function () {
  return currentModelId || 'Not loaded';
};

window.getEngineType = function () {
  return currentEngineType || 'None';
};

window.getNetworkSpeed = async function () {
  const mbps = await estimateNetworkMbps();
  console.log(`Network: ~${mbps.toFixed(2)} Mbps`);
  return mbps;
};

window.checkWebGPU = async function () {
  const works = await hasWorkingWebGPU();
  console.log('Real WebGPU adapter available:', works);
  return works;
};

window.debugWebGPU = async function () {
  console.time('requestAdapter');
  try {
    const adapter = await navigator.gpu.requestAdapter();
    console.timeEnd('requestAdapter');
    console.log('adapter:', adapter);
    return adapter;
  } catch (e) {
    console.timeEnd('requestAdapter');
    console.error('requestAdapter threw:', e);
    return null;
  }
};

window.resetRuntime = function () {
  runtime = null;
  runtimePromise = null;
  runtimeGeneration++;
  enginePromise = null;
  currentModelId = null;
  currentEngineType = null;
  engineReady = false;
  isLoading = false;
  clearModelReady();
  console.log('Runtime cache cleared — next loadEngine()/waitUntilReady() call will re-probe GPU.');
};

// ─── Pre-warm (5s delay to let page settle) ──────────────────────────────────

(async () => {
  try {
    const rt = await ensureRuntime();
    if (rt.type === 'webllm') {
      setTimeout(() => {
        loadEngine(null).catch(() => {
          enginePromise = null;
          currentModelId = null;
          engineReady = false;
          isLoading = false;
        });
      }, 5000);
    }
  } catch (e) {
    // ignore — first real generateReply() call will retry engine load anyway
  }
})();

// ─── Public API ──────────────────────────────────────────────────────────────

window.LocalAI = {
  isSupported: () => true,
  getRuntime: ensureRuntime,
  loadEngine,
  generateReply,
  setLanguage,
  detectLanguage,
  isModelReady,
  isEngineReady,
  waitUntilReady,
  estimateNetworkMbps,
  checkWebGPU: hasWorkingWebGPU,
  SUPPORTED_LANGUAGES: Object.keys(LANGUAGE_PROMPTS),
  WEBLLM_TIERS,
  ONNX_MODELS
};

// ─── Init Message ────────────────────────────────────────────────────────────

(async () => {
  const rt = await ensureRuntime();
  console.log(`🚀 LocalAI Hybrid initialized: ${rt.label}`);
})();
