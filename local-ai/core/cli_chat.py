"""
core/cli_chat.py — terminal chat loop.

Run:
    python core/cli_chat.py

Commands:
    /reset   start a brand-new conversation (old one stays in memory/memory.db)
    /quit    exit

এই ভার্সন এখন memory/store.py-এর Store ব্যবহার করে — প্রতিটা মেসেজ SQLite-এ
সেভ হয়, তাই terminal বন্ধ করে আবার খুললেও গত কথোপকথন খুঁজে পাওয়া যায় (সবচেয়ে
সাম্প্রতিক conversation স্বয়ংক্রিয়ভাবে আবার চালু হয়)।
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.engine import AssistantEngine
from memory.store import Store


def main() -> None:
    print("[cli_chat] loading model (first run can take a while)...")
    store = Store()
    engine = AssistantEngine(store=store)

    # আগের কোনো conversation থাকলে সবচেয়ে সাম্প্রতিকটা আবার চালু করি, নাহলে নতুন বানাই
    existing = store.list_conversations(limit=1)
    if existing:
        conversation_id = existing[0].id
        print(f"[cli_chat] resuming conversation {conversation_id}")
    else:
        conversation_id = store.create_conversation()
        print(f"[cli_chat] new conversation {conversation_id}")

    print("[cli_chat] ready. Commands: /reset, /quit\n")

    while True:
        try:
            user_input = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n[cli_chat] bye.")
            break

        if not user_input:
            continue
        if user_input in ("/quit", "/exit"):
            print("[cli_chat] bye.")
            break
        if user_input == "/reset":
            conversation_id = store.create_conversation()
            print(f"[cli_chat] started fresh conversation {conversation_id}")
            continue

        try:
            reply = engine.chat(conversation_id, user_input)
            print(f"assistant> {reply}\n")
        except KeyboardInterrupt:
            print("\n[cli_chat] generation interrupted.")
            continue


if __name__ == "__main__":
    main()
