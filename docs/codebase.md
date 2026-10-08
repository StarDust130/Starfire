# 🔥 Starfire — Codebase Map

> **Forget the code? Read this file first.**
>
> Starfire is a personal desktop AI companion.
> **Starfire talks → capabilities act → ports touch the computer → Electron provides trusted access → Eve handles deep background work → Eval checks everything.**

---

# 🧠 The Whole System

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
                       💪 Platform Layer
                              │
                         💻 Computer
```

The important idea:

```text
⭐ Starfire = the product
⚡ Voice = fast path
🧠 Eve = background worker
🧩 Capability = what Starfire can do
💪 Port = how it touches the platform
🔐 Electron = trusted desktop access
🧪 Eval = proves it works
```

---

# 📁 Project Structure

```text
Starfire/
├── agent/                       🧠 Eve worker
├── apps/
│   └── desktop/                 🖥️ Desktop application
├── packages/
│   └── contracts/               📜 Shared capabilities + platform contracts
├── eval/                        🧪 Evaluation
├── docs/                        📚 Documentation
└── public/                      🖼️ Assets
```

---

# 🖥️ `apps/desktop`

The actual Starfire desktop application.

```text
apps/desktop/
├── src/                         🎨 React UI
└── electron/                    🔐 Trusted desktop layer
```

---

# 🎨 `apps/desktop/src`

This is Starfire's **face and user interface**.

## `App.tsx`

Main React controller.

Connects things such as:

```text
🎤 Voice
👂 Wake word
🎙️ Microphone
🎭 UI state
🌌 Starfire scene
```

Think:

> **"What is Starfire doing right now?"**

---

## `App.css`

Main desktop UI styling.

---

## `main.tsx`

React application entry point.

Starts the frontend.

---

## `components/`

Normal React UI components.

Use this folder for reusable visual components.

---

## `voice/`

Frontend voice-related logic.

Handles things such as:

```text
🎤 Microphone
👂 Wake word
🔊 Audio playback
⚡ Voice state
🔄 Voice session UI
```

Think:

> **"How does the Starfire UI handle voice?"**

---

## `three/`

Starfire's 3D character.

Handles:

```text
🎭 Character model
✨ Animation
😊 Expressions
🎙️ Voice animation
🖱️ Interaction
🎬 Activities
```

Think:

> **"Starfire's body."**

---

## `types/`

Frontend-specific TypeScript types.

---

# 🔐 `apps/desktop/electron`

This is Starfire's **trusted desktop side**.

React should not directly control the operating system.

Electron provides access to privileged capabilities.

```text
React
  ↓
safe IPC
  ↓
Electron
  ↓
Operating System
```

---

# ⚙️ `apps/desktop/electron/main.ts`

Main Electron process.

Responsible for starting Starfire's desktop process and connecting the major
desktop services.

It creates the shared platform ports and starts:

```text
⚡ Realtime voice
🌐 Device bridge
🧠 Eve runtime
🖥️ Desktop window
```

Think:

> **"Start Starfire's trusted desktop runtime."**

---

# 🔑 `apps/desktop/electron/preload.ts`

Safe bridge between React and Electron.

Only exposes approved functionality to the renderer.

Think:

> **"Security gate between UI and Electron."**

---

# ⚡ `apps/desktop/electron/realtimeVoice.ts`

Starfire's **fast realtime execution path**.

It connects Starfire to the realtime voice model.

Main responsibilities:

```text
🎤 Receive / send realtime audio
🧠 Receive model events
🛠️ Receive capability calls
⚡ Execute basic capabilities quickly
📤 Send capability results back
🔊 Continue conversation
```

Important:

**Realtime voice does not need to run through Eve.**

Instead:

```text
Voice
  ↓
Canonical capability
  ↓
Shared dispatch
  ↓
Electron ports
  ↓
OS
```

Think:

> **"Fast voice ↔ Starfire capabilities."**

---

# 🌐 `apps/desktop/electron/realtimeProtocol.ts`

Defines the realtime session configuration.

Includes things such as:

```text
🧠 Model
🎙️ Voice
📜 System instructions
🧩 Realtime capability specs
⚙️ Session settings
```

Think:

> **"Rules for the realtime voice model."**

---

# 🌉 `apps/desktop/electron/deviceBridge.ts`

A small local HTTP bridge used by Eve to reach Starfire's desktop capabilities.

Default address:

```text
http://127.0.0.1:17321
```

Flow:

```text
🧠 Eve
  ↓
agent/lib/desktop.ts
  ↓
HTTP /v1/tool
  ↓
deviceBridge.ts
  ↓
executeDeviceTool()
  ↓
Electron ports
  ↓
💻 Computer
```

Optional authentication:

```text
STARFIRE_DEVICE_TOKEN
```

Important:

The device bridge is **Eve's transport boundary**.

Realtime voice can call the same shared dispatch directly without going through
the HTTP bridge.

Think:

> **"Local bridge that lets Eve reach Starfire's computer capabilities."**

---

# 🧠 `apps/desktop/electron/eve-runtime.ts`

Starts Eve inside Starfire's desktop runtime.

Starfire uses Eve as an **internal background agent runtime**.

There is no need for the user to interact with an Eve CLI/TUI.

Think:

> **"Run the Eve worker inside Starfire."**

---

# 💪 `apps/desktop/electron/agent`

Platform-specific implementations.

This is where Starfire's capabilities eventually reach the real operating system.

---

## `electron-ports.ts`

The main **OS hands**.

Implements platform ports such as:

```text
📱 Applications
📂 Files
🌐 URLs
📋 Clipboard
💻 System information
🪟 Windows
🌐 Web
🌦️ Weather
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

Think:

> **"How Starfire actually touches the computer."**

---

## `kwin-windows.ts`

KDE/KWin-specific window implementation.

Handles things such as:

```text
🎯 Focus
➖ Minimize
⬜ Maximize
↩️ Restore
⬇️ Lower
```

This is platform-specific implementation code.

Later, Windows/macOS can have their own implementations behind the same
platform interfaces.

---

## `exa-search.ts`

Web search adapter.

```text
web_search
    ↓
Exa adapter
    ↓
Exa API
```

Keeps the external API integration separate from the capability itself.

---

# 🧠 `agent/`

This is Starfire's **Eve background worker**.

```text
agent/
├── agent.ts
├── instructions.md
├── lib/
└── tools/
```

Eve owns the agent runtime, reasoning loop, tool discovery, and background
agent behavior.

Starfire owns the actual desktop capabilities and platform layer.

---

# `agent/agent.ts`

Defines the Eve agent.

Example:

```ts
defineAgent({
  model: "...",
  reasoning: "high",
})
```

The file is intentionally small.

Eve owns the agent loop.

Starfire does not need a custom `AgentRunner`, `ToolRegistry`, or custom
agent orchestration layer.

Think:

> **"What Eve agent is Starfire using?"**

---

# `agent/instructions.md`

Instructions for the Eve worker.

This tells Eve things such as:

```text
🧠 How to behave
🛠️ How to use Starfire capabilities
🤝 How to work on delegated tasks
🔐 Safety expectations
```

Eve is not the main personality the user talks to.

Starfire is.

---

# `agent/tools/`

One Eve capability adapter per file.

Examples:

```text
open_app.ts
close_app.ts
focus_app.ts

open_file.ts
open_folder.ts
open_url.ts

clipboard.ts
system_info.ts

web_search.ts
get_weather.ts

window_control.ts
```

The important rule:

> **Eve tools are thin adapters.**

They should not contain large operating-system implementations.

Their job is mainly:

```text
🧠 Eve
   ↓
Eve capability adapter
   ↓
🧩 Starfire capability
   ↓
Shared dispatch
   ↓
💪 Platform ports
```

---

# 📜 `packages/contracts`

This is the **shared language of Starfire**.

It contains the canonical capability definitions, shared dispatch, and
platform contracts.

```text
packages/contracts/src/
├── capabilities.ts
├── dispatch.ts
├── functions.ts
└── agent.ts
```

---

# 🧩 `packages/contracts/src/capabilities.ts`

The **ONE canonical source of truth** for Starfire capabilities.

Each capability defines things such as:

```text
name
description
arguments / schema
metadata
```

Example:

```text
open_app
close_app
open_file
open_folder
open_url
clipboard
system_info
web_search
get_weather
window_control
```

Both Voice and Eve use these definitions.

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

This prevents duplicated capability definitions from drifting apart.

---

# 🚦 `packages/contracts/src/dispatch.ts`

Shared capability execution.

Main function:

```text
executeDeviceTool(ports, tool, args)
```

The dispatch layer connects a capability to the platform ports.

```text
⚡ Voice ───────┐
               ├──→ executeDeviceTool()
🧠 Eve ────────┘
                      ↓
                 Platform ports
                      ↓
                    💻 OS
```

This is the important shared boundary.

---

# 🎤 `packages/contracts/src/functions.ts`

Realtime model-facing capability specifications.

These are **derived from `capabilities.ts`**.

Used by:

```text
⚡ Realtime voice
🧪 Eval
```

There should not be a separate manually maintained copy of the capability
schema here.

Think:

> **"Convert Starfire's canonical capabilities into the format the realtime model needs."**

---

# 💪 `packages/contracts/src/agent.ts`

Defines Starfire's platform contracts and ports.

Examples:

```text
AgentPorts
AppPort
FilePort
UrlPort
ClipboardPort
SystemPort
WebPort
WeatherPort
WindowPort
```

These describe **what the platform can provide** without tying the agent
logic to Linux-specific code.

Think:

> **"The interface between capabilities and the real platform."**

---

# 🔗 Capability Flow

A capability should follow this shape:

```text
🧠 Model
   ↓
🧩 Capability
   ↓
🚦 Shared dispatch
   ↓
💪 Port
   ↓
🔐 Electron implementation
   ↓
💻 Operating System
```

Example:

```text
open_app
   ↓
executeDeviceTool()
   ↓
ports.apps.open()
   ↓
electron-ports.ts
   ↓
Linux
   ↓
Discord opens
```

---

# 🧪 `eval`

Starfire's **testing laboratory**.

It tests real model behavior using controlled computer state.

```text
Test case
   ↓
⚡ Voice / 🧠 Eve
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

---

# `eval/dataset/`

Test cases.

Example:

> "Open Discord"

Expected:

```text
open_app
app = Discord
```

---

# `eval/driver.ts`

Connects the evaluation system to the realtime model.

---

# `eval/runner.ts`

Runs test cases.

---

# `eval/grade.ts`

Checks whether the result is correct.

Can check:

```text
🎯 Capability selection
🧩 Arguments
🛡️ Safety
💻 State changes
✅ Task completion
💬 Response quality
```

---

# `eval/mock/`

Fake computer state.

Lets Starfire test capability behavior without touching the real machine.

---

# `eval/provider.ts`

Model/provider configuration for evaluation.

---

# `eval/quota.ts`

Protects API usage and budget.

---

# `eval/report.ts`

Builds the final evaluation scorecard.

---

# `eval/render.ts` / `eval/html.ts`

Creates human-readable reports.

---

# `eval/cli.ts`

Evaluation commands.

Examples:

```bash
pnpm eval
pnpm eval:case C017
pnpm eval:selftest
```

---

# `eval/starfire.ts`

Connects the evaluation system to Starfire's canonical capabilities and
shared execution layer.

---

# `eval/types.ts`

Shared evaluation-specific TypeScript types.

---

# 📚 `docs`

Documentation about the project.

Use this folder for:

```text
🏗️ Architecture
🧠 Design decisions
🔐 Security
📖 How things work
🗺️ Future plans
```

Important files include:

```text
docs/architecture.md
docs/codebase.md
```

This file is the **quick map of where the code lives**.

---

# 🌐 `public`

Static assets used by the desktop application.

---

# 🔄 Simple Request: Basic Task

Example:

> **"Open Discord."**

```text
👤 User
   ↓
🎤 Microphone
   ↓
⚡ Realtime Voice Model
   ↓
⭐ Starfire
   ↓
open_app()
   ↓
🧩 Canonical Capability
   ↓
🚦 executeDeviceTool()
   ↓
💪 Electron Port
   ↓
💻 Linux
   ↓
Discord opens
   ↓
✅ Result
   ↓
⚡ Realtime Voice
   ↓
🗣️ "Discord is open."
```

---

# 🔄 Complex Request: Background Task

Example:

> **"Research the best AI companies for me and make a shortlist."**

```text
👤 User
   ↓
🎤 Voice
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
📊 Task Progress
   ↓
✅ Result
   ↓
⭐ Starfire
   ↓
🎤 Explains result to user
```

If Eve needs user input:

```text
🧠 Eve
   ↓
Needs user input
   ↓
⭐ Starfire
   ↓
asks user
   ↓
👤 User answers
   ↓
🧠 Eve continues
```

The user never needs to talk directly to Eve.

---

# 🧠 Memory + Context — Future

Memory and context are Starfire services, not Eve-only features.

Future structure:

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

One shared memory source should be used by both execution paths.

This keeps Starfire's knowledge about the user consistent.

---

# 👀 Screen Awareness — Future

Screen awareness becomes another shared Starfire capability.

```text
👀 Screen Awareness
        ↓
🧩 Starfire capability
        ↓
   ┌────┴─────┐
   ↓          ↓
 Voice       Eve
```

Small questions can be handled by Voice.

Large screen-based tasks can be delegated to Eve.

---

# 🖐️ Computer Use — Future

Computer use follows the same capability architecture.

```text
🖐️ Computer Use
       ↓
🧩 Starfire capability
       ↓
💪 Platform layer
       ↓
💻 Operating System
```

Both Voice and Eve can use the same computer capabilities.

---

# 🧠 Skills — Future

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

Skills are agent knowledge/procedure.

Capabilities are Starfire's actual powers.

---

# 🔐 Safety

Starfire should never give the model unrestricted access to the computer.

Instead:

```text
🧠 Model
   ↓
🧩 Explicit capability
   ↓
🔐 Permission / policy
   ↓
💪 Platform
   ↓
💻 Computer
```

Examples:

```text
✅ Open application
✅ Open file
✅ Read clipboard

⚠️ Delete important files
⚠️ Send messages
⚠️ Make purchases
⚠️ Change sensitive system settings
```

Sensitive operations can later require confirmation or stronger permissions.

---

# 🧠 The 7 Things To Remember

```text
1. ⭐ Starfire
   The product and the user-facing companion.

2. ⚡ Realtime Voice
   The fast path for conversation and immediate actions.

3. 🧠 Eve
   The background worker for complex / long-running work.

4. 🧩 Capability
   What Starfire can do.

5. 💪 Port
   The interface used to perform that capability on a platform.

6. 🔐 Electron
   The trusted desktop process that provides privileged access.

7. 🧪 Eval
   Tests whether the whole system actually works.
```

---

# 🚀 The Core Architecture

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
                     🧩 Shared Capabilities
                              ↓
                       🚦 Shared Dispatch
                              ↓
                          💪 Ports
                              ↓
                         🔐 Electron
                              ↓
                      💻 Operating System
```

---

# 🌌 The Future

Starfire grows by adding capabilities and services **on top of the same
foundation**:

```text
V1.0  🏗️ Foundation
        ↓
V1.1  🧠 Memory
        ↓
V1.2  🧩 Context Engine
        ↓
V1.3  👀 Screen Awareness
        ↓
V1.4  🖐️ Computer Use
        ↓
V1.5  ⏰ Tasks + Reminders
        ↓
V1.6  🤖 Proactive Agent
        ↓
V1.7  ❤️ Personality + Continuity
        ↓
V1.8  🏠 Local LLM + Model Router
        ↓
V1.9  🧪 Massive Eval
        ↓
V1.10 ✨ JARVIS Polish
```

The architecture should remain simple as these features are added.

---

# 🌌 Final Mental Model

```text
⭐ Starfire
    = companion + coordinator

⚡ Voice
    = fast path

🧠 Eve
    = background worker

🧩 Capabilities
    = Starfire's powers

💪 Ports
    = platform interface

🔐 Electron
    = trusted computer access

🧠 Memory
    = what Starfire remembers

🧩 Context
    = what Starfire needs right now

🧪 Eval
    = proof that Starfire works
```

> **🌌 Starfire is the companion.**
>
> **🧠 Eve is the worker.**
>
> **🛠️ Capabilities are the hands.**
>
> **💪 Ports connect those hands to the platform.**
>
> **🔐 Electron protects the computer boundary.**
>
> **🧪 Eval makes sure the whole thing actually works.**

---

# 🔥 One Sentence

> **Starfire is a personal AI companion with a fast realtime voice path,
> a deep background worker powered by Eve, and one shared capability layer
> that safely connects both to the real computer.**