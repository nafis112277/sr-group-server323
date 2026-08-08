// public/webllm-local.js
//
// Local (offline) AI mode — WebGPU, multilingual support (Bengali, English, Hindi, etc)
// Phi-3.5-mini: Small, fast, multilingual. CDN download করা সহজ।

let enginePromise = null;
let currentModelId = null;
let selectedLanguage = 'bengali'; // default

// Phi-3.5-mini: Size ছোট, fast download, Bengali/English/Hindi সব ভালো।
const DEFAULT_MODEL = 'Phi-3.5-mini-instruct-q4f16_1-MLC';

// Language-specific system prompts
const LANGUAGE_PROMPTS = {
  bengali: `আপনি একজন সহায়ক। শিক্ষার্থী-বান্ধব, সহজ ব্যাখ্যা দিন।
সব উত্তর বাংলায় লিখুন — সম্পূর্ণ শব্দ, character-by-character নয়।
বাংলা ভাষা সঠিক রাখুন।`,
  
  english: `You are a helpful assistant. Provide student-friendly, clear explanations.
Answer in complete English sentences, not broken text.`,
  
  hindi: `आप एक सहायक हैं। छात्र-अनुकूल, सरल व्याख्या दें।
सभी उत्तर हिंदी में लिखें - पूर्ण शब्द, टूटे हुए टेक्स्ट नहीं।`,
  
  spanish: `Eres un asistente útil. Proporciona explicaciones claras y amigables para estudiantes.
Responde en español completo, no en texto fragmentado.`,
  
  french: `Vous êtes un assistant utile. Fournissez des explications claires et conviviales.
Répondez en français complet, pas en texte fragmenté.`,
  
  urdu: `آپ ایک معاون ہیں۔ طالب علم کے لیے دوست انہ وضاحت دیں۔
تمام جوابات اردو میں لکھیں - مکمل الفاظ، حروف-در-حروف نہیں۔`,
  
  portuguese: `Você é um assistente útil. Forneça explicações claras e amigáveis para estudantes.
Responda em português completo, não em texto fragmentado.`,
  
  japanese: `あなたはアシスタントです。学生向けの明確な説明を提供してください。
完全な日本語で答えてください。不完全なテキストではありません。`,
  
  korean: `당신은 도우미입니다. 학생 친화적이고 명확한 설명을 제공하세요.
완전한 한국어로 답변하세요. 깨진 텍스트가 아닙니다.`
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
      const MAX_RETRIES = 5; // বাড়িয়ে দিলাম retry count
      let lastErr;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await engine.reload(modelId);
          return engine;
        } catch (err) {
          lastErr = err;
          if (onProgress) onProgress('Download attempt ' + attempt + ' failed, retrying...', 0);
          await new Promise((r) => setTimeout(r, 3000 * attempt)); // বাড়িয়ে দিলাম wait time
        }
      }
      enginePromise = null;
      throw lastErr;
    })();
  }
  return enginePromise;
}

// systemPrompt: string
// history: [{ role: 'user'|'assistant', content: string }]  (age-er conversation, notun user message chhara)
// userMessage: string (এখন যা type kore pathacche)
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
    max_tokens: 600,
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
