// public/webllm-local.js
//
// Local (offline) AI mode — WebGPU, multilingual support (Bengali, English, Hindi, etc)
// SmolLM2-360M: সবচেয়ে ছোট, ১৫০MB, super fast download

let enginePromise = null;
let currentModelId = null;
let selectedLanguage = 'bengali'; // default

// SmolLM2-360M: সবচেয়ে ছোট model। ১५०MB, network এ সহজ।
const DEFAULT_MODEL = 'SmolLM2-360M-Instruct-q4f16_1-MLC';

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
  currentModelId = modelId;
  if (!enginePromise) {
    enginePromise = (async () => {
      const webllm = await import('https://esm.run/@mlc-ai/web-llm');
      const engine = new webllm.MLCEngine();
      engine.setInitProgressCallback((report) => {
        if (onProgress) onProgress(report.text, report.progress);
      });
      const MAX_RETRIES = 5;
      let lastErr;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await engine.reload(modelId);
          return engine;
        } catch (err) {
          lastErr = err;
          if (onProgress) onProgress('Download attempt ' + attempt + ' failed, retrying...', 0);
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
      enginePromise = null;
      throw lastErr;
    })();
  }
  return enginePromise;
}

async function generateReply(systemPrompt, history, userMessage, onProgress) {
  const engine = await loadEngine(DEFAULT_MODEL, onProgress);
  
  // Language-specific prompt add করছি
  const langPrompt = LANGUAGE_PROMPTS[selectedLanguage] || LANGUAGE_PROMPTS.english;
  
  const messages = [];
  messages.push({ role: 'system', content: langPrompt });
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  
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

// Language change করার জন্য
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

if (isSupported()) {
  loadEngine().catch(() => { enginePromise = null; });
}

window.LocalAI = { 
  isSupported, 
  loadEngine, 
  generateReply, 
  setLanguage,
  SUPPORTED_LANGUAGES: Object.keys(LANGUAGE_PROMPTS)
};
