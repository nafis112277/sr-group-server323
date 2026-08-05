// providers/local.js
//
// Ei provider kono external API/key chara chole — Node.js process-er bhetorei
// ekta chhoto model (transformers.js diye) load kore text generate kore.
// Uddeshyo: gemini/openai/anthropic/groq/deepseek shobar free quota shesh hoye
// gele, ei ta last-resort fallback hishebe kaj kore jate client kokhono
// "shob provider fail" error na dekhe.
//
// SETUP (project root-e run koro):
//   npm install @xenova/transformers
//
// NOTE:
// - Prothom call-e model download hoy (~300-500MB), tai first request slow hobe.
//   Download hoye gele HuggingFace cache (default: node_modules/.cache ba
//   os tmp dir) e save thake, porer call-gulo fast.
// - Render-er free/basic tier-e RAM kom (512MB-1GB) thake. Model choto rakha
//   hoyeche (Qwen1.5-0.5B-Chat) jate fit kore, kintu tao out-of-memory hote
//   pare. Emon hole env var LOCAL_MODEL diye aro choto model try korte paro,
//   ba Render-e plan upgrade korte hobe.
// - Quality Gemini/GPT-er tulonay onek kom — eta shudhu "kichu na paoyar
//   cheye kichu paoya bhalo" — ekta emergency fallback, primary provider na.

import { pipeline } from '@xenova/transformers';

const LOCAL_MODEL = process.env.LOCAL_MODEL || 'Xenova/Qwen1.5-0.5B-Chat';
const MAX_NEW_TOKENS = 400; // choto model, beshi token dile onek slow hoye jay

// Model ekbari load kore memory-te rekhe dei (singleton), pratibar call-e
// notun kore load korle proti request-e onek shomoy lagbe.
let generatorPromise = null;
function getGenerator() {
  if (!generatorPromise) {
    console.log(`[Local] Loading local model "${LOCAL_MODEL}" (first time may take a while)...`);
    generatorPromise = pipeline('text-generation', LOCAL_MODEL).then((gen) => {
      console.log('[Local] Model loaded and ready.');
      return gen;
    });
  }
  return generatorPromise;
}

// history-ke Qwen chat-template-e convert kore — role: 'user'/'assistant'
function buildChatMessages(systemPrompt, history) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  for (const m of history) {
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || '',
    });
  }
  return messages;
}

export async function callLocal(systemPrompt, history) {
  try {
    const generator = await getGenerator();
    const messages = buildChatMessages(systemPrompt, history);

    const output = await generator(messages, {
      max_new_tokens: MAX_NEW_TOKENS,
      temperature: 0.7,
      do_sample: true,
      return_full_text: false,
    });

    // transformers.js chat-pipeline shadharonoto emon shape return kore:
    // [{ generated_text: [...messages..., { role: 'assistant', content: '...' }] }]
    let text = '';
    const generated = output && output[0] && output[0].generated_text;
    if (Array.isArray(generated)) {
      const last = generated[generated.length - 1];
      text = (last && last.content) || '';
    } else if (typeof generated === 'string') {
      text = generated;
    }

    text = (text || '').trim();

    if (!text) {
      return { ok: false, error: 'Local model did not return a reply.' };
    }

    return { ok: true, text, images: null, provider: 'local' };
  } catch (err) {
    console.error('[Local] Error running local model:', err.message);
    return { ok: false, error: `Local model failed: ${err.message}` };
  }
}
