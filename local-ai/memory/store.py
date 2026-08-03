"""
memory/store.py — SQLite-backed persistence for local-ai-assistant.

Covers three things:
  1. conversations  — session metadata (id, title, timestamps)
  2. messages       — the turn-by-turn transcript of each conversation
  3. facts          — a flat key/value table for long-term memory
                      ("remember that my name is X", etc.)

Usage (see cli_chat.py for the full wiring):

    from memory.store import Store

    store = Store()                       # opens/creates data/memory.db
    session_id = store.create_conversation()
    store.add_message(session_id, "user", "hello")
    history = store.get_messages(session_id)

    store.set_fact("user_name", "Rafi")
    name = store.get_fact("user_name")

Design notes:
  - Every public method opens/uses a short-lived connection via
    sqlite3.connect(..., check_same_thread=False) so the Store instance is
    safe to share within a single-process CLI app. It is NOT designed for
    concurrent multi-process writers.
  - Timestamps are stored as ISO-8601 UTC strings so they sort correctly
    as text and are human-readable in the raw .db file.
  - Session ids are generated as "<UTC timestamp>-<4 hex chars>" so they're
    short enough to type on the CLI but still unique and roughly sortable.
"""

from __future__ import annotations

import secrets
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

SCHEMA_PATH = Path(__file__).parent / "schema.sql"
DEFAULT_DB_PATH = Path(__file__).parent.parent / "data" / "memory.db"


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_session_id() -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"{ts}-{secrets.token_hex(2)}"


@dataclass
class Message:
    id: int
    conversation_id: str
    role: str
    content: str
    created_at: str


@dataclass
class ConversationInfo:
    id: str
    title: Optional[str]
    created_at: str
    updated_at: str


class Store:
    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    # -- setup ------------------------------------------------------------

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    # -- conversations ------------------------------------------------------

    def create_conversation(self, title: Optional[str] = None) -> str:
        """Create a new conversation row and return its id."""
        session_id = _new_session_id()
        now = _utcnow()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO conversations (id, title, created_at, updated_at) "
                "VALUES (?, ?, ?, ?)",
                (session_id, title, now, now),
            )
        return session_id

    def conversation_exists(self, conversation_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
        return row is not None

    def touch_conversation(self, conversation_id: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (_utcnow(), conversation_id),
            )

    def set_conversation_title(self, conversation_id: str, title: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE conversations SET title = ? WHERE id = ?",
                (title, conversation_id),
            )

    def list_conversations(self, limit: int = 20) -> list[ConversationInfo]:
        """Most recently updated conversations first."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, title, created_at, updated_at FROM conversations "
                "ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [ConversationInfo(**dict(r)) for r in rows]

    def delete_conversation(self, conversation_id: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM conversations WHERE id = ?", (conversation_id,)
            )  # ON DELETE CASCADE removes its messages too

    # -- messages -------------------------------------------------------

    def add_message(self, conversation_id: str, role: str, content: str) -> int:
        """Append a message and bump the parent conversation's updated_at.
        Returns the new message id."""
        now = _utcnow()
        with self._connect() as conn:
            cur = conn.execute(
                "INSERT INTO messages (conversation_id, role, content, created_at) "
                "VALUES (?, ?, ?, ?)",
                (conversation_id, role, content, now),
            )
            conn.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now, conversation_id),
            )
            return cur.lastrowid

    def get_messages(self, conversation_id: str) -> list[Message]:
        """Full transcript in chronological order."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, conversation_id, role, content, created_at "
                "FROM messages WHERE conversation_id = ? ORDER BY id ASC",
                (conversation_id,),
            ).fetchall()
        return [Message(**dict(r)) for r in rows]

    # -- facts (long-term key/value memory) ------------------------------

    def set_fact(self, key: str, value: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO facts (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
                "updated_at = excluded.updated_at",
                (key, value, _utcnow()),
            )

    def get_fact(self, key: str) -> Optional[str]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT value FROM facts WHERE key = ?", (key,)
            ).fetchone()
        return row["value"] if row else None

    def get_all_facts(self) -> dict[str, str]:
        with self._connect() as conn:
            rows = conn.execute("SELECT key, value FROM facts ORDER BY key").fetchall()
        return {r["key"]: r["value"] for r in rows}

    def delete_fact(self, key: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM facts WHERE key = ?", (key,))
