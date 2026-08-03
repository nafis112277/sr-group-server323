"""
web_ui/app.py — minimal FastAPI web chat for local-ai-assistant.

Run (via Makefile):
    make run
    # then open http://127.0.0.1:8000

Or directly:
    .venv/bin/python -m uvicorn web_ui.app:app --host 127.0.0.1 --port 8000

The model loads once at startup (module import time) and is shared across
requests. Conversation history is persisted via memory/store.py (SQLite),
one browser session = one conversation_id (kept client-side in the page,
sent back with every request).

/api/generate — stateless endpoint used by an external backend (e.g. the
Node.js sr-group-server323 chatbot) that already manages its own system
prompt and conversation history. It bypasses persona.yaml and the SQLite
store entirely — the caller sends the full message list every time.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from core.engine import AssistantEngine
from memory.store import Store

app = FastAPI(title="local-ai-assistant")

# মডেল একবারই লোড হয় (app import হওয়ার সময়) — প্রতিটা request-এ না।
_store = Store()
_engine = AssistantEngine(store=_store)


class ChatRequest(BaseModel):
    message: str
    conversation_id: str | None = None


class ChatResponse(BaseModel):
    reply: str
    conversation_id: str


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    conversation_id = req.conversation_id
    if not conversation_id or not _store.conversation_exists(conversation_id):
        conversation_id = _store.create_conversation()

    reply = _engine.chat(conversation_id, req.message)
    return ChatResponse(reply=reply, conversation_id=conversation_id)


@app.post("/api/reset", response_model=ChatResponse)
def reset() -> ChatResponse:
    conversation_id = _store.create_conversation()
    return ChatResponse(reply="", conversation_id=conversation_id)


# ------------------------------------------------------------------
# /api/generate — externa Node.js backend (sr-group-server323) এর জন্য।
# এটা _engine.chat()/persona.yaml/SQLite store কিছুই ব্যবহার করে না —
# caller নিজেই system prompt + পুরো message history পাঠায়, এটা শুধু
# একবার model কল করে reply ফেরত দেয় (stateless, অন্য provider যেমন
# gemini/deepseek কাজ করে ঠিক সেভাবেই)।
# ------------------------------------------------------------------
class GenerateRequest(BaseModel):
    system: str
    messages: list[dict]  # [{"role": "user"/"assistant", "content": "..."}, ...]


class GenerateResponse(BaseModel):
    text: str


@app.post("/api/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest) -> GenerateResponse:
    messages = [{"role": "system", "content": req.system}]
    messages.extend({"role": m["role"], "content": m["content"]} for m in req.messages)

    result = _engine.llm.create_chat_completion(
        messages=messages,
        temperature=_engine.temperature,
        max_tokens=_engine.max_new_tokens,
    )
    text = result["choices"][0]["message"]["content"]
    return GenerateResponse(text=text)


_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>local-ai-assistant</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;background:#0d1117;color:#e6edf3;}
  h1{font-size:18px;}
  #log{border:1px solid #30363d;border-radius:8px;padding:12px;height:60vh;overflow-y:auto;margin-bottom:12px;background:#161b22;}
  .msg{margin-bottom:10px;line-height:1.5;white-space:pre-wrap;}
  .user{color:#79c0ff;}
  .bot{color:#e6edf3;}
  .label{font-weight:600;font-size:12px;text-transform:uppercase;color:#8b949e;display:block;margin-bottom:2px;}
  form{display:flex;gap:8px;}
  input{flex:1;padding:10px;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;}
  button{padding:10px 16px;border-radius:6px;border:none;background:#238636;color:#fff;cursor:pointer;}
  button:disabled{opacity:0.5;cursor:default;}
  #reset{background:#30363d;}
</style>
</head>
<body>
<h1>local-ai-assistant — fully offline, no API keys</h1>
<div id="log"></div>
<form id="form">
  <input id="input" placeholder="Type a question (subject or coding)..." autocomplete="off">
  <button id="send" type="submit">Send</button>
  <button id="reset" type="button">New chat</button>
</form>
<script>
let conversationId = null;
const log = document.getElementById('log');
const form = document.getElementById('form');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = role === 'user' ? 'you' : 'assistant';
  div.appendChild(label);
  div.appendChild(document.createTextNode(text));
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  addMsg('user', text);
  input.value = '';
  sendBtn.disabled = true;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message: text, conversation_id: conversationId}),
    });
    const data = await res.json();
    conversationId = data.conversation_id;
    addMsg('bot', data.reply);
  } catch (err) {
    addMsg('bot', 'Error: ' + err.message);
  }
  sendBtn.disabled = false;
  input.focus();
});

document.getElementById('reset').addEventListener('click', async () => {
  const res = await fetch('/api/reset', {method: 'POST'});
  const data = await res.json();
  conversationId = data.conversation_id;
  log.innerHTML = '';
});
</script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return _PAGE
