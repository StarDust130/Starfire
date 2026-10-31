# Starfire Architecture

This document describes Starfire as it exists in the repository today. It is
not a roadmap. Features that are planned but not wired are called out as such.

Starfire is a voice-first desktop companion built with Electron and React. A
realtime speech-to-speech model talks to the user, chooses from a fixed set of
capabilities, and those capabilities are executed by the trusted Electron main
process. A local SQLite database stores conversation history and long-term
memory. A separate Eve agent runtime exists in the repository, but it is not
yet part of the user-facing conversation flow.

---

## 1. Current shape

```text
                         +-----------------------------+
                         |        React renderer       |
                         |  VRM, wake word, microphone |
                         |  playback, voice controller |
                         +--------------+--------------+
                                        |
                                context-isolated IPC
                                        |
                         +--------------v--------------+
                         |      Electron main process  |
                         |                             |
                         |  RealtimeVoiceBridge        |
                         |  Memory (SQLite)            |
                         |  Device bridge (:17321)     |
                         |  Platform ports             |
                         |  Eve runtime (in-process)   |
                         +------+-------------+--------+
                                |             |
                     WebSocket  |             | local HTTP
                                v             v
                    EmpirioLabs realtime   Eve tools
                    (Qwen S2S model)       (agent/tools)
                                |
                                v
                         Linux desktop / apps
```

There are two runtimes in the tree:

1. **Realtime voice** - the only path a user can reach today. It is fully
   wired from wake word through provider, tool execution, and back to audio.
2. **Eve worker** - started inside Electron and given tool adapters, but no
   Starfire code invokes it. There is no `delegate_task` capability and no
   voice-to-Eve handoff.

The old documentation described both paths as complete. That was inaccurate.
The shared-capability design is real; the delegation workflow is not.

---

## 2. Process and trust boundaries

| Layer | Trust | Responsibilities |
| --- | --- | --- |
| React renderer | Untrusted UI | VRM scene, wake word, microphone capture, audio playback, voice state presentation |
| Preload | Narrow bridge | Only exposes `starfireDesktop` and `starfireVoice` IPC methods |
| Electron main | Trusted | Provider socket, tool dispatch, OS access, memory database, local bridge, Eve lifecycle |
| Device bridge | Trusted loopback | Token-authenticated HTTP boundary for Eve tools |
| Eve runtime | Local agent | Reasoning loop and tool adapters; no direct OS access |
| SQLite | Local data | Transcripts, memories, extraction jobs, operational state |

The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and
`sandbox: true`. It never receives filesystem, process, or shell APIs. Media
permission is the only permission granted.

Secrets stay in the main process (`EMPIRIOLABS_API_KEY`, `EXA_API_KEY`,
`STARFIRE_MEMORY_API_KEY`). The device bridge token is generated per launch
unless explicitly configured, and is inherited by Eve through the in-process
environment.

---

## 3. Startup and shutdown

`apps/desktop/electron/main.ts` owns the application lifecycle.

Startup order:

1. Acquire the single-instance lock.
2. Create the frameless, transparent, always-on-top window (280x350, bottom
   right). Load `http://127.0.0.1:1420` in development or the built renderer
   file in production.
3. Register the global shortcut `Super+Z`.
4. Initialize memory: open SQLite, run migrations, recover interrupted
   extraction jobs, build the context providers, and attach the transcript
   recorder. Failure here disables memory only; the app still starts.
5. Create one shared `AgentPorts` instance for the whole process.
6. Create the realtime voice bridge, register its IPC handlers, and warm the
   provider connection without sending audio.
7. Start the device bridge, then start the Eve runtime. The bridge must be
   listening before Eve starts because Eve tools call it over HTTP.

Shutdown reverses the order: dispose voice, stop the device bridge, stop Eve,
flush and shut down the memory orchestrator (6 second budget), close SQLite.

The window has no frame, is always on top, is skipped from the taskbar, and is
dragged manually by polling the cursor every 16 ms while the user drags.

---

## 4. Realtime voice path

### Activation

The renderer starts a conversation from one of three sources:

- Wake word `starfire` (local ONNX openWakeWord model).
- Clicking the character.
- `Super+Z`.

Activation stops the wake-word engine so only one component owns the
microphone, then starts `VoiceController`. The controller owns the microphone
pipeline, playback pipeline, state machine, timers, and reconnection behavior.

### Provider connection

`apps/desktop/electron/realtimeVoice.ts` maintains one WebSocket connection.

- Endpoint: `wss://api.empiriolabs.ai/v1/realtime?model=...`
- Override: `EMPIRIOLABS_REALTIME_URL`
- Model: `qwen3-8-omni-flash-realtime`
- Voice: `Tina`
- Audio: PCM16, 16 kHz input, 24 kHz output
- Turn detection: server VAD (`threshold 0.3`, `silence_duration_ms 400`)

The socket is warmed at app startup and reused across conversations. When the
provider sends `session.created`, the bridge sends one `session.update`
containing:

- the Starfire personality instructions,
- the Core Memory block,
- the continuity block,
- all function specs derived from the canonical capabilities.

The session becomes usable only after the provider acknowledges the update.
If Core Memory changed between activations, the bridge sends a fresh
`session.update` without reconnecting.

### Audio

The renderer captures base64 PCM16 frames and sends them to the main process.
The bridge rejects audio unless a session is active and configured, and drops
oversized frames (over 20,000 base64 characters). Provider audio deltas are
decoded and forwarded to the renderer for playback. Interrupting sends
`response.cancel`; a cancellation that does not settle within 1.5 seconds
closes the socket to clear stale provider state, and an inactive bridge then
schedules a reconnect.

### Tool calls

The model may emit one or more function calls during a response. Calls are
queued until `response.done`, then executed sequentially. This keeps argument
validation and side effects deterministic and prevents tool work from racing
the model's own completion event.

For each call the bridge:

1. Normalizes arguments to an object.
2. Handles `memory_search` locally against SQLite.
3. Otherwise calls `executeDeviceTool(ports, name, args)`.
4. Sends a `function_call_output` back to the provider.
5. Sends `response.create` for the spoken follow-up.

Batches are tagged with a connection number and activation id. If the user
interrupts, disconnects, or the activation changes, the batch aborts rather
than delivering stale results.

`end_session` is a normal capability. When it succeeds, the bridge waits for
the spoken goodbye response to finish, then emits `session-ended` after 1.5
seconds and deactivates. The provider socket stays warm.

### Deterministic voice commands

Some utterances never reach the model. After transcription, the main process
checks `voiceCommands.ts` for:

- **silence** - suppress all assistant audio, keep listening and tools active.
- **resume** - restore assistant audio.
- **stop** - cancel speech, deactivate, and return to wake-word listening.

These are exact-intent commands after filler handling, capped at 80 characters.

### Renderer state machine

`apps/desktop/src/voice/realtime/state.ts` defines nine states:

`idle`, `starting`, `connecting`, `listening`, `user-speaking`, `thinking`,
`assistant-speaking`, `closing`, `error`.

Transitions are table-driven; invalid transitions are no-ops. The controller
handles wake-word re-arm, microphone retries, idle timeout, goodbye grace,
barge-in, and a per-session reconnect limit of 20.

---

## 5. Capability model

`packages/contracts/src/capabilities.ts` is the single source of truth for
capability names, descriptions, JSON argument schemas, and kind.

There are 14 canonical capabilities:

| Capability | Kind | Purpose |
| --- | --- | --- |
| `open_app` | device | Launch an application |
| `close_app` | device | Gracefully close an application |
| `focus_app` | device | Bring an application forward |
| `open_file` | device | Open a file with its default app |
| `open_folder` | device | Open a folder in the file manager |
| `open_url` | device | Open a website in the default browser |
| `clipboard` | device | Read or write the clipboard |
| `system_info` | device | RAM, CPU, uptime, disk, battery, host |
| `web_search` | device | Search the web through Exa |
| `get_weather` | device | Current weather, optionally for a place |
| `window_control` | device | Focus, lower, minimize, maximize, restore |
| `current_date_time` | session | Local date, time, weekday, timezone |
| `memory_search` | session | Search saved memories and past chats |
| `end_session` | session | End the conversation |

Derived consumers:

- `functions.ts` produces `STARFIRE_FUNCTION_SPECS` and `STARFIRE_TOOL_NAMES`
  for the realtime model and eval.
- `agent/tools/*.ts` reuse the capability description and input schema.
- `dispatch.ts` executes device capabilities and validates enums at runtime.
- `eval` imports the same specs and dispatch.

`executeDeviceTool` is the shared execution boundary for device operations. It
validates required strings and enum values before touching a port, canonicalizes
window-action synonyms, and returns plain results or throws plain errors. It
also implements `current_date_time` and `end_session`, which are
conversation-local.

`memory_search` is the exception. Although marked `session`, it is not handled
by `dispatch.ts`. It is special-cased in `realtimeVoice.ts` and
`deviceBridge.ts` because it needs the memory database rather than OS ports.
This breaks the otherwise uniform dispatch story.

Internal compatibility names `clipboard_read` and `clipboard_write` are also
accepted by dispatch, but they are not canonical capabilities.

---

## 6. Platform ports

`packages/contracts/src/agent.ts` defines `AgentPorts`:

- `AppPort`: open, close, focus
- `FilePort`: open file, open folder
- `UrlPort`: open URL
- `ClipboardPort`: read, write
- `SystemPort`: info
- `WebPort`: search
- `WeatherPort`: current
- `WindowPort`: control

One ports instance is shared by voice and Eve, so both paths see the same app
state. Platform implementations live in
`apps/desktop/electron/agent/electron-ports.ts`.

Safety rules:

- Commands are executed with `spawn(binary, args)`, never through a shell.
- A denylist blocks privilege, shell, kill, shutdown, formatting, and
  permission-changing tools (`sudo`, `su`, `doas`, `rm`, `bash`, `sh`, `kill`,
  `systemctl`, `mkfs`, `dd`, `chmod`, etc.).
- File operations are restricted to paths inside the user's home directory,
  with symlink resolution.
- Applications are launched by alias-aware name matching.
- URLs are opened through `shell.openExternal`.
- Web search uses Exa with an 8 second timeout, at most 5 results, and 300
  character snippets.

Window control is KDE/KWin-specific. `kwin-windows.ts` talks to
`org.kde.KWin` over DBus using `gdbus`/`qdbus`, runs a temporary scripting
script, and polls for a feedback token. Other desktop environments are not
implemented.

---

## 7. Device bridge

`deviceBridge.ts` is a loopback HTTP server on `127.0.0.1:17321` used by Eve
tools.

- `POST /v1/tool`
- Header: `x-starfire-device-token`
- Max buffered body: 64 KiB; larger bodies are drained up to 512 KiB.
- Requests are fully read before any response is written, so 401/500 responses
  are deterministic.
- Authentication is always enabled. Token resolution: explicit test option,
  then `STARFIRE_DEVICE_TOKEN`, then a newly generated UUID for this launch.
  The generated token is written back to the process environment for the
  in-process Eve runtime and is never logged.
- `memory_search` is handled here directly; every other tool goes through
  `executeDeviceTool`.

Eve's client (`agent/lib/desktop.ts`) uses a 15 second timeout and the same
token header.

---

## 8. Eve worker

`agent/agent.ts` defines the Eve agent:

```ts
defineAgent({
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
});
```

`agent/instructions.md` contains the worker personality and tool behavior.
`agent/tools/*.ts` are thin adapters. Each adapter read the canonical
capability description and schema, then calls `agent/lib/desktop.ts`, which
POSTs to the device bridge.

`eve-runtime.ts` starts the Eve development host in-process by resolving
`eve/package.json` and importing its internal
`start-development-server.js`. It starts only if `agent/agent.ts` exists, and
its URL is logged. Starfire does not implement its own agent loop, tool
registry, or runner.

Current gap: nothing in Starfire sends a user request to Eve. The runtime
starts and the tools can reach the device bridge, but no voice pathway calls
Eve and no `delegate_task` capability exists. The Eve path is therefore
dormant in the product experience.

---

## 9. Memory and context

Memory is a local service owned by the Electron main process. It is implemented
in `apps/desktop/electron/memory/`.

### Storage

- Default database: `<userData>/memory/starfire.db`
- Override: `STARFIRE_MEMORY_DB_PATH`
- Disable: `STARFIRE_MEMORY_DISABLED=1`
- SQLite WAL, 5 second busy timeout, foreign keys enabled
- Schema version 3

Tables:

- `messages`: session id, per-session turn index, role, content, interrupted
  flag, timestamps, processed timestamp.
- `memories`: category, normalized key, content, importance 1-5, state
  (`active`, `superseded`, `archived`), provenance ids, timestamps.
- `memory_jobs`: durable extraction queue with attempts, error, and run-after.
- `memory_state`: durable operational state, currently account cooldown.

A unique index prevents replay of the same `(session_id, turn_index, role)`.
A partial unique index allows at most one active memory per
`(category, key)`.

### Write path

1. The voice bridge captures completed user transcripts and completed
   assistant responses through `VoiceTranscriptRecorder`.
2. A session id is created per activation. Provider `item_id` values are
   deduplicated exactly; a 1 second content window is the fallback.
3. Interrupted assistant turns are stored for provenance but excluded from
   extraction.
4. Explicit statements (name, preference patterns) are stored immediately and
   locally by `explicit.ts`, with negation and question guards.
5. All other completed turns are queued for background extraction.

### Extraction

`extraction.ts` is the only code that talks to a cloud model about memories.

- Base URL: `https://api.empiriolabs.ai/v1`
- Primary model: `glm-4-7-flash`
- Fallback: `qwen3-5-4b`
- Requires `STARFIRE_MEMORY_API_KEY`; without it extraction is disabled.
- Redaction runs before any turn leaves the machine.
- Strict JSON parsing, at most 12 drafts, 12 context turns, 45 second timeout.
- Rate limits: 20 requests/minute, 1.6M tokens/minute, 3 second minimum gap.
- Account-wide cooldown is persisted in SQLite and survives restarts.

`MemoryOrchestrator` is single-flight and is the only caller of the provider
and memory store. It drains the durable queue on:

- roughly 2 minutes of idle time after a completed turn,
- 40 or more pending turns (immediate),
- durable cooldown expiry,
- startup recovery.

Session endings do not trigger extraction.

### Retrieval

Three bounded context sources are available:

- **Core Memory**: up to 20 active memories and 1,200 characters, injected into
  the realtime session instructions.
- **Continuity**: up to 6 recent completed turns and 700 characters from the
  last 24 hours, excluding the live session.
- **Context/search**: up to 4 memories and 4 messages, 1,500 characters total.
  Search is token-AND over active memories and complete turns, redacted on
  read, with 5 memory and 5 message results by default.

Voice retrieval excludes the Core Memory rows already sent to the model and
the live session. The device bridge's memory search has no exclusions because
Eve never receives Core Memory.

The database is local but not encrypted at rest. Memory extraction sends
redacted conversation text to a cloud provider when configured.

---

## 10. Desktop UI and character

`apps/desktop/src/App.tsx` connects activation, wake word, microphone choice,
controller subscription, tool display, and the VRM scene. The scene displays
idle, listening, thinking, speaking, and sleeping states. A goodbye tool call
triggers the sleep animation for six seconds.

`apps/desktop/src/voice/` contains the wake engine, microphone selection,
realtime controller, PCM microphone/playback pipelines, and protocol parsing.
`apps/desktop/src/three/` contains pose, activity, reaction, drag, and
voice-animation logic.

The wake word threshold is currently `0.35` and is explicitly marked as a
temporary testing value. Package debug logging is enabled.

---

## 11. Evaluation

`eval/` runs the real realtime model against the same canonical capabilities
and dispatch through a mock OS.

- Dataset categories: tool, args, no-tool, multi-turn, multi-tool, ambiguity,
  failure, loop, safety, injection, leakage, session, quality.
- Cases are authored through `S()`, `U()`, matrices, and seed groups.
- `driver.ts` opens a real provider WebSocket, sends prompt turns, records
  function calls, and executes them against `MockOS`.
- `starfire.ts` imports source files directly, so evaluation cannot silently
  use a stale build.
- Deterministic graders own pass/fail. They check tool sequence, arguments,
  forbidden tools, counts, state changes, response constraints, and
  injection/leakage.
- DeepEval judging is optional and non-gating. It requires an explicitly
  configured OpenAI-compatible judge endpoint; the agent's realtime S2S model
  has no chat interface, so there is no silent fallback.
- Missing API key or provider failure marks cases `BLOCKED`; it never invents a
  result.
- Reports go to `eval/reports/latest.json`, `.csv`, `.html`, with immutable
  per-run directories under `eval/runs/<timestamp>/`.

The suite evaluates the realtime path. It does not evaluate Eve, because there
is no wired Eve conversation path to evaluate.

Common commands:

```bash
pnpm check
pnpm build
pnpm eval
pnpm eval:fast
pnpm eval:security
pnpm eval:case C017
pnpm eval:selftest
```

---

## 12. End-to-end examples

### "Open Discord"

```text
wake word / click / Super+Z
  -> VoiceController starts microphone
  -> renderer sends PCM16 frames to main
  -> provider emits function call open_app({ app: "Discord" })
  -> response.done flushes the tool batch
  -> executeDeviceTool(ports, "open_app", ...)
  -> electron-ports spawns Discord (alias-aware, no shell)
  -> function_call_output sent to provider
  -> response.create
  -> provider audio delta
  -> renderer plays audio; VRM speaks
```

### "What did I tell you about my project?"

```text
provider emits memory_search({ query: "project" })
  -> realtimeVoice special-cases the call
  -> MemorySearch token-AND query over active memories and past turns
  -> results redacted, formatted, returned as function output
  -> provider answers from the returned context
```

### "Goodbye"

```text
provider emits end_session()
  -> dispatch returns { endSession: true }
  -> bridge waits for the goodbye response.done
  -> emits session-ended after 1.5 s
  -> controller deactivates, returns to wake-word listening
  -> provider socket stays warm
```

### Startup

```text
single-instance lock
  -> window + Super+Z
  -> memory DB, migrations, orchestrator recovery
  -> shared ports
  -> realtime bridge + IPC + warm provider socket
  -> device bridge (:17321)
  -> Eve runtime
```

---

## 13. Design strengths

- One canonical capability definition drives voice specs, Eve adapters,
  execution validation, and eval.
- Tool execution is separated from OS access by a small port interface.
- The renderer is genuinely isolated; privileged work stays in main.
- The device bridge is loopback-only and token-protected by default.
- Memory writes are durable before extraction, replay-protected, bounded,
  redacted before network use, and rate limited with persistent cooldown.
- Memory failure degrades gracefully instead of preventing app startup.
- Eval is honest: a missing key or provider error produces `BLOCKED`, not a
  fabricated pass.
- Provider reconnection, cancellation, stale tool-batch guards, and wake-word
  microphone ownership are handled explicitly.

---

## 14. Known limitations and inconsistencies

1. **Eve is not connected.** It starts in-process and has tools, but no
   Starfire code invokes it. There is no `delegate_task` capability. The
   "deep path" described by older docs does not exist in the product flow.
2. **Eve cannot search memory.** `deviceBridge.ts` has a `memory_search`
   handler, but `agent/tools/` has no matching adapter. The two-path memory
   sharing claim is only partially implemented.
3. **Documentation drift.** The README and older architecture/codebase docs
   claim screen awareness, computer use, tasks/reminders, browser tools,
   memory save/forget, and agent workflows that are not implemented.
   `docs/v1.md` is a vision document and should be read as such.
4. **Dispatch is not quite universal.** `memory_search` bypasses
   `executeDeviceTool` and is duplicated in the voice bridge and device
   bridge.
5. **No confirmation policy.** Capabilities execute immediately. The model is
   told to ask before consequential actions, but no platform-level permission
   or confirmation system enforces that.
6. **Platform coverage.** Window control only works on KDE/KWin. App
   launch/close/focus are alias and process-name heuristics, not a portable
   desktop API.
7. **Memory privacy.** The SQLite file is unencrypted. Extraction sends
   redacted text to a cloud model. Pattern-based redaction is best effort.
8. **Controller size.** `controller.ts` is roughly 1,800 lines and combines
   media pipelines, state transitions, timers, reconnect policy, echo
   handling, and UI events. It is the highest-complexity file in the app.
9. **Wake word tuning.** Detection threshold `0.35` and debug logging are
   temporary.
10. **Version mismatch.** Package engines declare Node `24.x`; CI uses Node
    `26.10.0`.
11. **Stale side docs.** `apps/desktop/electron/README.md` describes a
    patching workflow that is not part of the current app. `AGENTS.md` and
    `CLAUDE.md` are empty.
12. **Eve `end_session` is not meaningful.** The device bridge would return a
    result but does not end the realtime session; only the voice bridge acts
    on that flag.

---

## 15. Security summary

```text
model
  -> fixed capability name + JSON arguments
  -> canonical schema / enum validation in dispatch
  -> platform port
  -> no shell, denylisted binaries, home-only file access
  -> OS
```

The model never receives a filesystem, shell, or process API. It can only ask
for a named capability with arguments. The platform decides how that capability
is performed and rejects malformed or forbidden requests. Secrets and the
device bridge token remain in the main process.
