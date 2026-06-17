# AWS_AI_Resources_Provisioner

> Natural language → CloudFormation templates → Local AWS sandbox (MiniStack)

AWS_AI_Resources_Provisioner is an open-source tool that converts plain-English infrastructure descriptions into AWS CloudFormation templates using AI, then deploys them to a local AWS emulator for safe, cost-free testing.

**Phase 1** supports S3 buckets. Later phases will add DynamoDB, SQS, Lambda, IAM, change set previews, and an architecture diagram view.

---

## Architecture

```
Browser (localhost:5173)
  └─ React + Vite + React Query
       │
       ▼ HTTP
FastAPI backend (localhost:8000)
  ├─ /generate  → Groq API (llama-3.3-70b-versatile)
  ├─ /deploy    → MiniStack CloudFormation
  └─ /stacks/{name} → MiniStack CloudFormation
       │
       ▼
MiniStack / LocalStack (localhost:4566)
  └─ CloudFormation + S3 emulation
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

2. **Review the generated YAML** — The AI outputs raw CloudFormation. Inspect it before deploying.

3. **Deploy** — Click "Deploy to MiniStack". The UI polls status every 2 seconds.

4. **Verify** — Once `CREATE_COMPLETE`, confirm your bucket exists:
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
| `MINISTACK_ENDPOINT` | set by docker-compose | CloudFormation endpoint (default: `http://localhost:4566`) |
| `VITE_API_URL` | `frontend/.env` | Backend URL seen by browser (default: `http://localhost:8000`) |

---

## Phase Roadmap

| Phase | Status | Description |
|---|---|---|
| 1 | ✅ Current | S3 bucket generation & deployment |
| 2 | Planned | DynamoDB tables, SQS queues |
| 3 | Planned | Lambda functions, IAM roles |
| 4 | Planned | Change set previews before deploy |
| 5 | Planned | Architecture diagram view |
