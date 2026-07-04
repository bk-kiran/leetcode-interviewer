# Interview Agent

An agentic voice-based mock coding interview tool. Practice problems with an AI interviewer that watches your progress, gives hints, and scores your performance.

## Modes

- **Normal Mode** — Silent practice. Push-to-talk activates a voice agent for on-demand hints or explanations.
- **Interview Mode** — Proactive AI interviewer runs a full simulated interview via voice: presents problems, monitors your progress, drops hints, and scores you at the end.

## Tech Stack

- **Frontend**: Next.js 15 (App Router), TypeScript, Tailwind CSS
- **Backend**: FastAPI (Python 3.11+), LangGraph agent orchestration
- **Voice**: AWS Transcribe (speech-to-text), AWS Polly (text-to-speech)
- **Code execution**: Sandboxed execution environment

---

## Setup

### Prerequisites

- Node.js 20+
- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`)

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Runs at http://localhost:3000

### Backend

```bash
cd backend
cp .env.example .env   # fill in your keys
uv sync
uv run uvicorn main:app --reload
```

Runs at http://localhost:8000

- Health check: http://localhost:8000/health
- API docs: http://localhost:8000/docs
