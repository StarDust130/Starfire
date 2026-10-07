# 🌌 Starfire Architecture

> **A realtime voice AI companion that can understand you, talk with you, and safely perform desktop actions.**

Starfire is built as a small modular system:

```text
🎤 You
  │
  ▼
🧠 Qwen Realtime
  │
  │ tool call
  ▼
🚦 AgentRunner
  │
  ▼
🧰 Tool Registry
  │
  ▼
🛠️ Tool
  │
  ▼
💻 Electron / Linux
  │
  ▼
✅ Result
  │
  ▼
🧠 Qwen
  │
  ▼
🎀 Starfire speaks
```

---

## 🏗️ Project Structure

```text
Starfire/
│
├── apps/
│   ├── desktop/          🖥️ Desktop app
│   │   ├── src/          🎨 React UI + voice UI
│   │   └── electron/     🔐 Trusted desktop layer
│   │
│   └── core/             🧠 Agent execution logic
│
├── packages/
│   ├── contracts/        📜 Shared types + interfaces
│   └── tools/            🧰 Tools + registry + validation
│
├── eval/                 🧪 Agent evaluation
│
├── docs/                 📚 Architecture + project docs
│
└── public/               🖼️ Images + assets
```

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

# 🚦 4. Agent Core

### `apps/core`

The core currently contains the **AgentRunner**.

Its job is simple:

```text
Model gives tool calls
        ↓
Validate the calls
        ↓
Limit the number of calls
        ↓
Execute safely
        ↓
Return results
```

The runner:

- ignores malformed calls
- limits calls per turn
- executes calls sequentially
- catches executor failures

Think of it as the **traffic controller** for tool execution.

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

### `packages/tools`

Tools are the things Starfire can actually **do**.

Current V0 tools:

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

Each tool contains:

```text
📜 Manifest
   ↓
What the model should know

⚙️ Handler
   ↓
What the tool actually does
```

---

# 🗃️ 7. Tool Registry

### `packages/tools/src/registry.ts`

The Registry is Starfire's **toolbox manager**.

It:

```text
📦 stores tools
🔎 finds tools
📋 exposes tool definitions to Qwen
✅ validates arguments
⏱️ applies execution timeout
🛑 handles unknown/broken tools
```

The model sees the tool manifests through:

```text
registry.functionTools()
```

So the model knows:

> **"These are the capabilities I have."**

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
🔐 missing policy coverage
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

Tools also declare danger metadata:

```text
safe
confirm
```

and the project has a separate `policy.ts` for risk/confirmation rules.

> ⚠️ **Current V0 note:** policy metadata exists, but confirmation enforcement still needs to be connected to `ToolRegistry.execute()`.

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
🚦 AgentRunner
      ↓
🧰 ToolRegistry
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

---

# 🧠 The Core Idea

Starfire is built around one simple separation:

```text
🧠 Model
    decides WHAT to do

🚦 AgentRunner
    controls HOW tool calls execute

🧰 Registry
    manages WHICH tools exist

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