// public/webllm-local.js
//
// Local (offline) AI mode — WebGPU, multilingual (auto-detect) support
// Fallback logic: Qwen2.5-1.5B → Qwen3-0.6B → SmolLM2-360M

let enginePromise = null;
let currentModelId = null;
let selectedLanguage = 'english'; // last-detected language, auto-updates

const AI_NAME = 'KROVOS AI';
const AI_MODEL_NAME = 'Nova1';
const AI_CREATOR = 'SR Group';

const DEFAULT_MODEL = 'SmolLM2-360M-Instruct-q4f16_1-MLC';

const FALLBACK_MODELS = [
  'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  'Qwen3-0.6B-q4f32_1-MLC',
  'SmolLM2-360M-Instruct-q4f16_1-MLC'
];

// Identity + scope
const IDENTITY_PROMPT = `তোমার নাম ${AI_NAME}। তোমার model-এর নাম ${AI_MODEL_NAME}। তোমাকে পরিচালনা করে ${AI_CREATOR}।
তোমার কাজ: ${AI_CREATOR}-এর পণ্য/সেবা সম্পর্কিত প্রশ্নের উত্তর দেওয়া, সাধারণ কোডিং/টেকনিক্যাল সহায়তা দেওয়া, এবং সাধারণ তথ্য ও পরামর্শ প্রদান করা।
তুমি কখনো নিজেকে Qwen, SmolLM, Alibaba, HuggingFace বা অন্য কোনো base model বলবে না।
কেউ "তুমি কোন মডেল/AI" জিজ্ঞেস করলে শুধু বলবে: "আমি ${AI_MODEL_NAME}, ${AI_CREATOR}-এর ${AI_NAME}।"
ব্যবহারকারী যে ভাষায় প্রশ্ন করবে, ঠিক সেই ভাষায় উত্তর দেবে — ব্যবহারকারী ভাষা পাল্টালে তুমিও পাল্টাবে।`;

// SR Group org info — admin/contact question ashle eikhan theke bolbe
const ORG_INFO = `SR Group প্রশাসক: Sadiqur Rahman, Sakirul Islam।
যোগাযোগ ইমেইল: hossainalijms9@gmail.com
ওয়েবসাইট: https://krovos.rf.gd/
কেউ SR Group-এর admin/contact/website জিজ্ঞেস করলে এই তথ্য দিয়ে উত্তর দেবে।`;

// Language-specific system prompts (fallback style guide, per detected language)
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

function isSupported() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

// User message er script/character dekhe language detect kore
function detectLanguage(text) {
  if (!text) return 'english';
  if (/[\u3040-\u30FF]/.test(text)) return 'japanese';       // hiragana/katakana
  if (/[\u4E00-\u9FFF]/.test(text)) return 'chinese';         // hanzi (japanese kanji-only text o eikhane pore, rare case)
  if (/[\u0980-\u09FF]/.test(text)) return 'bengali';
  if (/[\u0900-\u097F]/.test(text)) return 'hindi';
  if (/[\u0600-\u06FF]/.test(text)) return 'urdu';
  if (/[¿¡ñÑ]/.test(text)) return 'spanish';
  if (/[àâçéèêëîïôùûüÀÂÇÉÈÊËÎÏÔÙÛÜ]/.test(text)) return 'french';
  return 'english';
}

async function loadEngine(modelId = DEFAULT_MODEL, onProgress) {
  if (!isSupported()) {
    throw new Error(
      'এই ডিভাইসে Local AI চলবে না। Chrome বা Edge (desktop) দিয়ে চেষ্টা করুন — WebGPU দরকার।'
    );
  }

  if (enginePromise && currentModelId !== modelId) {
    enginePromise = null;
  }

  if (enginePromise && currentModelId === modelId) {
    return enginePromise;
  }

  if (!enginePromise) {
    enginePromise = (async () => {
      for (const model of FALLBACK_MODELS) {
        try {
          if (onProgress) onProgress(`Trying ${model.split('-')[0]}...`, 0);

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
              if (onProgress) onProgress(`Model loaded: ${model}`, 100);
              return engine;
            } catch (err) {
              lastErr = err;
              if (onProgress) onProgress(`Attempt ${attempt} failed, retrying...`, 0);
              await new Promise((r) => setTimeout(r, 2000 * attempt));
            }
          }
          if (onProgress) onProgress(`${model.split('-')[0]} failed, trying next model...`, 0);
          continue;

        } catch (err) {
          if (onProgress) onProgress(`${model} error, trying next...`, 0);
          continue;
        }
      }

      enginePromise = null;
      throw new Error('সব models fail। Internet connection check করুন। Network stable নয়।');

    })();
  }

  return enginePromise;
}

function filterIdentityLeak(text) {
  return text
    .replace(/\bQwen2?\.?5?\b/gi, AI_MODEL_NAME)
    .replace(/\bSmolLM2?\b/gi, AI_MODEL_NAME)
    .replace(/\b(Alibaba|HuggingFace|MLC-AI)\b/gi, AI_CREATOR);
}

// FIX: GPU device crash (DXGI_ERROR_DEVICE_HUNG / "Device was lost") hole purono
// engine object disposed hoye jay, kintu enginePromise/currentModelId purono thake —
// tai porer call e shei mrito engine diye kaj korte giye "Object has already been
// disposed" throw hoto. Ekhon eirokom error dhorle enginePromise reset kore, fresh
// engine load kore ekbar retry kora hocche.
function isDeviceLostError(err) {
  const msg = String(err && err.message || err || '');
  return /disposed|device.*lost|device.*removed|GPUDevice/i.test(msg);
}

async function runOneAttempt(systemPrompt, history, userMessage, onProgress) {
  const engine = await loadEngine(DEFAULT_MODEL, onProgress);

  // Prottek message e user er vasha auto-detect
  const detectedLang = detectLanguage(userMessage);
  selectedLanguage = detectedLang;
  const langPrompt = LANGUAGE_PROMPTS[detectedLang] || LANGUAGE_PROMPTS.english;

  const messages = [];
  const combinedSystemPrompt =
    IDENTITY_PROMPT + '\n\n' + ORG_INFO + '\n\n' + langPrompt +
    (systemPrompt ? '\n\n' + systemPrompt : '');
  messages.push({ role: 'system', content: combinedSystemPrompt });

  for (const m of history) {
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || ''
    });
  }
  messages.push({ role: 'user', content: userMessage });

  const reply = await engine.chat.completions.create({
    messages,
    temperature: 0.7,
    max_tokens: 400,
  });

  const rawText = reply?.choices?.[0]?.message?.content?.trim();
  if (!rawText) throw new Error('Local AI কোনো উত্তর দিতে পারেনি। আবার চেষ্টা করুন।');
  return filterIdentityLeak(rawText);
}

async function generateReply(systemPrompt, history, userMessage, onProgress) {
  try {
    return await runOneAttempt(systemPrompt, history, userMessage, onProgress);
  } catch (err) {
    if (!isDeviceLostError(err)) throw err;

    // GPU device crash hoyeche — purono engine reference bad diye fresh load try kori
    if (onProgress) onProgress('GPU device crash — reloading model...', 0);
    enginePromise = null;
    currentModelId = null;

    try {
      return await runOneAttempt(systemPrompt, history, userMessage, onProgress);
    } catch (err2) {
      enginePromise = null;
      currentModelId = null;
      throw new Error(
        'ডিভাইসের GPU সাময়িকভাবে ক্র্যাশ করেছে (মেমরি/ড্রাইভার সমস্যা)। ' +
        'পেজ রিফ্রেশ করে আবার চেষ্টা করুন, অথবা অন্য ব্রাউজার ট্যাব বন্ধ করে জায়গা খালি করুন।'
      );
    }
  }
}

// Manual override still available (UI theke call korle e-o kaj korbe,
// kintu porer message e auto-detect abar overwrite kore dibe)
function setLanguage(lang) {
  if (LANGUAGE_PROMPTS[lang]) {
    selectedLanguage = lang;
    return true;
  }
  return false;
}

window.listModels = async function() {
  try {
    const webllm = await import('https://esm.run/@mlc-ai/web-llm');
    const models = webllm.prebuiltAppConfig?.model_list || [];
    console.log('Available models:');
    models.forEach(m => console.log('  ' + m.model_id));
  } catch (err) {
    console.error('Error:', err.message);
  }
};

window.getCurrentModel = function() {
  return currentModelId || 'Not loaded yet';
};

if (isSupported()) {
  loadEngine().catch(() => { enginePromise = null; });
}

window.LocalAI = {
  isSupported,
  loadEngine,
  generateReply,
  setLanguage,
  detectLanguage,
  SUPPORTED_LANGUAGES: Object.keys(LANGUAGE_PROMPTS),
  FALLBACK_MODELS
};
