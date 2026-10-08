# 🌌 Starfire Architecture

> **A realtime voice AI companion that can understand you, talk with you, and safely perform desktop actions.**

Starfire is built as a small modular system:

```text
🎤 You
  │
  ▼
⭐ Starfire
  │
  ▼
☁️ Eve Agent            (agent/ — agent runtime, tool discovery, tool calling)
  │
  ▼
🔧 Eve Tool             (agent/tools/ — one file per capability)
  │
  ▼
🌐 Starfire platform    (device bridge dispatch → Electron ports)
  │
  ▼
💻 Electron / Linux
  │
  ▼
✅ Result
  │
  ▼
🎀 Starfire speaks
```

---

## 🏗️ Project Structure

```text
Starfire/
│
├── agent/                ☁️ Eve agent definition + tools
│   ├── agent.ts          ⚙️ Model config (defineAgent)
│   ├── instructions.md   💬 Starfire personality
│   ├── lib/              🌉 Device bridge client
│   └── tools/            🔧 One Eve tool per file
│
├── apps/
│   └── desktop/          🖥️ Desktop app
│       ├── src/          🎨 React UI + voice UI
│       └── electron/     🔐 Trusted desktop layer (ports, device bridge, voice)
│
├── packages/
│   └── contracts/        📜 Shared platform types + function specs
│
├── eval/                 🧪 Agent evaluation
│
├── docs/                 📚 Architecture + project docs
│
└── public/               🖼️ Images + assets
```

---

# ☁️ 0. Eve Agent

### `agent/`

Eve (Vercel's agent framework) is Starfire's **agent runtime** — V1.0 foundation.

```text
agent/agent.ts           defineAgent({ model, reasoning })
agent/instructions.md    Starfire's personality + behavior rules
agent/tools/*.ts         one defineTool per file — Eve discovers them
agent/lib/desktop.ts     calls Starfire's device bridge over HTTP
```

There is **no custom AgentRunner, no ToolRegistry, no custom agent loop** —
Eve owns tool discovery, validation, and execution. Starfire keeps the
desktop capabilities and the personality.

---

# 🎨 1. Desktop UI

### `apps/desktop/src`

This is Starfire's **face and voice interface**.

```text
🎀 React UI
🎭 Three.js / VRM character
🎤 Microphone
👂 Wake word
🔊 Audio playback
🔄 Voice session state
```

The UI handles how Starfire **looks, listens, speaks, and reacts**.

It does not directly control Linux.

---

# 🔐 2. Electron

### `apps/desktop/electron`

Electron is the **trusted side** of Starfire.

It handles:

```text
🔑 API secrets
💻 OS access
🪟 Desktop windows
📂 Files
📋 Clipboard
🌐 External websites
🔌 WebSocket connection
```

The React renderer communicates with Electron through a small **IPC bridge**.

```text
React
  │
  │ safe IPC
  ▼
Electron
  │
  ▼
Operating System
```

This keeps privileged operations away from the UI.

---

# 🧠 3. Realtime Voice Bridge

### `realtimeVoice.ts`

This is the main connection between the **voice model and Starfire's agent system**.

It:

```text
🎤 sends audio
⬇️
🧠 receives Qwen events
⬇️
🛠️ receives tool calls
⬇️
🚦 executes tools
⬇️
📤 sends tool results back
⬇️
🔊 returns Starfire's voice
```

The realtime model is:

```text
qwen3-8-omni-flash-realtime
```

---

# 🚦 4. Agent Runtime (Eve)

The agent runtime is **Eve** — see section 0. There is no Starfire-owned
runner, registry, or validation layer anymore.

When the realtime voice model produces function calls, the Electron main
process executes them through the same platform dispatch Eve uses
(`executeDeviceTool` in `deviceBridge.ts`).

---

# 📜 5. Contracts

### `packages/contracts`

Contracts define the **shared language of Starfire**.

Examples:

```text
ToolCall
ToolResult
ToolManifest
ToolParameter
AgentPorts
AppPort
FilePort
WindowPort
```

They make sure every part agrees on the same shapes.

```text
UI
 │
Core
 │
Tools
 │
Electron
 │
Eval
```

Everyone speaks the same TypeScript language.

---

# 🧰 6. Tools

### `agent/tools/`

Tools are the things Starfire can actually **do**.

Current tools (one Eve tool per file):

```text
🖥️ open_app
🛑 close_app
🎯 focus_app

📂 open_folder
📄 open_file
🌐 open_url

📋 clipboard
💻 system_info

🔎 web_search
🌦️ get_weather

🪟 window_control
🕐 current_date_time

👋 end_session
```

Each tool file:

```text
📜 description + zod input schema
   ↓
What the model should know

⚙️ execute()
   ↓
What the tool actually does — a thin call into
Starfire's platform layer (agent/lib/desktop.ts
→ device bridge → Electron ports)
```

Eve discovers tools from the filesystem: a tool at
`agent/tools/open_app.ts` is `open_app`. There is no central tool
index, registry, or manual registration.

---

# 🗃️ 7. Tool Execution

Tool discovery, argument validation, and execution are **Eve's job**
(section 0). The old registry/validation files were removed in the
V1.0 migration.

The model-facing function specs (`STARFIRE_FUNCTION_SPECS` in
`packages/contracts`) describe the same capabilities for the realtime
voice session and the eval driver.

---

# 💪 8. Ports

Starfire separates **tool logic** from **real OS actions**.

```text
Tool
 ↓
Port
 ↓
Electron implementation
 ↓
Linux
```

Example:

```text
open_app
   ↓
ports.apps.open()
   ↓
electron-ports.ts
   ↓
Linux process
   ↓
Discord opens
```

This makes tools easier to:

```text
🧪 test
🔄 replace
🧩 extend
```

The evaluator uses the same tools with a **MockOS** instead of touching the real computer.

---

# 🧪 9. Evaluation

### `eval/`

Starfire has its own evaluation system for testing real model behavior.

```text
Test case
   ↓
Real Qwen model
   ↓
Real tool definitions
   ↓
Real Registry
   ↓
MockOS
   ↓
Grade result
```

It checks things like:

```text
🎯 Tool selection
🧩 Arguments
✅ State changes
🛡️ Safety
🔄 Reliability
💬 Response quality
⚡ Latency
🪙 Token usage
```

It also checks the architecture itself for issues such as:

```text
⚠️ stale configuration
🧩 tool mismatches
```

---

# 🔐 10. Safety

Starfire does **not** give the model unrestricted shell access.

Instead:

```text
🧠 Model
   ↓
🧰 Explicit tools
   ↓
💻 Controlled OS operations
```

Danger/risk policy is **Eve's approval system** (not configured in
V1.0 — the platform layer keeps its own denylist and home-folder
restrictions).

---

# 🔄 Complete Request Flow

When you say:

> **"Open Discord."**

Starfire does:

```text
🎤 Microphone
      ↓
🎧 Voice Controller
      ↓
🔐 Electron
      ↓
🌐 Realtime WebSocket
      ↓
🧠 Qwen
      ↓
"open_app(discord)"
      ↓
🔧 Eve Tool / platform dispatch
      ↓
🛠️ open_app
      ↓
💻 Electron Port
      ↓
🖥️ Discord opens
      ↓
✅ Tool result
      ↓
🧠 Qwen
      ↓
🔊 "Discord is open."
```

(The same dispatch is used by the Eve agent path — see section 0.)

---

# 🧠 The Core Idea

Starfire is built around one simple separation:

```text
🧠 Model
    decides WHAT to do

☁️ Eve
    owns the agent runtime, tool discovery, and execution

🛠️ Tools
    define WHAT Starfire can do

💪 Ports
    connect tools to the real computer

🔐 Electron
    owns privileged desktop access

📜 Contracts
    keep everything consistent

🧪 Eval
    checks whether it actually works
```

---

# 🚀 Current Direction

```text
Voice
  ↓
Tool use
  ↓
Desktop control
  ↓
Better safety
  ↓
Better evaluation
  ↓
Vision
  ↓
Memory
  ↓
More capable agents
```

> **Give Starfire capabilities — not unrestricted access to the computer.** 🌌