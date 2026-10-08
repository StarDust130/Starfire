# 🔥 Starfire — Codebase Map

> **Forget the code? Read this file first.**
>
> Starfire is a realtime desktop AI companion.
> **Eve is the agent runtime → Tools act → Ports touch the computer → Electron keeps it safe.**

---

## 🧠 The Whole System

```text
🎤 User
  ↓
🖥️ React UI
  ↓
☁️ Eve Agent (agent/)
  ↓
🔧 Eve Tool (agent/tools/)
  ↓
🌐 Starfire platform dispatch (device bridge)
  ↓
🖐️ Port
  ↓
💻 OS / Web / External Service
  ↓
↩️ Result → Eve → Starfire speaks
```

(Voice runs through the Electron realtime session and dispatches tool
calls through the same platform boundary.)

### Easy rule

**Eve runs the agent.**  
**Tool describes WHAT.**  
**Port knows HOW.**  
**Electron gives trusted access to the computer.**  
**Eval checks whether everything worked correctly.**

---

# 📁 Project Structure

```text
Starfire/
├── agent/          ☁️ Eve agent definition + tools
├── apps/
│   └── desktop/    🖥️ Desktop app
├── packages/
│   └── contracts/  📜 Shared platform types + function specs
├── eval/
├── docs/
└── public/
```

---

# 🖥️ `apps/desktop`

The actual Starfire desktop application.

## `apps/desktop/src`

### `App.tsx`
Main React controller.

Connects:
- voice
- wake word
- microphone
- UI state
- Starfire 3D scene

Think:

> **“What is Starfire doing right now?”**

### `App.css`
Main desktop UI styling.

### `main.tsx`
React entry point.

Starts the frontend.

### `components/`
Normal React UI components.

### `voice/`
Everything related to hearing and speaking.

Includes:
- microphone
- wake word
- realtime voice controller
- audio playback
- voice state

Think:

> **“How does Starfire hear and talk?”**

### `three/`
3D Starfire character.

Handles:
- model
- animation
- expressions
- reactions
- voice animation
- dragging
- activities

Think:

> **“Starfire's body and personality.”**

### `types/`
Frontend-specific TypeScript types.

---

# ⚡ `apps/desktop/electron`

This is the **trusted computer side** of Starfire.

React should not directly control Linux, files, secrets, APIs, etc.

Electron does that.

## Important files

### `main.ts`
Starts Electron.

Creates the Starfire window and handles desktop-level behavior such as shortcuts.

Think:

> **“Start Starfire's trusted desktop process.”**

### `preload.ts`
Safe bridge between React and Electron.

Only exposes the things the frontend is allowed to use.

Think:

> **“Security gate.”**

### `realtimeVoice.ts`
The main voice bridge.

Connects:

```text
Starfire ↔ Qwen Realtime
```

Also:
- receives tool calls
- executes them through the platform dispatch (`deviceBridge.ts`)
- sends tool results back to Qwen
- handles voice/session events

Think:

> **“Qwen ↔ Starfire translator.”**

### `realtimeProtocol.ts`
Defines the realtime session configuration.

Contains:
- model
- voice
- system instructions
- tool definitions
- realtime settings

Think:

> **“Rules for talking to Qwen.”**

---

# 🛠️ `apps/desktop/electron/agent`

Real-world implementations.

### `electron-ports.ts`
The main **OS hands**.

Actually performs things like:

- open app
- close app
- open files/folders
- clipboard
- system info
- URLs
- window actions

Think:

> **“How Starfire actually touches Linux.”**

### `exa-search.ts`
Web search adapter.

```text
web_search tool
      ↓
Exa adapter
      ↓
Exa API
```

Keeps the Exa API key inside Electron.

### `kwin-windows.ts`
KDE/KWin window controller.

Actually performs:

- focus
- minimize
- maximize
- restore
- lower

Think:

> **“How Starfire controls KDE windows.”**

---

# ☁️ `agent/`

The Eve agent — Starfire's agent runtime (V1.0 foundation).

### `agent.ts`

Agent configuration:

```text
defineAgent({ model, reasoning })
```

### `instructions.md`
Starfire's personality + behavior rules.

### `tools/`
One Eve tool per file. Eve discovers them from the filesystem; each
`execute()` is a thin call into Starfire's platform layer
(`agent/lib/desktop.ts` → device bridge → Electron ports). Each tool
takes its description + input schema from the canonical Starfire
capability definitions (`packages/contracts/src/capabilities.ts`).

Think:

> **“Eve runs the agent, Starfire provides the hands.”**

---

# 📜 `packages/contracts`

Shared language between everything. This is the shared Starfire
capability layer: canonical definitions + shared execution.

### `capabilities.ts`

The ONE canonical definition of every Starfire capability — name,
description, arguments/schema, and basic metadata (`device` = touches
the computer via ports, `session` = conversation-local). Both Eve and
the realtime voice derive their tool forms from this file.

### `dispatch.ts`

The shared execution layer:

```text
executeDeviceTool(ports, tool, args)
```

Every consumer routes through it — voice directly, Eve over the device
bridge HTTP boundary, eval in-process. The ports carry the actual OS
implementation, so Linux/Windows/macOS backends can change without
touching Eve or the voice agent.

### `agent.ts`

Defines the platform port interfaces:

- `AgentPorts`
- port interfaces (apps, files, urls, clipboard, system, web, weather, windows)

### `functions.ts`

The model-facing function specs (`STARFIRE_FUNCTION_SPECS`) — DERIVED
from `capabilities.ts` — used by the realtime voice session and the
eval driver.

Think:

> **“Everyone agrees on the same rules and shapes.”**

Example:

```text
Eve tool says → I need AppPort (via the device bridge)

Electron says → I provide AppPort
```

---

# 🌐 Device bridge (Electron ↔ Eve)

### `deviceBridge.ts`
A tiny local HTTP server (default `http://127.0.0.1:17321`) that the
Eve tools call. It serves the shared dispatch from
`@starfire/contracts` (`executeDeviceTool`) over HTTP:

```text
executeDeviceTool(ports, tool, args)
```

Every action path goes through it:

```text
Eve agent → Eve tool → HTTP /v1/tool → executeDeviceTool → ports
voice function call → executeDeviceTool → ports
eval → executeDeviceTool → MockOS
```

Optional shared secret: `STARFIRE_DEVICE_TOKEN`.

Think:

> **“The single door into Starfire's computer capabilities.”**

---

# 🧪 `eval`

Starfire's testing laboratory.

It uses real Qwen + real tool definitions + fake computer state.

Main pieces:

### `dataset/`
Test cases.

Example:

> “Open Discord”

Expected:

```text
open_app
app = Discord
```

### `driver.ts`
Talks to the realtime model.

### `runner.ts`
Runs many test cases.

### `grade.ts`
Checks whether the result is correct.

Checks things like:
- right tool
- right arguments
- safety
- state
- task completion
- response quality

### `mock/`
Fake computer.

Lets Starfire test actions without actually damaging/touching the real machine.

### `provider.ts`
Provider/model configuration.

### `quota.ts`
Protects API usage and budget.

### `report.ts`
Builds the final scorecard.

### `render.ts` / `html.ts`
Creates human-friendly reports/UI.

### `cli.ts`
Commands like:

```bash
pnpm eval
pnpm eval:case C017
pnpm eval:selftest
```

### `starfire.ts`
Connects the evaluation system to Starfire's tool setup.

### `types.ts`
Shared evaluation types.

---

# 📚 `docs`

Architecture and learning notes.

Use this folder for:

- architecture
- decisions
- how things work
- future plans
- security notes

This file is the **quick codebase map**.

---

# 🌐 `public`

Static assets used by the desktop app.

---

# 🔗 How Everything Connects

Example:

> **“Open Discord.”**

```text
👤 User
 ↓
🎤 Microphone
 ↓
🧠 Qwen
 ↓
"open_app"
{ app: "Discord" }
 ↓
🔧 Eve tool / platform dispatch
 ↓
🖐️ ports.apps.open("Discord")
 ↓
⚡ electron-ports.ts
 ↓
🐧 Linux
 ↓
🎮 Discord opens
 ↓
↩️ Result
 ↓
🧠 Qwen
 ↓
🗣️ “Opening Discord.”
```

---

# 🧠 The 6 Things To Remember

```text
1. React       = Starfire's face
2. Electron    = trusted computer access
3. Eve         = agent runtime + tool discovery/execution
4. Qwen        = brain / decision maker
5. Tool        = what Starfire wants to do
6. Port        = how it actually does it
7. Eval        = proves it works
```

### One sentence

> **Starfire is a voice AI brain connected to real computer actions through tools and ports, with Electron providing trusted access and Eval checking that the whole system behaves correctly.** 🔥

---

# 🚀 Future

The architecture is designed to grow toward:

```text
Memory
   ↓
MCP
   ↓
Vision
   ↓
Better planning
   ↓
Multi-step tasks
   ↓
Background agents
   ↓
Personalization
   ↓
🤖 JARVIS-like Starfire
```

The important rule:

> **Add new capabilities without turning the whole system into one giant file.**