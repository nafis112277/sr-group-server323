"""
core/conversation.py — multi-turn conversation state: system prompt,
message history, token counting, automatic trimming.

No llama-cpp dependency here — token counting is delegated to a
caller-supplied function (normally the loaded model's tokenizer), so
this module stays reusable/testable on its own.
"""

from __future__ import annotations

from typing import Callable

Message = dict[str, str]  # {"role": "system"|"user"|"assistant", "content": str}


class Conversation:
    """Holds a system prompt + turn history. Trims oldest non-system
    turns first whenever the token budget is exceeded."""

    def __init__(
        self,
        system_prompt: str,
        count_tokens: Callable[[str], int],
        context_size: int,
        reserved_for_reply: int = 512,
        per_message_overhead: int = 4,
    ) -> None:
        self.system_prompt = system_prompt
        self._count_tokens = count_tokens
        self.context_size = context_size
        self.reserved_for_reply = reserved_for_reply
        self.per_message_overhead = per_message_overhead
        self.messages: list[Message] = [{"role": "system", "content": system_prompt}]

    # ------------------------------------------------------------------

    def add_user(self, content: str) -> None:
        self.messages.append({"role": "user", "content": content})
        self._trim()

    def add_assistant(self, content: str) -> None:
        self.messages.append({"role": "assistant", "content": content})
        self._trim()

    def total_tokens(self) -> int:
        return sum(
            self._count_tokens(m["content"]) + self.per_message_overhead
            for m in self.messages
        )

    def reset(self) -> None:
        self.messages = [{"role": "system", "content": self.system_prompt}]

    def as_list(self) -> list[Message]:
        return self.messages

    # ------------------------------------------------------------------

    def _trim(self) -> None:
        """Drop oldest non-system turns until under budget. System
        message (index 0) is never dropped."""
        budget = self.context_size - self.reserved_for_reply
        while self.total_tokens() > budget and len(self.messages) > 1:
            del self.messages[1]
