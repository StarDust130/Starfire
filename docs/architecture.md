# 🌌 Starfire Architecture

> **Starfire is not just a chatbot.**
>
> It is a personal AI companion that talks with you, understands your context,
> remembers what matters, safely controls your computer, and can delegate
> complex work to a background agent.

---

# 🧠 The Big Idea

Starfire has **one user experience** with two execution paths:

```text
                         ⭐ STARFIRE
                              │
                 ┌────────────┴────────────┐
                 │                         │
            ⚡ FAST PATH               🧠 DEEP PATH
            Realtime Voice               Eve Worker
                 │                         │
          talk + basic work          complex/background work
                 │                         │
                 └────────────┬────────────┘
                              │
                   🧩 Shared Capabilities
                              │
                    💻 Starfire Platform
                              │
                   ┌──────────┴──────────┐
                   │                     │
                 Linux                Future:
                                  Windows / macOS
```

### Starfire is the product.

### Eve is the worker.

The user talks to **Starfire**, not Eve.

Starfire can handle simple work itself and can delegate larger,
multi-step, or background work to Eve.

There is no separate classifier just to decide whether a task is big or small.
The main Starfire voice agent can decide when to use its `delegate_task`
capability.

---

# 🏗️ Project Structure

```text
Starfire/
│
├── agent/                         🧠 Eve worker
│   ├── agent.ts                   Eve agent definition
│   ├── instructions.md            Worker instructions
│   ├── lib/                       Starfire capability client
│   └── tools/                     Thin Eve capability adapters
│
├── apps/
│   └── desktop/
│       ├── src/                   🎨 React + voice UI
│       └── electron/
│           ├── main.ts            🔐 Trusted desktop process
│           ├── deviceBridge.ts   Shared capability dispatch
│           ├── realtimeVoice.ts  ⚡ Realtime voice path
│           └── agent/             Electron platform ports
│
├── packages/
│   └── contracts/
│       └── src/
│           ├── capabilities.ts    📜 Canonical capabilities
│           ├── functions.ts       🎤 Voice-facing specs
│           ├── dispatch.ts        🛠️ Shared execution
│           └── agent.ts           💪 Platform contracts / ports
│
├── eval/                          🧪 Evaluation
│
├── docs/                          📚 Documentation
│
└── public/                        🖼️ Assets
```

---

# ⭐ 0. Starfire Core

Starfire is the **main companion and coordinator**.

It is responsible for:

```text
🎤 Conversation
🧠 Understanding the user
❤️ Personality
🧠 Memory
🧩 Context
🛠️ Basic actions
🤝 Delegating complex work
📊 Task status
```

The long-term goal is for Starfire to understand the user's goals,
preferences, work, habits, and context and become increasingly useful
over time.

---

# ⚡ 1. Realtime Voice Path

### `apps/desktop/electron/realtimeVoice.ts`

This is Starfire's **fast path**.

It is optimized for low-latency conversation and immediate actions.

```text
🎤 User speaks
      ↓
⚡ Realtime voice model
      ↓
🧠 Starfire
      ↓
┌──────────────────────────────────┐
│                                  │
│  Talk normally                   │
│  Use a basic capability          │
│  Delegate complex work to Eve   │
│                                  │
└──────────────────────────────────┘
```

Example:

```text
"Open Discord"
      ↓
open_app()
      ↓
Discord opens
```

For a complex request:

```text
"Research the best AI startups
hiring interns and compare them."
      ↓
delegate_task()
      ↓
🧠 Eve
```

The realtime path does **not** need to run through Eve.

This keeps normal conversation and simple actions fast.

---

# 🧠 2. Eve — Background Worker

### `agent/`

Eve is Starfire's **background agent runtime**.

Eve handles work such as:

```text
🔎 Deep research
🌐 Multi-step browsing
📚 Large information gathering
💻 Complex workflows
🔁 Long-running tasks
🤖 Subagents
```

The user does not directly interact with Eve.

Instead:

```text
⭐ Starfire
      │
      │ delegate_task()
      ↓
🧠 Eve
      │
      ├── works
      ├── reports progress
      ├── asks for help when needed
      └── returns result
      ↓
⭐ Starfire
      ↓
🎤 Talks to the user
```

Eve can use different models depending on the task, including local
models when they are capable enough.

---

# 🤝 3. Task Delegation

Starfire can expose a capability such as:

```text
delegate_task()
```

A delegated task becomes a real background task.

Example:

```text
User
 ↓
"Research 20 companies and make a shortlist."
 ↓
⭐ Starfire
 ↓
delegate_task()
 ↓
🧠 Eve
```

Tasks can eventually have states such as:

```text
queued
running
waiting_for_user
paused
completed
failed
cancelled
```

Starfire can then answer:

```text
"What is Eve doing?"
"What is the task status?"
"Stop that task."
"Continue that task."
```

Eve can also request user input:

```text
🧠 Eve
   ↓
needs user input
   ↓
⭐ Starfire
   ↓
asks user
   ↓
user answers
   ↓
Eve continues
```

The user always interacts with Starfire.

---

# 🧩 4. Shared Capability Layer

Starfire's actions are **capabilities**, not Eve-only tools.

Both execution paths use the same capability layer:

```text
⚡ Voice ───────┐
               ├──→ 🧩 Starfire Capabilities
🧠 Eve ────────┘
                         ↓
                  💻 Platform Layer
                         ↓
                       Linux
```

Examples:

```text
open_app
close_app
focus_app

open_file
open_folder
open_url

clipboard_read
clipboard_write

system_info
web_search
get_weather

window_control
```

Voice and Eve may choose different capabilities,
but the actual computer operation is shared.

This makes future operating-system support much easier.

---

# 📜 5. One Canonical Capability Definition

Every Starfire capability has **one source of truth**.

### `packages/contracts/src/capabilities.ts`

A capability defines:

```text
name
description
arguments / schema
metadata
```

Different parts of Starfire consume the same definition:

```text
                 🧩 capabilities.ts
                        │
               ┌────────┴────────┐
               ↓                 ↓
         🎤 Voice specs      🧠 Eve adapters
               │                 │
               └────────┬────────┘
                        ↓
                 Shared dispatch
```

This prevents duplicated tool definitions from drifting apart.

There is no manual central tool registry.

---

# 🛠️ 6. Eve Tools

### `agent/tools/`

Each Eve tool is a **thin adapter** around a Starfire capability.

Example:

```text
agent/tools/open_app.ts
```

Its job is mainly:

```text
🧠 Eve
   ↓
open_app capability
   ↓
Starfire shared dispatch
```

The actual operating-system implementation does not belong inside
the Eve tool.

This keeps Eve replaceable.

---

# 🚦 7. Shared Dispatch

### `packages/contracts/src/dispatch.ts`

`executeDeviceTool()` is the shared execution boundary.

```text
⚡ Voice ───────┐
               │
               ├──→ executeDeviceTool()
               │
🧠 Eve ────────┘
                     ↓
               Starfire Platform
```

The dispatch layer maps a capability to the correct platform operation.

---

# 💪 8. Platform Ports

Starfire separates **what a capability means**
from **how the operating system performs it**.

```text
Capability
    ↓
Port
    ↓
Platform implementation
    ↓
Operating System
```

Example:

```text
open_app
   ↓
ports.apps.open()
   ↓
Electron platform implementation
   ↓
Linux
   ↓
Discord opens
```

Later the same capability can have different platform implementations:

```text
open_app
   ↓
┌──────────────┬──────────────┬──────────────┐
│              │              │
Linux        Windows        macOS
```

Voice and Eve do not need to know which operating system is underneath.

---

# 🔐 9. Electron — Trusted Desktop Layer

### `apps/desktop/electron/`

Electron is the trusted side of Starfire.

It handles privileged operations such as:

```text
💻 OS access
📂 Files
📋 Clipboard
🪟 Windows
🌐 External apps / URLs
🔑 Secrets
🔌 Local bridges
```

The React renderer does not directly control the operating system.

```text
React UI
   ↓
safe IPC
   ↓
Electron
   ↓
Operating System
```

This keeps privileged operations away from the UI.

---

# 🎨 10. Desktop UI

### `apps/desktop/src/`

This is Starfire's face.

It handles:

```text
🎀 Character / UI
🎤 Microphone
👂 Wake word
🔊 Audio
🎭 Visual state
🔄 Conversation state
```

The UI focuses on the experience rather than privileged OS operations.

---

# 🧠 11. Memory + Context

Memory is a **Starfire service**, not an Eve-only feature.

Future architecture:

```text
                 ⭐ STARFIRE
                      │
            ┌─────────┴─────────┐
            ↓                   ↓
         🧠 Memory          🧩 Context
            │                   │
            └─────────┬─────────┘
                      ↓
             ┌────────┴────────┐
             ↓                 ↓
          ⚡ Voice            🧠 Eve
```

There is one shared memory source.

Both Voice and Eve can use the same Starfire memory.

Example:

```text
User:
"I want to become an AI engineer."

        ↓

🧠 Starfire Memory

        ↓

Later:

"Find me AI internships."

        ↓

⭐ Starfire understands the goal

        ↓

delegate_task()

        ↓

🧠 Eve
```

The Context Engine decides which memory, recent conversation,
current task, screen state, goals, and other information are relevant
for the current request.

---

# 👀 12. Screen Awareness

Screen awareness is a **shared Starfire capability**.

```text
👀 Screen Awareness
        ↓
Shared capability
        ↓
   ┌────┴─────┐
   ↓          ↓
 Voice       Eve
```

Simple requests can use it directly.

Large screen-based tasks can be delegated to Eve.

Example:

```text
"What am I looking at?"
        ↓
⚡ Starfire
        ↓
👀 Screen
```

Versus:

```text
"Go through these 30 pages and collect the important information."
        ↓
⭐ Starfire
        ↓
🧠 Eve
```

---

# 🖐️ 13. Computer Use

Computer use follows the same architecture.

```text
🖐️ Computer Use
       ↓
Starfire capability
       ↓
Platform layer
       ↓
Operating System
```

Both Voice and Eve can use it.

The difference is the amount and complexity of work.

```text
Small action
   ↓
⚡ Starfire

Large multi-step task
   ↓
🧠 Eve
```

---

# 🧠 14. Skills

Skills describe **how an agent should perform a type of work**.

```text
Tool
 ↓
What the agent CAN do

Skill
 ↓
How the agent SHOULD do a type of work
```

Example:

```text
Research task
      ↓
Research skill
      ↓
Browser + search + tools
      ↓
Better result
```

Skills stay separate from Starfire's core computer capabilities.

They can be added or removed without changing the platform layer.

---

# 🧪 15. Evaluation

### `eval/`

Evaluation tests real Starfire behavior.

```text
Test case
   ↓
⚡ Realtime Voice / 🧠 Eve
   ↓
Canonical capabilities
   ↓
Shared dispatch
   ↓
Mock / controlled platform
   ↓
Result
   ↓
Grade
```

Important areas include:

```text
🎯 Capability selection
🧩 Arguments
✅ Result correctness
🛡️ Safety
🔄 Reliability
🤝 Delegation
⚡ Latency
🪙 Token usage
```

The evaluator should eventually test both the fast path and the deep path.

---

# 🔐 16. Safety Boundary

Starfire should never give a model unrestricted access to the computer.

Instead:

```text
🧠 Model
   ↓
🧩 Explicit capability
   ↓
🔐 Policy / permission
   ↓
💻 Controlled platform action
```

The model requests a capability.

The platform controls how that capability is executed.

Sensitive operations can later require confirmation or stronger permissions.

Examples:

```text
✅ Open application
✅ Read screen
✅ Open file

⚠️ Delete important files
⚠️ Send messages
⚠️ Make purchases
⚠️ Change sensitive system settings
```

---

# 🔄 17. Simple Request Flow

When you say:

> **"Open Discord."**

```text
🎤 Microphone
      ↓
⚡ Realtime Voice Model
      ↓
⭐ Starfire
      ↓
open_app()
      ↓
🧩 Shared Capability
      ↓
executeDeviceTool()
      ↓
💪 Electron Port
      ↓
💻 Linux
      ↓
Discord opens
      ↓
✅ Result
      ↓
⭐ Starfire
      ↓
🔊 "Discord is open."
```

---

# 🔄 18. Complex Request Flow

When you say:

> **"Research the best AI companies for me and make a shortlist."**

```text
🎤 User
   ↓
⭐ Starfire
   ↓
delegate_task()
   ↓
🧠 Eve
   ↓
Skills + Tools + Models
   ↓
Research / Browse / Think
   ↓
Task Progress
   ↓
✅ Result
   ↓
⭐ Starfire
   ↓
🎤 Explains the result to the user
```

If Eve needs the user:

```text
🧠 Eve
   ↓
"Need user input"
   ↓
⭐ Starfire
   ↓
asks user
   ↓
User answers
   ↓
🧠 Eve continues
```

---

# 🗺️ Starfire V1 Roadmap

```text
V1.0   🏗️ Foundation
          ↓
V1.1   🧠 Memory
          ↓
V1.2   🧩 Context Engine
          ↓
V1.3   👀 Screen Awareness
          ↓
V1.4   🖐️ Computer Use
          ↓
V1.5   ⏰ Tasks + Reminders
          ↓
V1.6   🤖 Proactive Agent
          ↓
V1.7   ❤️ Personality + Continuity
          ↓
V1.8   🏠 Local LLM + Model Router
          ↓
V1.9   🧪 Massive Evaluation
          ↓
V1.10  ✨ JARVIS Polish
```

All future features build on the same foundation:

```text
                         ⭐ STARFIRE
                              │
              ┌───────────────┴───────────────┐
              ↓                               ↓
        ⚡ Realtime                       🧠 Eve
         Companion                        Worker
              │                               │
              └───────────────┬───────────────┘
                              ↓
                     🧩 Shared Services
                              ↓
                     🛠️ Capabilities
                              ↓
                      💪 Platform Layer
                              ↓
                     💻 Operating System
```

---

# 🌌 Core Principles

```text
1. ⭐ Starfire is the product.

2. 🧠 Eve is infrastructure / background worker.

3. ❤️ The user talks to Starfire, never directly to Eve.

4. ⚡ Fast work stays on the realtime path.

5. 🧠 Complex / long-running work can be delegated to Eve.

6. 🧩 Voice and Eve use the same Starfire capabilities.

7. 📜 Every capability has one canonical definition.

8. 💪 Platform code stays separate from agent logic.

9. 🏠 Private state and memory should be local-first whenever possible.

10. 🔐 Models receive explicit capabilities, not unrestricted computer access.

11. 🧪 Both execution paths must be evaluated.

12. 🔄 Eve is replaceable infrastructure; Starfire remains the product.
```

---

# 🚀 The Vision

Starfire starts as:

```text
🎤 Talk
   ↓
🧠 Understand
   ↓
🛠️ Act
```

Then grows into:

```text
                         ⭐ STARFIRE
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ↓                     ↓                     ↓
      🎤 Talk             🧠 Remember           👀 See
        │                     │                     │
        ↓                     ↓                     ↓
      💡 Think             🧩 Context           🖐️ Act
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ↓
                       🤝 Delegate
                              ↓
                         🧠 Eve
                              ↓
                       🔎 Deep Work
                              ↓
                       ✅ Results
                              ↓
                         ⭐ Starfire
                              ↓
                         👤 User
```

> **🌌 Starfire is not another chatbot.**
>
> **It is a personal intelligent system designed to understand you,
> remember what matters, take useful action, handle boring work,
> and help you become more effective over time.**
>
> **⭐ Starfire is the companion.**
>
> **🧠 Eve is the worker.**
>
> **🛠️ Capabilities are the hands.**
>
> **💪 The platform is the body.**
>
> **🧠 Memory and context make Starfire know you.**