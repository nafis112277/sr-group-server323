// File: routes/ai.js
// Add this to your sr-group-server backend
// No external API keys needed - uses Anthropic API internally

const express = require('express');
const router = express.Router();

// In-memory chat history (optional - use MongoDB if you want persistence)
const chatSessions = new Map();

/**
 * POST /api/ai/chat
 * Self-hosted AI endpoint without exposing API keys
 * 
 * Request body:
 * {
 *   "prompt": "user question here",
 *   "sessionId": "optional - for multi-turn conversations"
 * }
 * 
 * Response:
 * {
 *   "response": "AI answer here",
 *   "sessionId": "conversation session ID"
 * }
 */
router.post('/chat', async (req, res) => {
    try {
        const { prompt, sessionId } = req.body;

        // Validate input
        if (!prompt || prompt.trim().length === 0) {
            return res.status(400).json({
                error: 'Prompt is required'
            });
        }

        // Get or create session
        const id = sessionId || `session-${Date.now()}`;
        
        if (!chatSessions.has(id)) {
            chatSessions.set(id, []);
        }

        const history = chatSessions.get(id);

        // Build messages with history
        const messages = [
            ...history,
            { role: 'user', content: prompt }
        ];

        // Call Anthropic API (backend only - no client exposure)
        const response = await callAnthropicAPI(messages);

        // Store in history
        history.push({ role: 'user', content: prompt });
        history.push({ role: 'assistant', content: response });

        // Keep history reasonable size (last 20 messages)
        if (history.length > 20) {
            history.shift();
            history.shift();
        }

        res.json({
            response: response,
            sessionId: id
        });

    } catch (error) {
        console.error('AI Chat Error:', error);
        res.status(500).json({
            error: 'Failed to process request',
            message: error.message
        });
    }
});

/**
 * Call Anthropic API with messages
 * API key stored safely on backend only
 */
async function callAnthropicAPI(messages) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY not configured on server');
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: 'claude-opus-4-1', // Or use claude-sonnet-4 for speed
            max_tokens: 1024,
            system: `আপনি SR Group Assistant। সবসময় বাংলায় উত্তর দিন যদি প্রশ্ন বাংলায় হয়। বন্ধুত্বপূর্ণ, সাহায্যকর এবং পেশাদার থাকুন।`,
            messages: messages
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Anthropic API error: ${error.error?.message || 'Unknown error'}`);
    }

    const data = await response.json();
    return data.content[0].text;
}

// Optional: Clear old sessions (run periodically)
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, messages] of chatSessions.entries()) {
        // Remove sessions inactive for 1 hour
        if (messages.length === 0 || (now - parseInt(sessionId.split('-')[1])) > 3600000) {
            chatSessions.delete(sessionId);
        }
    }
}, 3600000); // Run every hour

module.exports = router;
