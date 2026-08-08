// public/webllm-local.js
//
// Local (offline) AI mode — WebGPU, multilingual support
// Fallback logic: SmolLM2-360M → SmolLM2-135M → Qwen3-0.6B
// Network fail হলে পরবর্তী ছোট model চেষ্টা করবে।

let enginePromise = null;
let currentModelId = null;
let selectedLanguage = 'bengali'; // default

// Primary model
const DEFAULT_MODEL = 'SmolLM2-360M-Instruct-q4f16_1-MLC';

// Fallback models — ছোট থেকে বড় order
const FALLBACK_MODELS = [
  // Qwen সিরিজ SmolLM2-এর চেয়ে বেশি ভাষা (বাংলাসহ) বোঝে এবং instruction ভালো follow করে —
  // তাই বড়/সক্ষম মডেলটাকে প্রথমে চেষ্টা করানো হচ্ছে, ছোটগুলো শুধু download/RAM fail-এ fallback
  'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  'Qwen3-0.6B-q4f32_1-MLC',
  'SmolLM2-360M-Instruct-q4f16_1-MLC'
];

// Language-specific system prompts
const LANGUAGE_PROMPTS = {
  bengali: `আপনি একজন সহায়ক। শিক্ষার্থী-বান্ধব, সহজ ব্যাখ্যা দিন।
সব উত্তর বাংলায় লিখুন।`,
  
  english: `You are a helpful assistant. Provide student-friendly, clear explanations.
Answer in complete English sentences.`,
  
  hindi: `आप एक सहायक हैं। छात्र-अनुकूल, सरल व्याख्या दें।
सभी उत्तर हिंदी में लिखें।`,
  
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

async function loadEngine(modelId = DEFAULT_MODEL, onProgress) {
  if (!isSupported()) {
    throw new Error(
      'এই ডিভাইসে Local AI চলবে না। Chrome বা Edge (desktop) দিয়ে চেষ্টা করুন — WebGPU দরকার।'
    );
  }
  
  // model change hole purono engine fela dei
  if (enginePromise && currentModelId !== modelId) {
    enginePromise = null;
  }
  
  // যদি আগেই loaded, রিটার্ন করো
  if (enginePromise && currentModelId === modelId) {
    return enginePromise;
  }
  
  if (!enginePromise) {
    enginePromise = (async () => {
      // Fallback logic: models sequence এ চেষ্টা করবে
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
          // এই model fail, পরবর্তী চেষ্টা করবে
          if (onProgress) onProgress(`${model.split('-')[0]} failed, trying next model...`, 0);
          continue;
          
        } catch (err) {
          if (onProgress) onProgress(`${model} error, trying next...`, 0);
          continue;
        }
      }
      
      // সব model fail
      enginePromise = null;
      throw new Error('সব models fail। Internet connection check করুন। Network stable নয়।');
      
    })();
  }
  
  return enginePromise;
}

async function generateReply(systemPrompt, history, userMessage, onProgress) {
  const engine = await loadEngine(DEFAULT_MODEL, onProgress);
  
  // Language-specific prompt
  const langPrompt = LANGUAGE_PROMPTS[selectedLanguage] || LANGUAGE_PROMPTS.english;
  
const messages = [];
  // WebLLM শুধু একটা system message allow করে, সেটাও অবশ্যই messages[0]-এ থাকতে হবে —
  // আগে langPrompt আর systemPrompt আলাদা দুইটা 'system' role message হিসেবে পুশ হতো,
  // দ্বিতীয়টা (index 1) SystemMessageOrderError থ্রো করত। এখন দুইটাকে একটাই system
  // message-এ merge করা হচ্ছে।
  const combinedSystemPrompt = systemPrompt ? (langPrompt + '\n\n' + systemPrompt) : langPrompt;
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

  const text = reply?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Local AI কোনো উত্তর দিতে পারেনি। আবার চেষ্টা করুন।');
  return text;
}

// Language change
function setLanguage(lang) {
  if (LANGUAGE_PROMPTS[lang]) {
    selectedLanguage = lang;
    return true;
  }
  return false;
}

// Model list দেখার জন্য
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

// Current model জানার জন্য
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
  SUPPORTED_LANGUAGES: Object.keys(LANGUAGE_PROMPTS),
  FALLBACK_MODELS
};
