# AWS_AI_Resources_Provisioner

> Natural language → Python (boto3) scripts → Local AWS sandbox (MiniStack)

AWS_AI_Resources_Provisioner is an open-source tool that converts plain-English infrastructure descriptions into executable Python (boto3) provisioning scripts using AI, then runs them against a local AWS emulator (MiniStack / LocalStack) for safe, cost-free testing.

It now supports S3 buckets, SQS queues, Lambda functions, IAM roles, and local EC2 instances running as custom Docker web servers.

---

## Architecture

```
Browser (localhost:5173)
  └─ React + Vite + React Query
       │
       ▼ HTTP
FastAPI backend (localhost:8000)
  ├─ /generate  → Groq API (llama-3.3-70b-versatile)
  ├─ /deploy    → Runs boto3 script locally
  └─ /stacks/{name} → Resource state manager
       │
       ▼
MiniStack / LocalStack (localhost:4566)
  └─ Local S3, Lambda, SQS, EC2 emulation
```

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (with Compose V2)
- A [Groq API key](https://console.groq.com/) (free tier available)

---

## Quick Start

```bash
# 1. Clone the repo
git clone <repo-url>
cd AWS_AI_Resources_Provisioner

# 2. Add your Groq API key
cp .env.example .env
# Edit .env and set GROQ_API_KEY=your_key_here

# 3. Start everything
docker compose up --build

# 4. Open the app
open http://localhost:5173
```

> MiniStack (LocalStack) will be running at `http://localhost:4566`.  
> Backend API docs available at `http://localhost:8000/docs`.

---

## Usage

1. **Describe your resource** — Type a prompt like:
   - `Create an S3 bucket called my-photos`
   - `Make a private S3 bucket named dev-uploads`

2. **Review the generated Script** — The AI outputs Python code using `boto3`. Inspect it before deploying.

3. **Deploy** — Click "Deploy to MiniStack". The backend executes the script and logs progress.

4. **Verify** — Confirm your bucket exists:
   ```bash
   aws --endpoint-url http://localhost:4566 s3 ls
   ```

---

## Project Structure

```
AWS_AI_Resources_Provisioner/
├── docker-compose.yml
├── .env.example
├── README.md
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── groq_client.py      # Groq API wrapper + code-fence stripper
│   └── main.py             # FastAPI: /generate, /deploy, /stacks/{name}
└── frontend/
    ├── Dockerfile
    ├── vite.config.ts
    └── src/
        ├── lib/
        │   ├── types.ts        # Shared TS interfaces
        │   ├── api.ts          # Typed API client
        │   └── queryClient.ts  # React Query setup
        ├── hooks/
        │   ├── useGenerateTemplate.ts
        │   ├── useDeployStack.ts
        │   └── useStackStatus.ts   # Polls every 2s until terminal state
        ├── components/
        │   ├── PromptInput.tsx
        │   ├── YamlPreview.tsx
        │   └── StackStatus.tsx
        └── App.tsx
```

---

## Development (without Docker)

**Backend:**
```bash
cd backend
pip install -r requirements.txt
cp ../.env.example ../.env   # fill in GROQ_API_KEY
uvicorn main:app --reload --port 8000
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

> Make sure MiniStack is running: `docker run -p 4566:4566 localstack/localstack:3`

---

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `GROQ_API_KEY` | `.env` (root) | Your Groq API key |
| `MINISTACK_ENDPOINT` | set by docker-compose | MiniStack/LocalStack endpoint (default: `http://localhost:4566`) |
| `VITE_API_URL` | `frontend/.env` | Backend URL seen by browser (default: `http://localhost:8000`) |

---

## Phase Roadmap

| Phase | Status | Description |
|---|---|---|
| 1 | ✅ Completed | S3 bucket generation & deployment |
| 2 | ✅ Completed | DynamoDB tables, SQS queues |
| 3 | ✅ Completed | Lambda functions, IAM roles, and EC2 instances |
| 4 | Planned | Change set previews before deploy |
| 5 | Planned | Architecture diagram view |
