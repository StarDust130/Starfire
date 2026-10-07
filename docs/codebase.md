# 🔥 Starfire — Codebase Map

> **Forget the code? Read this file first.**
>
> Starfire is a realtime desktop AI companion.
> **Qwen thinks → Registry routes → Tools act → Ports touch the computer → Electron keeps it safe.**

---

## 🧠 The Whole System

```text
🎤 User
  ↓
🖥️ React UI
  ↓
🔌 Electron / Realtime Voice
  ↓
🧠 Qwen Realtime
  ↓
🧰 AgentRunner
  ↓
📦 Tool Registry
  ↓
🔧 Tool
  ↓
🖐️ Port
  ↓
💻 OS / Web / External Service
  ↓
↩️ Result → Qwen → Starfire speaks
```

### Easy rule

**Qwen decides WHAT.**  
**Tool describes WHAT.**  
**Port knows HOW.**  
**Electron gives trusted access to the computer.**  
**Eval checks whether everything worked correctly.**

---

# 📁 Project Structure

```text
Starfire/
├── apps/
│   ├── desktop/
│   └── core/
│
├── packages/
│   ├── contracts/
│   └── tools/
│
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
- sends them to AgentRunner
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

# 🧠 `apps/core`

Small reusable agent logic.

### `agent/agent-runner.ts`

Controls tool execution.

It:
- receives tool calls
- filters bad calls
- runs tools
- catches failures
- returns results

Think:

> **“Tool traffic controller.”**

### `index.ts`
Exports the core package.

---

# 📜 `packages/contracts`

Shared language between everything.

### `agent.ts`

Defines important shared types:

- `ToolCall`
- `ToolResult`
- `ToolManifest`
- `ToolName`
- `AgentPorts`
- port interfaces

Think:

> **“Everyone agrees on the same rules and shapes.”**

Example:

```text
Tool says → I need AppPort

Electron says → I provide AppPort
```

---

# 🧰 `packages/tools`

The actual tool layer.

## Main pieces

### `tools/`
The 13 Starfire tools.

Examples:

```text
open_app
close_app
focus_app
open_folder
open_file
open_url
clipboard
system_info
web_search
get_weather
window_control
current_date_time
end_session
```

Each tool mainly has:

### `manifest`
Tells Qwen:

> “I am this tool. Here is what I do and what arguments I need.”

### `handle`
Runs when the tool is selected.

Usually:

```text
handle()
   ↓
port.someAction()
```

So the tool does not contain all OS-specific code.

---

### `registry.ts`

The **tool manager**.

It:
- stores tools
- gives Qwen the tool definitions
- checks arguments
- finds the requested tool
- runs the tool
- handles timeout/errors

Think:

> **“Qwen asked for this tool. Do we have it? Are the arguments okay? Run it.”**

### `defaults.ts`

Creates the default Starfire registry with all current tools.

### `validate.ts`

Checks tool arguments.

Example:

```text
app must be a string ✅
missing app ❌
```

### `policy.ts`

Safety policy definitions.

Defines ideas like:

```text
low
medium
high
critical
```

and confirmation requirements.

> ⚠️ **Current note:** policy metadata exists, but the registry does not fully enforce it yet.

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
🧰 Registry
 ↓
🔧 open_app.handle()
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
3. Qwen        = brain / decision maker
4. Registry    = tool manager
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