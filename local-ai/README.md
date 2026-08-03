# local-ai-assistant (StudyMate)

Pura offline, kono API key chara চলা AI assistant — science, arts, ar commerce
students-der subject question ar coding help-er jonno. Kono cloud API
(OpenAI/DeepSeek/Gemini) lage na, sob kichu ekta local quantized model diye
নিজের machine-e/server-e run hoy.

## Goal

Ekta halka, computer/server-e local-e chalanor moto AI, jeta:
- Science/Math/History/Economics/Accounting-er moto subject-e question-er
  ans diye,
- Basic-to-medium coding (Python/C/C++/Java/JS/HTML-CSS) korte pare,
- Internet ba API key chara-i chole (offline, private),
- Total footprint choto rakhar jonno ekta 1.5B parameter model (~1GB,
  Q4_K_M quantized) use kore — 14B/70B-er moto deep na, kintu light
  ar fast.

## Key Features

- [x] Fully local inference (llama.cpp + GGUF model, no API key)
- [x] Persona/system-prompt configurable via `config/persona.yaml` (no code touch)
- [x] Conversation history persists in SQLite (`memory/store.py`) — restart korle
      o context thake
- [x] CLI chat (`core/cli_chat.py`) ar simple web chat UI (`web_ui/app.py`)
- [x] CPU-only, GPU lage na

## Architecture

```
User (CLI বা browser)
        │
        ▼
core/cli_chat.py  বা  web_ui/app.py
        │
        ▼
core/engine.py (AssistantEngine)
   ├── core/persona_loader.py  → persona.yaml থেকে system prompt বানায়
   ├── core/conversation.py    → in-memory single conversation (store ছাড়া মোডে)
   ├── memory/store.py         → SQLite: conversations/messages/facts persist
   └── llama_cpp.Llama          → আসল model inference (GGUF ফাইল)
```

## Project Structure

```
local-ai-assistant/
├── core/          # engine, persona loader, conversation state, CLI chat
├── memory/        # SQLite store (conversations/messages/facts)
├── memory_rag/    # (placeholder — future vector-search RAG, খালি এখন)
├── tools/         # (placeholder — future agent tools, খালি এখন)
├── web_ui/        # FastAPI ওয়েব চ্যাট (app.py)
├── tests/         # pytest tests
├── config/        # config.yaml (model settings), persona.yaml (identity/rules)
├── models/        # download_model.sh এর পর এখানে .gguf ফাইল থাকবে (git-ignored)
├── data/          # SQLite memory.db (auto-created)
├── check_system.sh
├── download_model.sh
├── setup_venv.sh
├── requirements.txt
└── Makefile
```

## System Requirements

- Python 3.10+
- RAM: কমপক্ষে 4GB ফাঁকা (model file ~1GB + runtime overhead)
- Storage: কমপক্ষে ~3GB ফাঁকা (model + venv + data)
- CPU: যেকোনো modern multi-core CPU (GPU লাগে না)

চেক করতে: `bash check_system.sh`

## Installation

```bash
# ১. venv বানাও + dependencies ইনস্টল করো
bash setup_venv.sh

# ২. মডেল ডাউনলোড করো (~1GB, Qwen2.5-1.5B-Instruct-Q4_K_M)
source .venv/bin/activate
bash download_model.sh
```

## Usage

```bash
source .venv/bin/activate

# টার্মিনালে চ্যাট করতে:
python core/cli_chat.py

# অথবা ওয়েব চ্যাট (http://127.0.0.1:8000):
make run
```

কমান্ড (CLI মোডে):
- `/reset` — নতুন কথোপকথন শুরু করে (আগেরটা memory.db-তেই থাকে)
- `/quit` — বের হও

## Notes on quality

এইটা 1.5B parameter, ~1GB size-এর একটা ছোট মডেল — ChatGPT/Claude/14B+ মডেলের
মতো গভীর reasoning বা খুব specialized জ্ঞান আশা করা যাবে না। স্কুল/কলেজ
level-এর সাধারণ subject question আর basic-to-medium কোডিং-এর জন্য যথেষ্ট
ভালো, কিন্তু কঠিন/উন্নত প্রশ্নে ভুল উত্তরও দিতে পারে — persona.yaml-এ তাকে
সততার সাথে অনিশ্চয়তা স্বীকার করতে বলা আছে, তারপরও সবসময় answer verify করে
নেওয়া ভালো অভ্যাস।

আরও ভালো quality চাইলে `download_model.sh`-এ বড় model (3B/7B/14B) বসিয়ে
`config.yaml`-এ path/context_size বদলে নেওয়া যায় — কিন্তু তাহলে ~1GB
target আর থাকবে না, বেশি RAM/storage লাগবে।

## Roadmap

- [ ] `memory_rag/` — document/note থেকে RAG (এখন খালি placeholder)
- [ ] `tools/` — file read/write, calculator ইত্যাদি agent tools (এখন খালি placeholder)
- [ ] Streaming reply web UI-তে (এখন শুধু CLI-তে streaming আছে, `generate_stream()`)

## License

তোমার প্রজেক্ট — নিজের প্রয়োজন অনুযায়ী license বেছে নাও (MIT সবচেয়ে সহজ শুরুর জন্য)।
