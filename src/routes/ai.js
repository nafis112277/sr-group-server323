// routes/ai.js
//
// AI provider-er obostha dekhar ebong test korar jonno route.
// - GET  /api/ai/status        -> public: kon provider-gulo configured/ready
// - POST /api/ai/test          -> admin-only: ekta nirdishto provider force
//                                  kore ekta choto test message pathiye reply
//                                  thik ashche kina check kora
//
// NOTE: admin auth middleware ekhane placeholder hishebe rakha hoyeche.
// tomar routes/admin.js e je auth check use hoy, seta ekhane bosiye dao
// (jemon session/cookie/passcode check), na hole /api/ai/test route ta
// keu ekhon jekono API key "burn" kore ferate parbe.

import express from 'express';
import { configuredProviders, getAllProvidersStatus, isProviderAvailable, callAI } from '../ai.js';

const router = express.Router();

// TODO: routes/admin.js-er real middleware diye replace koro.
// Ekhon shudhu ekta shohoj placeholder — kono actual protection nai.
function requireAdmin(req, res, next) {
  // Example: req.headers['x-admin-passcode'] check kore admin_auth table-er
  // shathe milie dekhte paro (jemon routes/admin.js e nishchoi ache).
  next();
}

// Kon kon provider order-e configured ache, ebong ei muhurte kon-guloi
// key diye ready — dutoi return kore. Frontend/admin dashboard e
// "AI ready: gemini → groq → local" emon dekhanor jonno kaje lagbe.
router.get('/status', async (req, res) => {
  try {
    const order = configuredProviders();
    const allStatus = getAllProvidersStatus();
    const readyOrder = order.filter((name) => allStatus[name]);

    res.json({
      ok: true,
      order,
      readyOrder,
      providers: allStatus,
    });
  } catch (err) {
    console.error('[AI Routes] /status error:', err.message);
    res.status(500).json({ ok: false, error: 'Could not fetch provider status.' });
  }
});

// Admin panel theke ekta nirdishto provider test korar jonno — jemon
// "Groq thik chalche kina check koro" button click korle ei route hit hobe.
// body: { provider: 'groq', message?: 'hello' }
router.post('/test', requireAdmin, async (req, res) => {
  try {
    const { provider, message } = req.body || {};

    if (!provider) {
      return res.status(400).json({ ok: false, error: 'provider field is required.' });
    }

    if (!isProviderAvailable(provider)) {
      return res.status(400).json({
        ok: false,
        error: `"${provider}" ei provider order-e nai ba configured na. Configured providers: ${configuredProviders().join(', ')}`,
      });
    }

    const testMessage = message || 'Bolo to, tumi thik moto shara ditecho? Ek line e reply dao.';
    const systemPrompt = 'Tumi ekta test message peyecho. Shudhu ek line e shohoj kore reply dao.';
    const history = [{ role: 'user', content: testMessage }];

    const result = await callAI(systemPrompt, history, { forceProvider: provider });

    if (!result.ok) {
      return res.status(502).json({ ok: false, provider, error: result.error });
    }

    res.json({ ok: true, provider: result.provider || provider, reply: result.text });
  } catch (err) {
    console.error('[AI Routes] /test error:', err.message);
    res.status(500).json({ ok: false, error: 'Test request failed.' });
  }
});

export default router;
