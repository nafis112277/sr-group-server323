"""
core/persona_loader.py — load config/persona.yaml, build system prompt,
inject into AssistantEngine. Edit persona.yaml, not this file, for tone/rules change.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

DEFAULT_PERSONA_PATH = Path(__file__).resolve().parent.parent / "config" / "persona.yaml"


@dataclass
class GenerationDefaults:
    temperature: float = 0.7
    max_tokens: int = 1024
    top_p: float = 0.9


@dataclass
class Persona:
    """Parsed persona config, plus the compiled system prompt string."""

    name: str
    identity: str
    tone: dict[str, str] = field(default_factory=dict)
    rules: list[str] = field(default_factory=list)
    guardrails: list[dict[str, str]] = field(default_factory=list)
    memory: dict[str, Any] = field(default_factory=dict)
    generation_defaults: GenerationDefaults = field(default_factory=GenerationDefaults)
    system_prompt: str = ""

    def guardrail_response(self, trigger: str) -> str | None:
        """Return the soft-redirect line for a trigger, or None if not configured."""
        for g in self.guardrails:
            if g.get("trigger") == trigger:
                return g.get("response")
        return None


def _build_system_prompt(raw: dict[str, Any]) -> str:
    """Compose final system prompt text from raw yaml dict."""
    parts: list[str] = []

    identity = (raw.get("identity") or "").strip()
    if identity:
        parts.append(identity)

    tone = raw.get("tone") or {}
    if tone:
        tone_line = "Tone: " + ", ".join(f"{k}={v}" for k, v in tone.items()) + "."
        parts.append(tone_line)

    rules = raw.get("rules") or []
    if rules:
        parts.append("Rules:")
        parts.extend(f"- {r}" for r in rules)

    guardrails = raw.get("guardrails") or []
    if guardrails:
        parts.append("When a request matches one of these topics, respond in that spirit rather than a flat refusal:")
        for g in guardrails:
            trig = g.get("trigger", "unknown")
            resp = g.get("response", "")
            parts.append(f"- {trig}: {resp}")

    return "\n".join(parts)


def load_persona(path: str | Path = DEFAULT_PERSONA_PATH) -> Persona:
    """Read persona.yaml from disk and return a compiled Persona object.

    Raises FileNotFoundError if path missing, ValueError if yaml malformed
    or required fields absent — fail loud, don't silently run with a broken persona.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"persona config not found: {path}")

    with path.open("r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    if "identity" not in raw:
        raise ValueError(f"persona config missing required 'identity' field: {path}")

    gen_raw = raw.get("generation_defaults") or {}
    gen_defaults = GenerationDefaults(
        temperature=gen_raw.get("temperature", 0.7),
        max_tokens=gen_raw.get("max_tokens", 1024),
        top_p=gen_raw.get("top_p", 0.9),
    )

    persona = Persona(
        name=raw.get("name", "Assistant"),
        identity=raw["identity"].strip(),
        tone=raw.get("tone", {}),
        rules=raw.get("rules", []),
        guardrails=raw.get("guardrails", []),
        memory=raw.get("memory", {}),
        generation_defaults=gen_defaults,
        system_prompt=_build_system_prompt(raw),
    )

    logger.info("Loaded persona '%s' from %s (%d rules)", persona.name, path, len(persona.rules))
    return persona


def _append_facts_block(system_prompt: str, facts: dict[str, str], max_items: int) -> str:
    """Append a 'known facts about the user' block, capped at max_items."""
    if not facts:
        return system_prompt
    items = list(facts.items())[:max_items]
    lines = ["Known facts about the user (from long-term memory):"]
    lines.extend(f"- {k}: {v}" for k, v in items)
    return system_prompt + "\n\n" + "\n".join(lines)


def inject_persona(engine: Any, path: str | Path = DEFAULT_PERSONA_PATH, store: Any = None) -> Persona:
    """Load persona and set it on an AssistantEngine instance.

    Expects `engine` to expose either:
      - engine.set_system_prompt(str), or
      - a settable engine.system_prompt attribute
    Also sets engine.persona = Persona for rule/guardrail access elsewhere,
    and applies generation_defaults onto engine.generation_config if present.

    If `store` is given (a memory.store.Store instance) and persona.memory.enabled
    is true, facts from store.get_all_facts() are appended to the system prompt,
    capped at persona.memory.max_context_items. Pass store=None to skip memory
    entirely (e.g. engine has no Store wired yet).
    """
    persona = load_persona(path)

    system_prompt = persona.system_prompt
    if store is not None and persona.memory.get("enabled", True):
        max_items = persona.memory.get("max_context_items", 20)
        try:
            facts = store.get_all_facts()
        except Exception:
            logger.exception("failed to load facts from store, continuing without them")
            facts = {}
        system_prompt = _append_facts_block(system_prompt, facts, max_items)
    persona.system_prompt = system_prompt

    if hasattr(engine, "set_system_prompt"):
        engine.set_system_prompt(persona.system_prompt)
    else:
        engine.system_prompt = persona.system_prompt

    engine.persona = persona

    if hasattr(engine, "generation_config"):
        engine.generation_config.update(
            {
                "temperature": persona.generation_defaults.temperature,
                "max_tokens": persona.generation_defaults.max_tokens,
                "top_p": persona.generation_defaults.top_p,
            }
        )

    return persona


def reload_persona(engine: Any, path: str | Path = DEFAULT_PERSONA_PATH, store: Any = None) -> Persona:
    """Hot-reload persona.yaml onto a running engine (e.g. after user edits it,
    or after new facts get set_fact()'d into the store mid-session)."""
    return inject_persona(engine, path, store=store)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    p = load_persona()
    print(p.system_prompt)
