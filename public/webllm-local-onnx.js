// public/webllm-local-onnx.js
//
// Hybrid Local AI: Desktop WebLLM (WebGPU) + Mobile ONNX Runtime (CPU/WASM)
// Auto-detects platform and loads best engine:
//   • Chrome/Edge Desktop   → WebLLM + WebGPU (fast) — ONLY if a real GPU adapter is available
//   • Mobile Chrome/Firefox → ONNX Runtime + CPU (fallback)
//   • Firefox Desktop       → ONNX Runtime + WASM (if available)
//   • Any device where WebGPU exists but requestAdapter() fails ("No available adapters",
//     Chrome/Windows powerPreference bug, disabled flags, blocklisted driver, etc.)
//     → ONNX Runtime + WASM/CPU (fixed in this version — see FIX comments below)
//
// Features:
//   - Auto platform detection
//   - FIX: real WebGPU capability probe (navigator.gpu.requestAdapter()) instead of just
//     checking that navigator.gpu exists. Some Chrome/Windows setups expose navigator.gpu
//     and even report "Hardware accelerated" in chrome://gpu, yet requestAdapter() still
//     fails ("No available adapters"). Previously we only checked `!!navigator.gpu`, so we
//     always tried WebLLM on Desktop Chrome, WebLLM failed deep inside model loading, and the
//     fallback chain re-threw the original server error instead of moving to ONNX. Now we
//     actually request an adapter up front and only pick WebLLM if that succeeds.
//   - Per-tier timeout (no infinite spinners)
//   - Race condition fix (isLoading lock)
//   - Identity leak filter
//   - Multilingual support
//   - GPU crash recovery

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

// FIX: this used to be synchronous and only checked `!!navigator.gpu`. That tells you the
// WebGPU *API* exists, not that a GPU adapter is actually obtainable — which is exactly the
// case that broke on the reported machine (WebGPU shows "Hardware accelerated" in chrome://gpu,
// but requestAdapter() still returns null / throws "No available adapters"). We now actually
// probe for a real adapter, with a short timeout so a hung/broken driver can't stall page load.
async function hasWorkingWebGPU() {
  if (typeof navigator === 'undefined' || !navigator.gpu || !navigator.gpu.requestAdapter) {
    return false;
  }
  try {
    const adapterPromise = navigator.gpu.requestAdapter();
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 4000));
    const adapter = await Promise.race([adapterPromise, timeoutPromise]);
    return !!adapter;
  } catch (e) {
    // e.g. "No available adapters." thrown directly by some Chrome/driver combinations
    return false;
  }
}

// FIX: getRuntime() is now async because it needs to actually probe the GPU (see
// hasWorkingWebGPU above) instead of just checking navigator.gpu existence. All call sites
// below have been updated to `await getRuntime()`.
async function getRuntime() {
  const ua = navigator.userAgent;
  const isMobile = /Mobile|Android|iPhone|iPad|tablet/i.test(ua);
  const isChrome = /Chrome|Chromium|CriOS/i.test(ua);
  const isFirefox = /Firefox/i.test(ua);

  // FIX: mobile used to short-circuit straight to ONNX/CPU before any GPU probe ran at all —
  // so a capable device (e.g. Pixel 9 / Android Chrome 151, confirmed `navigator.gpu
  // .requestAdapter()` succeeds) was always forced onto tiny ONNX models even though it could
  // run WebLLM fine. Now mobile Chrome also gets a real adapter probe; only mobile browsers
  // that genuinely lack a working adapter (older devices, Firefox Android, in-app webviews,
  // etc.) fall back to ONNX.
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
    // FIX: this is the branch that used to be missing. Desktop Chrome with navigator.gpu
    // present but no real adapter (driver/flag/blocklist issue) now correctly falls back to
    // ONNX instead of being routed into WebLLM and failing deep inside model load.
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

// FIX: runtime used to be computed synchronously at script load (`let runtime = getRuntime();`)
// which meant it was captured before we could actually test the GPU. Now it starts as null and
// is resolved lazily (and cached) by ensureRuntime() below, the first time it's actually needed.
let runtime            = null;
let runtimePromise     = null;

// FIX: lazily resolves and caches `runtime`. Every place that used to read the module-level
// `runtime` variable directly now calls `await ensureRuntime()` instead, so the real async
// GPU probe always runs before any load decision is made.
async function ensureRuntime() {
  if (runtime) return runtime;
  if (!runtimePromise) runtimePromise = getRuntime();
  runtime = await runtimePromise;
  return runtime;
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

// FIX: new helper — recognizes the "adapter never available in the first place" failure mode
// (as opposed to a device that was working and then crashed/was lost mid-session). This is
// exactly the case from the reported logs: "No available adapters." thrown directly out of
// requestAdapter(), sometimes tied to Chrome's Windows powerPreference bug. We treat this the
// same way we treat a lost device: reset engine state and drop straight to ONNX instead of
// burning through retries against a GPU that was never going to answer.
function isAdapterUnavailableError(err) {
  const msg = String(err?.message || err || '');
  return /no available adapters?/i.test(msg);
}

// ─── Identity Leak Filter ────────────────────────────────────────────────────

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

    // Retry chain: FIXED sequential fallback — Big → Medium → Qwen2.5 → Compact → Emergency.
    // targetTier (network-picked) decides where to START in that fixed chain, not the order
    // itself — chain always big-first, never reversed. Model below start tier not retried
    // (already smaller than what network can handle), model above start tier also skipped.
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
            // FIX: if the adapter genuinely isn't available (e.g. "No available adapters."),
            // retrying the same tier or trying smaller tiers won't help — it's not a
            // model-size problem, it's a GPU-access problem. Bail out of the whole WebLLM
            // attempt immediately so the caller can fall back to ONNX right away, instead of
            // burning through MAX_RETRIES × every tier for a GPU that will never respond.
            if (isAdapterUnavailableError(err)) {
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
        if (isAdapterUnavailableError(err)) {
          throw err; // propagate immediately, see comment above
        }
        if (onProgress) onProgress('পরবর্তী মডেলে যাচ্ছি...', 0);
      }
    }

    throw new Error('WebLLM সব মডেল ব্যর্থ');
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

    // Try Transformers.js with better error handling
    if (onProgress) onProgress('Text Generation Tool লোড হচ্ছে...', 20);

    let generator = null;

    try {
      // Try dynamic import with timeout
      const transformers = await withTimeout(
        import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.6.0'),
        30_000,
        'Transformers library load timeout'
      );

      if (onProgress) onProgress('মডেল ক্যাশ করা হচ্ছে...', 40);

      // Load model with timeout
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

      // Return wrapper object
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
      // Fallback: Simple text-based response generator
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

              // Simple response based on keywords
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
  // Concurrency lock
  if (isLoading && enginePromise) return enginePromise;

  // FIX: must resolve the real runtime (async GPU probe) before comparing / deciding anything.
  const rt = await ensureRuntime();

  if (enginePromise && currentEngineType === rt.type && currentModelId === modelId) {
    return enginePromise; // Reuse
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
          // FIX: this is the key behavior change. Previously, if runtime.type was 'webllm'
          // and it failed for any reason (including "No available adapters"), the error was
          // simply thrown — there was no code path that dropped down to ONNX afterwards.
          // Now, if WebLLM fails specifically because the GPU adapter genuinely isn't
          // available, we transparently retry with ONNX instead of surfacing a dead end.
          if (isAdapterUnavailableError(err) || isDeviceLostError(err)) {
            if (onProgress) onProgress('WebGPU পাওয়া যায়নি, ONNX-এ যাচ্ছি...', 0);
            runtime = { type: 'onnx', backend: 'wasm', label: 'Desktop (WebGPU unavailable) + ONNX WASM' };
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

  return filterIdentityLeak(rawText);
}

// ─── Public: Generate Reply ───────────────────────────────────────────────────

async function generateReply(systemPrompt, history, userMessage, onProgress) {
  try {
    return await runOneAttempt(systemPrompt, history, userMessage, onProgress);
  } catch (err) {
    if (!isDeviceLostError(err) && !isAdapterUnavailableError(err)) throw err;

    // GPU crashed, or was never available in the first place — reset and retry.
    // FIX: previously only isDeviceLostError() triggered this reset/retry path, so
    // "No available adapters" (thrown up front, not mid-session) skipped straight to the
    // final catch below and threw a hard "GPU ক্র্যাশ — পেজ রিফ্রেশ করুন" error. Now both
    // cases reset engine state and retry once, which (thanks to the loadEngine fix above)
    // will correctly land on ONNX this time instead of hitting WebGPU again.
    if (onProgress) onProgress('GPU রিসেট হচ্ছে...', 0);
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
  // FIX: kept synchronous for backwards compatibility with any code/console usage that expects
  // an immediate value, but now returns the *resolved* runtime if already probed, otherwise a
  // clearly-labeled "not probed yet" placeholder instead of a stale synchronous guess.
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

// FIX: added for easy manual debugging from the console — lets you check
// `await window.checkWebGPU()` directly without digging through the module.
window.checkWebGPU = async function () {
  const works = await hasWorkingWebGPU();
  console.log('Real WebGPU adapter available:', works);
  return works;
};

// FIX: ensureRuntime() caches its result forever (`if (runtime) return runtime`). If the very
// first probe (e.g. the 5s pre-warm timer right after page load) hits a false negative —
// adapter not fully ready yet, timing race inside the 4s hasWorkingWebGPU() timeout — the
// runtime gets permanently cached as 'onnx' for the rest of the page's life, even though a
// later manual checkWebGPU() call confirms the adapter works fine. This gives a manual escape
// hatch: clear the cache and force a fresh probe on the next loadEngine()/waitUntilReady() call,
// without needing a full page reload.
window.resetRuntime = function () {
  runtime = null;
  runtimePromise = null;
  enginePromise = null;
  currentModelId = null;
  currentEngineType = null;
  engineReady = false;
  isLoading = false;
  clearModelReady();
  console.log('Runtime cache cleared — next loadEngine()/waitUntilReady() call will re-probe GPU.');
};

// ─── Pre-warm (5s delay to let page settle) ──────────────────────────────────

// FIX: pre-warm now waits for ensureRuntime() (the real async GPU probe) before deciding
// whether to kick off a WebLLM pre-load. Previously this checked the old synchronous
// `runtime.type === 'webllm'` immediately at script-load time, before any GPU probing could
// happen, so it could never have been correct anyway on a page that hadn't probed yet.
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
  // FIX: isSupported() used to synchronously check `runtime.type === 'webllm' ? !!navigator.gpu
  // : true`, which (a) read the stale synchronous `runtime` and (b) always returned true for the
  // non-WebGPU path anyway. ONNX (CPU/WASM) works essentially everywhere, so this now simply
  // always returns true — the real "can we actually use the GPU" decision now correctly lives
  // inside getRuntime()/hasWorkingWebGPU(), not here.
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

// FIX: the init log used to print the (incorrectly synchronous) runtime guess immediately.
// Now it waits for the real probe so the console log reflects the runtime that will actually
// be used, which is a lot less confusing when debugging exactly the issue reported here.
(async () => {
  const rt = await ensureRuntime();
  console.log(`🚀 LocalAI Hybrid initialized: ${rt.label}`);
})();
