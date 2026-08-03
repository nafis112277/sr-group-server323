"""
tests/test_phase1.py — Phase 1 integration checks for local-ai-assistant.

Covers:
  1. test_model_loads              — GGUF model path from config loads via llama-cpp-python
  2. test_conversation_persists_across_restart — SQLite Store survives a fresh Store() instance
  3. test_persona_loads_correctly  — config/persona.yaml parses and injects into an engine
  4. test_full_chat_exchange       — one full user->assistant turn through cli_chat

NOTE on test 1 and 4:
  - test_model_loads needs an actual .gguf file on disk (config/config.yaml ->
    model.path, or MODEL_PATH env var). It's SKIPPED, not failed, if no model
    file is found — CI/fresh clones won't have a 9GB model downloaded.
  - test_full_chat_exchange imports `cli_chat`, which was NOT attached to this
    task. It's written against an assumed interface (see ASSUMED INTERFACE
    below) and SKIPPED with a clear reason if that interface doesn't match
    your actual cli_chat.py. Send cli_chat.py to get this test tightened to
    the real API instead of the assumed one.

ASSUMED INTERFACE (cli_chat.py):
    from cli_chat import AssistantEngine
    engine = AssistantEngine(model_path=..., store=store)
    reply = engine.chat(conversation_id, "hello")   # -> str

Run: pytest tests/test_phase1.py -v
"""

from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from memory.store import Store  # noqa: E402
from core.persona_loader import load_persona, inject_persona  # noqa: E402

PERSONA_PATH = PROJECT_ROOT / "config" / "persona.yaml"


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def tmp_db_path(tmp_path):
    return tmp_path / "memory.db"


@pytest.fixture()
def store(tmp_db_path):
    return Store(db_path=tmp_db_path)


def _find_model_path() -> Path | None:
    """Best-effort model path discovery: env var, then config/config.yaml, then models/ dir."""
    env_path = os.environ.get("MODEL_PATH")
    if env_path and Path(env_path).exists():
        return Path(env_path)

    config_yaml = PROJECT_ROOT / "config" / "config.yaml"
    if config_yaml.exists():
        try:
            import yaml

            with config_yaml.open(encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}
            path = cfg.get("model", {}).get("path")
            if path and Path(path).exists():
                return Path(path)
        except Exception:
            pass

    models_dir = PROJECT_ROOT / "models"
    if models_dir.exists():
        ggufs = list(models_dir.glob("*.gguf"))
        if ggufs:
            return ggufs[0]

    return None


# ---------------------------------------------------------------------------
# 1. model loads
# ---------------------------------------------------------------------------

def test_model_loads():
    model_path = _find_model_path()
    if model_path is None:
        pytest.skip(
            "no .gguf model found (checked $MODEL_PATH, config/config.yaml "
            "model.path, models/*.gguf) — run download_model.sh first"
        )

    try:
        from llama_cpp import Llama
    except ImportError:
        pytest.skip("llama-cpp-python not installed — run setup_venv.sh")

    llm = Llama(model_path=str(model_path), n_ctx=512, n_threads=2, verbose=False)
    out = llm("Say OK.", max_tokens=8)
    assert out["choices"][0]["text"] is not None


# ---------------------------------------------------------------------------
# 2. conversation persists across restart
# ---------------------------------------------------------------------------

def test_conversation_persists_across_restart(tmp_db_path):
    # "restart" 1 — write
    store_a = Store(db_path=tmp_db_path)
    conv_id = store_a.create_conversation(title="phase1 test")
    store_a.add_message(conv_id, "user", "hello")
    store_a.add_message(conv_id, "assistant", "hi there")
    store_a.set_fact("user_name", "Rafi")

    # "restart" 2 — fresh Store instance, same db file on disk
    store_b = Store(db_path=tmp_db_path)

    assert store_b.conversation_exists(conv_id)

    messages = store_b.get_messages(conv_id)
    assert [m.role for m in messages] == ["user", "assistant"]
    assert messages[0].content == "hello"
    assert messages[1].content == "hi there"

    assert store_b.get_fact("user_name") == "Rafi"

    convs = store_b.list_conversations()
    assert any(c.id == conv_id for c in convs)


# ---------------------------------------------------------------------------
# 3. persona loads correctly
# ---------------------------------------------------------------------------

def test_persona_loads_correctly():
    assert PERSONA_PATH.exists(), f"missing {PERSONA_PATH}"

    persona = load_persona(PERSONA_PATH)
    assert persona.name
    assert persona.identity
    assert len(persona.rules) > 0
    assert "helpful" in persona.system_prompt.lower() or "assistant" in persona.system_prompt.lower()


def test_persona_injects_into_engine_and_picks_up_facts(store):
    store.set_fact("favorite_editor", "vim")

    class FakeEngine:
        pass

    engine = FakeEngine()
    persona = inject_persona(engine, PERSONA_PATH, store=store)

    assert engine.system_prompt == persona.system_prompt
    assert "favorite_editor: vim" in engine.system_prompt
    assert engine.persona is persona


# ---------------------------------------------------------------------------
# 4. full chat exchange (through cli_chat, if present)
# ---------------------------------------------------------------------------

def test_full_chat_exchange(store, tmp_db_path):
    try:
        cli_chat = importlib.import_module("cli_chat")
    except ImportError:
        pytest.skip("cli_chat.py not found on PROJECT_ROOT — not part of this task's attachments")

    if not hasattr(cli_chat, "AssistantEngine"):
        pytest.skip(
            "cli_chat.py found but has no AssistantEngine class — "
            "test_phase1 was written against an assumed interface, "
            "send cli_chat.py to get this test matched to the real one"
        )

    model_path = _find_model_path()
    if model_path is None:
        pytest.skip("no .gguf model found — needed for a real chat exchange")

    engine = cli_chat.AssistantEngine(model_path=str(model_path), store=store)
    conv_id = store.create_conversation()

    reply = engine.chat(conv_id, "Say the single word: OK")

    assert isinstance(reply, str)
    assert len(reply.strip()) > 0

    # exchange should be persisted
    messages = store.get_messages(conv_id)
    roles = [m.role for m in messages]
    assert "user" in roles and "assistant" in roles
