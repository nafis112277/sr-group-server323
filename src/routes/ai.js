import express from 'express';
import { callAI } from '../ai.js';

const router = express.Router();
const chatSessions = new Map();

/**
 * POST /api/ai/chat
 * AI chat endpoint - uses local provider by default
 */
router.post('/chat', async (req, res) => {
    try {
        const { prompt, sessionId, forceProvider = 'local' } = req.body;

        if (!prompt || prompt.trim().length === 0) {
            return res.status(400).json({ error: 'Prompt required' });
        }

        const id = sessionId || `session-${Date.now()}`;
        
        if (!chatSessions.has(id)) {
            chatSessions.set(id, []);
        }

        const history = chatSessions.get(id);
        const messages = [...history, { role: 'user', content: prompt }];

        const systemPrompt = 'আপনি SR Group Assistant। বাংলায় সাহায্যকর উত্তর দিন।';
        const result = await callAI(systemPrompt, messages, { forceProvider });

        if (!result.ok) {
            return res.status(500).json({ error: result.error });
        }

        history.push({ role: 'user', content: prompt });
        history.push({ role: 'assistant', content: result.response });

        if (history.length > 20) {
            history.shift();
            history.shift();
        }

        res.json({ 
            response: result.response, 
            sessionId: id, 
            provider: forceProvider 
        });

    } catch (error) {
        console.error('AI Chat Error:', error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
