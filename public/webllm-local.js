// public/webllm-local.js
//
// Local (offline) AI mode — chole student-er nijer browser-e, WebGPU diye.
// Kono server cost nai, kono API key lage na. Import kora hoy CDN theke
// (@mlc-ai/web-llm), tai index.html-e kono npm install lagbe na.
//
// Requirement: Chrome/Edge (desktop), WebGPU enabled. Phone/older browser-e
// chalbe na — সেই check ei file-ei kora hoy (isSupported()).

let enginePromise = null;
let currentModelId = null;

// Choto, fast model — quality ChatGPT/Gemini-er cheye onek kom, kintu
// student-level shohoj explanation-er jonno thik ache.
const DEFAULT_MODEL = 'TinyLlama-1.1B-Chat-v1.0-q4f32_1-MLC';

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
      const MAX_RETRIES = 3;
      let lastErr;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await engine.reload(modelId);
          return engine;
        } catch (err) {
          lastErr = err;
          if (onProgress) onProgress('Download attempt ' + attempt + ' failed, retrying...', 0);
          await new Promise((r) => setTimeout(r, 1500 * attempt));
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
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const m of history) {
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
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

window.LocalAI = { isSupported, loadEngine, generateReply };
