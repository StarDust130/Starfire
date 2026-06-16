<div align="center">

# ✨ StarFire ✨


  <div align="center">
  <img src="public/banner.png" alt="Event Flow Diagram" width="800" />
</div>

  <p align="center">
    <strong>An AI Agent that grows with you. 🪴</strong> 
  </p>

#### A cloud-native, deeply personalized AI agent orchestrator designed to navigate the global opportunity landscape.

</div>

---

<!--
## ✦ Demo Preview

Experience the platform from anywhere. An adaptive interface seamlessly bridging Telegram, web dashboard, and worker agents in real-time.

<div align="center">
  <img src="public/tables.gif" alt="Demo Preview" width="800" style="border-radius: 8px;" />
</div>

<br />

---
-->

## ✦ Vision

AI should feel persistent, not purely transactional.

StarFire acts as a companion operating system rather than a standard chatbot. It builds a continuously evolving understanding of who you are, retaining context across days, weeks, and months. As it learns your capabilities and goals, it autonomously navigates opportunities, scouts for roles, and curates pathways tailored uniquely to you.

<br />

---

## ✦ Core Features

| Capability                 | Description                                                             |
| :------------------------- | :---------------------------------------------------------------------- |
| **🧠 Persistent Memory**   | Remembers conversations, goals, and context across extended timeframes. |
| **🎯 AI Job Discovery**    | Autonomously searches, ranks, and retrieves global opportunities daily. |
| **🔍 Semantic Retrieval**  | Fetches perfectly tailored information using advanced vector search.    |
| **🤖 Agent Orchestration** | A "Boss AI" manages highly specialized, ephemeral worker agents.        |
| **📄 Resume Optimization** | Dynamically crafts and optimizes applications for specific roles.       |
| **✉️ Outreach Automation** | Prepares intelligent, personalized founder and recruiter outreach.      |
| **📱 Telegram Assistant**  | Always-on messaging interface for immediate access and updates.         |
| **🌐 Multi-platform**      | Extensible architecture built for the future of ambient computing.      |

<br />

---

## ✦ Architecture

Built for scale, resilience, and complex asynchronous execution.

<div align="center">
  <img src="public/architecture.png" alt="Architecture Diagram" width="800" />
</div>

**System Layers:**

- **Web Layer:** Next.js interface for user management and high-level dashboard visualization.
- **Core Orchestration:** The "Boss AI" handling routing, memory states, and decision logic.
- **Worker Agents:** Specialized node instances spawned for discrete tasks (e.g., job scraping, resume tailoring) that terminate upon completion.
- **Queues:** BullMQ combined with Redis to handle asynchronous agent dispatching.
- **Data & Memory:** PostgreSQL for relational structure, Qdrant for vector embeddings, and Redis for high-speed caching.

<br />

---

## ✦ Memory System

An intelligent, multi-tiered approach to user context retention.

<div align="center">
  <img src="public/memory-design.png" alt="Memory System" width="800" />
</div>

Our proprietary memory flow involves:

1. **Short-term Memory:** Immediate session context and recent conversational turns.
2. **Long-term Relational:** Structured data (career history, explicit preferences).
3. **Semantic Memory:** Vectorized traits, nuanced skills, and inferred goals.
4. **Retrieval Flow:** The Boss AI synthesizes state from all three tiers before dispatching instructions to worker agents.

<br />

---

## ✦ Event Flow

A clean lifecycle from user intent to execution.

<div align="center">
  <img src="public/how-it-work.png" alt="Event Flow Diagram" width="800" />
</div>

**1. Input:** Telegram/Web → **2. Processing:** Core "Boss" AI → **3. Dispatch:** Queue → **4. Execution:** Worker Agents → **5. Context Update:** Memory Systems → **6. Output:** Response/Action.

<br />

---

## ✦ System Data Models

A robust relational state management underlying the entire orchestration network.

<div align="center">
  <img src="public/tables.gif" alt="Data Architecture & Relation Tables" width="800" style="border-radius: 8px;" />
</div>

<br />

---

## ✦ Tech Stack

| Category              | Technologies                                      |
| :-------------------- | :------------------------------------------------ |
| **🌐 Frontend**       | Next.js, TailwindCSS, TypeScript                  |
| **⚙️ Backend**        | Express.js, Node.js                               |
| **🧠 AI Layer**       | LangGraph, OpenAI APIs                            |
| **☁️ Infrastructure** | PostgreSQL, Redis, BullMQ, Qdrant, Prisma, Docker |
| **🔁 Workflow**       | Turborepo, pnpm                                   |
| **🤖 Automation**     | Playwright                                        |
| **📈 Monitoring**     | Sentry, Pino                                      |

<br />

---

## ✦ Monorepo Structure

```text
StarFire/
├── apps/
│   ├── web/        # Next.js frontend application
│   ├── core/       # Express API & Boss AI orchestrator
│   ├── telegram/   # Telegram bot integration layer
│   └── workers/    # Modular, task-specific worker agents
├── packages/
│   ├── agents/     # Shared LangGraph agent logic
│   ├── ai/         # LLM wrappers and utility functions
│   ├── browser/    # Playwright automation scripts
│   ├── config/     # Global TypeScript/ESLint configurations
│   ├── database/   # Prisma clients and repository patterns
│   ├── memory/     # Qdrant vector store and retrieval logic
│   └── shared/     # Common types, schemas, and utilities
├── infra/          # Docker compose, scripts, and monitoring
└── prisma/         # PostgreSQL database schema and migrations
```

<br />

---

## ✦ Getting Started

### Prerequisites

- Node.js (v20+)
- pnpm (v9+)
- Docker & Docker Compose

### Fast Boot

```bash
# Clone the repository
git clone https://github.com/StarDust130/StarFire.git
cd StarFire

# Install dependencies
pnpm install

# Start infrastructure (PostgreSQL, Redis, Qdrant)
docker compose up -d

# Sync database
pnpm db:push

# Launch development servers
pnpm dev
```

<br />

---

<details>
<summary><b>✦ Environment Setup</b></summary>

Duplicate the example environment file and fill in your credentials.

```bash
cp .env.example .env
```

**Essential Variables:**

```env
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/StarFire"

# Memory & Queues
REDIS_URL="redis://localhost:6379"
QDRANT_URL="http://localhost:6333"

# Intelligence
OPENAI_API_KEY="sk-..."
```

</details>

<details>
<summary><b>✦ Docker Infrastructure</b></summary>

The project uses Docker Compose to containerize local dependencies required by the orchestrator:

- **PostgreSQL:** Primary relational datastore (Prisma).
- **Redis:** Powers BullMQ task queues and short-term caching.
- **Qdrant:** High-performance vector database for semantic memory retrieval.

Run `docker compose up -d` in the root directory to spin up the required backing services before starting the node instances.

</details>

<br />

---

## ✦ Future Roadmap

- [x] Core orchestrator architecture
- [x] Basic persistent memory implementation
- [x] Telegram bot integration
- [ ] WhatsApp integration
- [ ] Advanced autonomous workflows
- [ ] Voice interface capabilities
- [ ] Deeply integrated AI productivity OS features
- [ ] Browser automation for complex job applications
- [ ] Memory evolution and continuous self-reflection

<br />

---

## ✦ Philosophy

StarFire is not trying to become another generic chatbot.

It is designed to become a deeply personalized, reliable, and adaptive digital twin. It focuses on continuity, trust, and proactive execution, moving beyond reactive Q&A to true asymmetric leverage for your future.

<br />

<div align="center">
  <blockquote>
    "We are entering an era where your OS doesn't just run your apps—it runs your opportunities."
  </blockquote>
</div>

<br />

---

## ✦ License

This project is licensed under the StarDust License - "use it as you want but don't be a jerk." ~ 😎

<br />

<div align="center">
  <p style="font-size:28px; margin:8px 0;">✨ ✨ ✨</p>

  <br />
  <sub><b>Built with precision. Engineered for the future.</b></sub>
  <br />
  <p style="margin:6px 0; font-size:18px;">  <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Travel%20and%20places/Rocket.png" alt="Rocket" width="35" height="35" />  
       <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Smilies/Robot.png" alt="Robot" width="35" height="35" /> </p>
  <br />
  <img src="https://user-images.githubusercontent.com/73097560/115834477-dbab4500-a447-11eb-908a-139a6edaec5c.gif" alt="Cool line animation" width="500" />
</div>
