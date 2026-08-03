"""
core/engine.py — model load + inference wrapper around llama-cpp-python.

Reads settings from config/config.yaml and exposes AssistantEngine with
generate(), generate_stream(), chat(), and reset_context().

এই ফাইল আপডেট: এখন persona.yaml (core/persona_loader.py) থেকে system prompt
স্বয়ংক্রিয়ভাবে লোড হয়, আর memory/store.py-এর Store দিলে প্রতিটা কথোপকথন
SQLite-এ persist হয় (রিস্টার্ট করলেও context হারায় না) — আগে এই দুইটাই কোডে
তৈরি ছিল কিন্তু engine-এর সাথে যুক্ত ছিল না।
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterator, Optional

import yaml
from llama_cpp import Llama

from .conversation import Conversation
from .persona_loader import DEFAULT_PERSONA_PATH, load_persona

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "config.yaml"
DEFAULT_SYSTEM_PROMPT = "You are a helpful, concise local assistant."

# Reserve this many tokens of the context window for the model's reply.
# Keeps truncation from cutting it too close and triggering llama.cpp errors.
DEFAULT_MAX_NEW_TOKENS = 512


class AssistantEngine:
    """Wraps a llama-cpp-python Llama instance with chat-style context management.

    Two ways to hold conversation state:
      1. No `store` given: internal `self.conversation` (Conversation object)
         holds a single running conversation in memory only. Use generate()/
         generate_stream() for this — same as before.
      2. `store` given (a memory.store.Store instance): each call to chat()
         reads/writes that conversation's turns from/to SQLite by
         conversation_id, so history survives process restarts and you can
         juggle multiple conversations by id.
    """

    def __init__(
        self,
        config_path: str | Path = DEFAULT_CONFIG_PATH,
        model_path: str | Path | None = None,
        system_prompt: str | None = None,
        persona_path: str | Path = DEFAULT_PERSONA_PATH,
        store: Any = None,
        max_new_tokens: int = DEFAULT_MAX_NEW_TOKENS,
    ) -> None:
        self.config = self._load_config(config_path)
        model_cfg = self.config.get("model", {})

        if model_path is not None:
            # সরাসরি দেওয়া path — config.yaml আর resolve করার দরকার নেই
            # (test/CLI থেকে override করার জন্য, যেমন: AssistantEngine(model_path=..., store=store))
            resolved_model_path = Path(model_path)
        else:
            resolved_model_path = self._resolve_model_path(model_cfg.get("path"), config_path)

        if not resolved_model_path.exists():
            raise FileNotFoundError(
                f"Model file not found at {resolved_model_path}. "
                "Run download_model.sh first, or fix model.path in config.yaml."
            )

        self.context_size: int = int(model_cfg.get("context_size", 4096))
        self.temperature: float = float(model_cfg.get("temperature", 0.7))
        self.threads: int = int(model_cfg.get("threads", os.cpu_count() or 4))
        self.max_new_tokens = max_new_tokens
        self.store = store

        self.llm = Llama(
            model_path=str(resolved_model_path),
            n_ctx=self.context_size,
            n_threads=self.threads,
            verbose=False,
        )

        # persona.yaml থেকে system prompt বানাই, না দেওয়া থাকলে explicit override ব্যবহার করি,
        # persona.yaml না পাওয়া গেলে fallback হিসেবে DEFAULT_SYSTEM_PROMPT
        if system_prompt is not None:
            self.system_prompt = system_prompt
            self.persona = None
        else:
            try:
                self.persona = load_persona(persona_path)
                self.system_prompt = self.persona.system_prompt
            except (FileNotFoundError, ValueError):
                self.persona = None
                self.system_prompt = DEFAULT_SYSTEM_PROMPT

        self.conversation = Conversation(
            system_prompt=self.system_prompt,
            count_tokens=self._count_tokens,
            context_size=self.context_size,
            reserved_for_reply=self.max_new_tokens,
        )

    # ------------------------------------------------------------------
    # config helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _load_config(config_path: str | Path) -> dict[str, Any]:
        path = Path(config_path)
        if not path.exists():
            raise FileNotFoundError(f"config.yaml not found at {path}")
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}

    @staticmethod
    def _resolve_model_path(raw_path: Optional[str], config_path: str | Path) -> Path:
        if not raw_path:
            raise ValueError("model.path missing in config.yaml")
        p = Path(raw_path)
        if p.is_absolute():
            return p
        # Relative paths in config.yaml are relative to the project root,
        # i.e. the directory config.yaml lives in.
        project_root = Path(config_path).resolve().parent.parent
        return (project_root / p).resolve()

    # ------------------------------------------------------------------
    # context management
    # ------------------------------------------------------------------

    def _count_tokens(self, text: str) -> int:
        return len(self.llm.tokenize(text.encode("utf-8"), add_bos=False))

    def set_system_prompt(self, prompt: str) -> None:
        """Used by persona_loader.inject_persona()/reload_persona() for hot-reload."""
        self.system_prompt = prompt
        self.conversation.system_prompt = prompt
        if self.conversation.messages and self.conversation.messages[0]["role"] == "system":
            self.conversation.messages[0]["content"] = prompt

    def reset_context(self) -> None:
        """Clear conversation history, keeping the system prompt."""
        self.conversation.reset()

    # ------------------------------------------------------------------
    # inference — in-memory single conversation (no store)
    # ------------------------------------------------------------------

    def generate(self, prompt: str) -> str:
        """Send prompt, return full completion as a string."""
        self.conversation.add_user(prompt)

        result = self.llm.create_chat_completion(
            messages=self.conversation.as_list(),
            temperature=self.temperature,
            max_tokens=self.max_new_tokens,
        )
        reply = result["choices"][0]["message"]["content"]
        self.conversation.add_assistant(reply)
        return reply

    def generate_stream(self, prompt: str) -> Iterator[str]:
        """Send prompt, yield reply token-by-token as it's generated."""
        self.conversation.add_user(prompt)

        stream = self.llm.create_chat_completion(
            messages=self.conversation.as_list(),
            temperature=self.temperature,
            max_tokens=self.max_new_tokens,
            stream=True,
        )

        full_reply = []
        for chunk in stream:
            delta = chunk["choices"][0]["delta"]
            token = delta.get("content")
            if token:
                full_reply.append(token)
                yield token

        self.conversation.add_assistant("".join(full_reply))

    # ------------------------------------------------------------------
    # inference — persisted, multi-conversation (requires store)
    # ------------------------------------------------------------------

    def chat(self, conversation_id: str, prompt: str) -> str:
        """Persisted chat turn: reads/writes the given conversation_id's
        history via self.store (memory.store.Store), so it survives
        restarts and multiple conversations don't mix.

        Raises RuntimeError if no store was passed to __init__.
        """
        if self.store is None:
            raise RuntimeError(
                "AssistantEngine.chat() needs a store — pass store=Store(...) to "
                "__init__, or use generate()/generate_stream() for a single "
                "in-memory conversation instead."
            )

        self.store.add_message(conversation_id, "user", prompt)
        history = self.store.get_messages(conversation_id)

        messages = [{"role": "system", "content": self.system_prompt}]
        messages.extend({"role": m.role, "content": m.content} for m in history)

        result = self.llm.create_chat_completion(
            messages=messages,
            temperature=self.temperature,
            max_tokens=self.max_new_tokens,
        )
        reply = result["choices"][0]["message"]["content"]
        self.store.add_message(conversation_id, "assistant", reply)
        return reply
