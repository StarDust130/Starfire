# Starfire Codebase Map

This is the practical map of the repository: where code lives, what each file
owns, which constants matter, and which invariants must not be broken. Read
`docs/architecture.md` first for the system view.

Starfire is a pnpm monorepo. The desktop app is Electron + React. The shared
contracts package defines capabilities and platform ports. Evaluation imports
the real source and runs the real realtime model against a mock OS.

---

## 1. Repository layout

```text
starfire/
├── agent/                        Eve worker definition and tool adapters
├── apps/desktop/
│   ├── src/                      React renderer, VRM, voice client
│   ├── electron/                 Trusted main process and OS ports
│   ├── scripts/dev-electron.mjs  Development launcher
│   └── electron-dist/            Generated main/preload build (dev)
├── packages/contracts/src/       Shared capability and port contracts
├── eval/                         Live-model evaluation harness
├── docs/                         Architecture, codebase, roadmap
├── public/                       Screenshots and wake-word assets
├── scripts/                      Repository scripts
├── .github/workflows/ci.yml      GitHub Actions check
├── biome.json                    Formatting and lint rules
├── lefthook.yml                  Git hooks
├── pnpm-workspace.yaml           Workspace packages
└── package.json                  Root scripts and dependencies
```

Workspace packages:

- `@starfire/contracts` in `packages/contracts`
- `desktop` in `apps/desktop`
- `@starfire/eval` in `eval`

---

## 2. Commands

```bash
pnpm dev            # Vite + compiled Electron main; loads apps/desktop/.env
pnpm check          # format check, lint, typecheck, all tests, eval selftest
pnpm build          # contracts build + Electron TypeScript build
pnpm verify         # check + build
pnpm eval           # live realtime-model evaluation
pnpm eval:fast      # first 40 cases
pnpm eval:security  # safety, injection, leakage categories
pnpm eval:regression # compare against eval/reports/latest.json
pnpm eval:case C017 # one case
pnpm eval:tools     # tool-focused cases
pnpm eval:ui        # UI-focused cases
pnpm eval:voice     # voice-focused cases
pnpm eval:selftest  # dataset/harness tests only
pnpm format         # write formatting
```

Development flow (`scripts/dev-electron.mjs`):

1. Load `apps/desktop/.env`; shell variables win.
2. Build `@starfire/contracts`.
3. Compile `electron/` to `electron-dist/` with a generated CommonJS
   `package.json`.
4. Start Vite on `127.0.0.1:1420`.
5. Start Electron with `STARFIRE_DEV_SERVER_URL`.
6. On Wayland, launch Electron with `--ozone-platform=x11`.

---

## 3. Shared contracts

### `packages/contracts/src/capabilities.ts`

The single source of truth. `STARFIRE_CAPABILITIES` is data, not a registry.
Each entry has `name`, `description`, `kind` (`device` or `session`), and a
JSON-schema-like `parameters` object. `getStarfireCapability(name)` throws on
unknown names. `WINDOW_ACTION_SYNONYMS` canonicalizes action aliases.

Consumers:

- `functions.ts` for realtime function specs.
- `agent/tools/*.ts` for descriptions and schemas.
- `dispatch.ts` for runtime enum validation.
- `eval` for tool names and grading.

### `packages/contracts/src/functions.ts`

Derives `STARFIRE_FUNCTION_SPECS` and `STARFIRE_TOOL_NAMES` from the canonical
capabilities. Do not add tool definitions here.

### `packages/contracts/src/agent.ts`

Defines `AgentPorts` and the per-domain port interfaces: apps, files, URLs,
clipboard, system, web, weather, windows. This is the boundary between the
agent layer and the OS.

### `packages/contracts/src/dispatch.ts`

`executeDeviceTool(ports, tool, args)` is the shared execution layer.

- Validates required strings and enum values from the canonical schemas.
- Normalizes window actions through `WINDOW_ACTION_SYNONYMS`.
- Implements `current_date_time` and `end_session` locally.
- Accepts internal `clipboard_read`/`clipboard_write` names in addition to the
  canonical `clipboard`.
- Does not handle `memory_search`; that is special-cased in the voice bridge
  and device bridge.

### `packages/contracts/src/index.ts`

Re-exports all contracts.

---

## 4. Electron main process

### `apps/desktop/electron/main.ts`

Application lifecycle and wiring.

- Enforces a single instance.
- Creates a frameless, transparent, always-on-top 280x350 window, bottom
  right, skipped from the taskbar.
- Registers `Super+Z` and forwards it as `starfire:global-listen`.
- Opens the memory database and builds the context providers.
- Creates one shared `AgentPorts` instance.
- Constructs `RealtimeVoiceBridge` with the transcript recorder, Core Memory,
  memory search, and continuity callbacks.
- Warms the realtime provider before user activation.
- Starts the device bridge, then the Eve runtime.
- Handles drag by polling the cursor every 16 ms.
- On quit, disposes voice, bridge, Eve, orchestrator, and database in order.

Memory initialization is deliberately dynamic (`import("./memory/index.js")`);
a broken database disables memory without killing the app.

### `apps/desktop/electron/preload.ts`

Exposes two allowlisted APIs through `contextBridge`:

- `starfireDesktop`: `isElectron`, drag start/end, global-listen callback.
- `starfireVoice`: start, send audio, interrupt, stop, log, event/audio
  subscriptions.

The renderer has no direct Node, filesystem, process, or shell access.

### `apps/desktop/electron/realtimeVoice.ts`

Owns one provider WebSocket across activations.

Key behavior:

- Warmup, activation, deactivation, hard dispose.
- Rejects audio unless active and configured.
- Handles `session.created` by sending one `session.update` with instructions,
  Core Memory, continuity, and all function specs.
- Handles `session.updated` as the "session ready" signal.
- Queues function calls until `response.done`, then executes sequentially.
- Sends `function_call_output` then `response.create`.
- Special-cases `memory_search` against the local database.
- Marks `end_session`, waits for the goodbye response, then deactivates after
  1.5 seconds.
- Handles deterministic commands from completed input transcripts:
  `silence`, `resume`, `stop`.
- Guards tool batches with connection id and activation id.
- Reconnects with exponential backoff only while inactive.
- Cancels in-flight responses with a 1.5 second timeout, then reconnects if the
  provider does not settle.

Constants: connect timeout 5 s, cancel timeout 1.5 s, reconnect base 500 ms,
reconnect maximum 30 s.

### `apps/desktop/electron/realtimeProtocol.ts`

Provider constants and wire format.

```text
model             qwen3-8-omni-flash-realtime
voice             Tina
input             16000 Hz PCM16
output            24000 Hz PCM16
VAD threshold     0.3
VAD silence       400 ms
```

Also exports `STARFIRE_INSTRUCTIONS`, `parseServerEvent`, and builders for
session updates, audio appends, responses, cancellations, conversation items,
and function outputs. The instructions cover language mirroring, continuity,
honesty, memory search, silent mode, tool use, and the goodbye rule.

### `apps/desktop/electron/voiceCommands.ts`

Deterministic silence/resume/stop detection. Filler words are stripped; the
remaining phrase must match a command; input is capped at 80 characters.
These commands are never sent to the model.

### `apps/desktop/electron/deviceBridge.ts`

Loopback HTTP bridge for Eve tools.

- Listens on `127.0.0.1:17321`.
- Only `POST /v1/tool`.
- Requires `x-starfire-device-token`.
- Token order: explicit test option, `STARFIRE_DEVICE_TOKEN`, generated UUID.
- Generated token is stored back in `process.env` for the in-process Eve
  runtime and is never logged.
- Max body 64 KiB; bounded drain to 512 KiB before error responses.
- Reads the whole body before responding so 401/500 responses are
  deterministic.
- Handles `memory_search` directly; all other tools call
  `executeDeviceTool`.

### `apps/desktop/electron/eve-runtime.ts`

Starts the Eve development server in-process by resolving `eve/package.json`
and importing its internal `start-development-server.js`. Root is the
repository root. Skips when `agent/agent.ts` is absent. Logs the server URL.
This is lifecycle infrastructure only; no Starfire code sends requests to it.

### `apps/desktop/electron/agent/electron-ports.ts`

The real OS implementations behind `AgentPorts`.

- App launch/close/focus by alias and process-name heuristics.
- File and folder opening restricted to the home directory after realpath
  resolution.
- Clipboard read/write.
- System information: memory, CPU, uptime, disk, battery, host.
- Exa web search.
- Weather lookup.
- URL opening through `shell.openExternal`.
- KWin window control.

Safety: never uses a shell; uses `spawn(binary, args)`; blocks a denylist of
privilege, shell, kill, shutdown, formatting, and permission-changing tools;
blocks app names that resolve to denylisted binaries.

### `apps/desktop/electron/agent/kwin-windows.ts`

KDE/KWin DBus implementation. Detects `gdbus` or `qdbus`, installs a temporary
script named `starfire_windows`, performs `focus`, `lower`, `minimize`,
`maximize`, or `restore`, and polls for a feedback token. Only KDE is
supported.

### `apps/desktop/electron/agent/exa-search.ts`

Exa search adapter: `https://api.exa.ai/search`, `EXA_API_KEY`, 8 second
timeout, at most 5 results, 300 character snippets. Main process only.

### `apps/desktop/electron/agent/tool-error.ts`

Small shared error formatting helper for tool failures.

---

## 5. Memory subsystem

All files are in `apps/desktop/electron/memory/`.

### Public entry

`index.ts` exports the supported API. Main imports this module dynamically.

### `config.ts`

- `MEMORY_DIR_NAME = "memory"`
- `MEMORY_DB_FILE_NAME = "starfire.db"`
- `STARFIRE_MEMORY_DB_PATH` overrides the path.
- `STARFIRE_MEMORY_DISABLED` disables memory completely.
- Default path: `<userData>/memory/starfire.db`.

### `database.ts`

Opens SQLite with `node:sqlite`. Enables WAL, `busy_timeout` (default 5 s), and
foreign keys. Runs migrations. Returns `null` when memory is disabled.
Provides non-reentrant `withTransaction()` using `BEGIN IMMEDIATE`.

### `migrations.ts`

`LATEST_SCHEMA_VERSION = 3`.

- v1: `messages`, `memories`, `memory_jobs` tables and indexes.
- v2: at most one active memory per `(category, key)`.
- v3: `memory_state` key/value table for durable operational state.

Migrations are transactional and idempotent. Never edit an applied migration;
add a new one.

### `messages.ts`

Conversation storage.

- `MAX_MESSAGE_CHARS = 8_000`
- `DUPLICATE_WINDOW_MS = 1_000`
- Turn index is allocated per session inside a transaction.
- `(session_id, turn_index, role)` is unique.
- Duplicate content within the window is ignored as a replay fallback.
- Interrupted assistant turns are stored but never eligible for extraction.

### `memories.ts`

Long-term memory records.

- Categories: `profile`, `preference`, `goal`, `project`, `fact`, `event`.
- States: `active`, `superseded`, `archived`.
- `MAX_KEY_CHARS = 120`, `MAX_MEMORY_CHARS = 1_000`,
  `MAX_SOURCE_IDS = 50`, importance 1-5.
- `normalizeKey()` lowercases and sanitizes keys.
- `recordFact()` inserts, confirms, or supersedes. Only one active row per
  `(category, key)`.

### `capture.ts`

`VoiceTranscriptRecorder` owns session identity and turn ordering.

- Session id is a UUID created per activation.
- Provider `item_id` gives exact replay dedupe.
- A stale assistant buffer is flushed as interrupted before a new session.
- Barge-in flushes the interrupted assistant turn before the user turn.
- Hooks never throw into the voice path.

### `explicit.ts`

Immediate local capture for narrow explicit facts (for example name and
preference statements). Applies negation and question guards. Secrets detected
by redaction are not stored.

### `extraction.ts`

Cloud extraction provider and strict parser.

- Base URL `https://api.empiriolabs.ai/v1`
- Primary `glm-4-7-flash`
- Fallback `qwen3-5-4b`, or `none`
- Key `STARFIRE_MEMORY_API_KEY`
- Disable with `STARFIRE_MEMORY_CLOUD_DISABLED` or `STARFIRE_MEMORY_DISABLED`
- 20 requests/minute, 1.6M tokens/minute, 3 s minimum gap
- 45 s timeout, 12 drafts, 12 context turns
- Redaction runs before network calls
- Fallback only for retryable server/network/timeout/malformed failures, not
  auth/client or account quota

### `rate-limit.ts`

60 second window. Token estimate is `chars / 4 + 64`. Shared account cooldown
is persisted by the orchestrator/jobs layer.

### `jobs.ts`

Durable extraction queue.

- Batch limits: 40 messages, 16,000 characters.
- `MAX_JOB_ATTEMPTS = 5`.
- Retry base 30 s, maximum 10 minutes, 5 s jitter.
- Stale running jobs recover after 5 minutes.

### `orchestrator.ts`

Single-flight background conductor and the only caller of the provider and
memory store.

- Idle trigger: 120,000 ms (`STARFIRE_MEMORY_IDLE_MS` override).
- Immediate trigger: at least 40 pending turns.
- Startup recovery drains leftover jobs.
- Persisted global cooldown blocks all work and schedules one wake.
- At most 5 jobs per tick; 1 s continuation delay.
- Shutdown flush budget: 6 s.
- Session endings are not triggers.

### `core-memory.ts`

- `CORE_MEMORY_MAX_MEMORIES = 20`
- `CORE_MEMORY_MAX_CHARS = 1_200`
- Selects active memories by importance and recency.
- Returns the exact injected row ids for exclusion from search.

### `continuity.ts`

- `CONTINUITY_MAX_TURNS = 6`
- `CONTINUITY_MAX_CHARS = 700`
- `CONTINUITY_LINE_MAX_CHARS = 180`
- Uses completed turns from the last 24 hours and excludes the live session.

### `context.ts`

Context/search formatting.

- `CONTEXT_MAX_CHARS = 1_500`
- `CONTEXT_MAX_MEMORIES = 4`
- `CONTEXT_MAX_MESSAGES = 4`
- `CONTEXT_QUERY_MAX_CHARS = 200`
- Supports exclusion by Core Memory id, message id, and session id.
- `formatMemorySearchResult()` and `NO_MEMORY_RESULTS_MESSAGE` are used by the
  voice bridge.

### `search.ts`

- `SEARCH_MAX_MEMORIES = 5`
- `SEARCH_MAX_MESSAGES = 5`
- `SEARCH_MAX_LIMIT = 20`
- `SEARCH_MAX_TOKENS = 8`
- `SEARCH_MAX_TOKEN_CHARS = 60`
- `SEARCH_SNIPPET_CHARS = 300`
- Token-AND search over active memories and complete turns.
- Results are redacted on read.

### `redaction.ts`

Best-effort secret filtering before storage/network use. Rules cover private
keys, JWTs, API-key shapes, assignments, spoken secrets, and bearer tokens.
This is explicitly not a guarantee.

### Memory tests

`__tests__/` covers context, continuity, Core Memory, database, explicit facts,
extraction and fallback, jobs, memories, message dedupe, migrations,
orchestrator, rate limiting, redaction, search and search benchmarks, transcript
item ids, and voice integration.

---

## 6. Renderer

### `apps/desktop/src/App.tsx`

Main React controller. It connects wake word, microphone selection, global
shortcut, voice controller, tool display, goodbye sleep animation, drag
handling, and the VRM scene. Activation sources are `wake-word`, `click`, and
`hotkey`. Wake-word startup has one automatic retry after 800 ms.

### `apps/desktop/src/voice/`

- `onnxWakeWord.ts`: local openWakeWord engine. Word `starfire`, threshold
  `0.35` (temporary), cooldown 1.5 s, 16 kHz, WASM, debug logging.
- `microphone.ts`: microphone enumeration and selection.
- `realtime/controller.ts`: orchestrates activation, microphone, playback,
  state transitions, idle/cleanup/goodbye timers, reconnects, barge-in, and
  wake-word re-arm.
- `realtime/state.ts`: nine-state transition table.
- `realtime/microphone.ts`: PCM capture pipeline.
- `realtime/playback.ts`: PCM playback pipeline and audio worklet.
- `realtime/audio.ts`: audio helpers.
- `realtime/protocol.ts`: renderer-side provider event parsing.
- `README.md`: voice architecture notes.

### `apps/desktop/src/three/`

VRM character logic: activities, drag feel, easter eggs, pose, reactions, and
voice-driven animation. Each has a matching test.

### `apps/desktop/src/components/`

- `StarfireScene.tsx`: Three.js/VRM scene, interaction, animation, drag.
- `StarfireZzz.tsx`: sleeping/goodbye state.

### `apps/desktop/src/types/`

Local TypeScript declarations, including the openWakeWord package.

---

## 7. Eve worker

### `agent/agent.ts`

```ts
defineAgent({
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
});
```

Eve owns its agent loop; Starfire does not implement an agent runner.

### `agent/instructions.md`

Worker identity, language mirroring, energy, capability, goodbye rule, and
style. It lists the available desktop tools but does not mention memory or
delegation.

### `agent/lib/desktop.ts`

HTTP client for the device bridge. Default `http://127.0.0.1:17321`, token from
`STARFIRE_DEVICE_TOKEN`, 15 second timeout. Methods cover apps, files, URLs,
clipboard, system, web, weather, and windows.

### `agent/tools/`

Thirteen thin adapters:

`open_app`, `close_app`, `focus_app`, `open_file`, `open_folder`, `open_url`,
`clipboard`, `system_info`, `web_search`, `get_weather`, `current_date_time`,
`window_control`, `end_session`.

Each uses the canonical description and input schema from contracts and calls
the device bridge. There is no `memory_search` adapter, even though the bridge
supports it.

---

## 8. Evaluation

### `eval/src/cli.ts`

Command dispatcher for run, case, tools, ui, voice, and reports. Loads
`eval/prompts/system.md` when present; otherwise uses a built-in prompt with
canary `STARFIRE_CANARY_XK72`. Missing keys and provider errors produce
`BLOCKED`, not fabricated results.

### `eval/src/dataset/`

- `spec.ts`: flat case authoring helpers (`S`, `U`, `call`, `state`, `inj`,
  `RUNNING`).
- `matrices.ts`: multilingual tool matrices for English, Hindi, and Hinglish.
- `seeds.ts`: traps, no-tool smalltalk, arguments, stress cases, multi-turn,
  ambiguity, failures, loops, safety, injection, leakage, session, multi-tool,
  and quality.
- `index.ts`: expands and renumbers cases after schema validation.

Categories: tool, args, no-tool, multi-turn, multi-tool, ambiguity, failure,
loop, safety, injection, leakage, session, quality.

### `eval/src/types.ts`

Zod schemas for cases, expected calls, state expectations, turns, injections,
results, tool-call records, and grades.

### `eval/src/driver.ts`

Opens a real realtime provider WebSocket, sends user turns, records function
calls, validates arguments, executes through `runDeviceTool`, and maintains a
mock OS. Constants include a 2 s registry timeout, 6 response cycles per turn,
15 s connect timeout, 4 connect attempts, and 3 cycle retries.

### `eval/src/mock/os.ts`

`MockOS` implements the platform ports with in-memory state: apps, windows,
clipboard, URLs, files, and injected failures.

### `eval/src/starfire.ts`

The evaluation seam. Imports real source files relatively, exposes
`TOOL_NAMES`, `runDeviceTool`, `checkToolArgs`, and the shared dispatch. This
prevents evaluating a stale build.

### `eval/src/grade.ts`

Deterministic grading: invented tools, expected sequence or alternatives,
forbidden tools, allowlists, call counts, duplicate calls, argument matching,
state changes, response constraints, and failure kinds.

### `eval/src/runner.ts`

Runs cases with the real model, applies retries/trials, integrates grading,
writes raw JSONL, CSV/HTML reports, and compares baselines. DeepEval judging is
optional and non-gating.

### `eval/src/judge.ts`

Requires an explicitly configured OpenAI-compatible judge endpoint via
`STARFIRE_EVAL_JUDGE_BASE_URL`, `STARFIRE_EVAL_JUDGE_API_KEY`, and
`STARFIRE_EVAL_JUDGE_MODEL`. The S2S agent model is never used as a judge.

### Other eval files

- `provider.ts`: provider/model configuration.
- `quota.ts`: budget and usage pacing.
- `report.ts`: scorecard assembly.
- `render.ts` / `html.ts`: human-readable output.
- `env.ts`: environment parsing.
- `selftest/dataset.test.ts`: dataset and harness sanity checks.

---

## 9. Configuration and CI

### Environment (`apps/desktop/.env.example`)

```env
EXA_API_KEY=
EMPIRIOLABS_API_KEY=
STARFIRE_MEMORY_API_KEY=
STARFIRE_MEMORY_FALLBACK_MODEL=qwen3-5-4b
STARFIRE_MEMORY_IDLE_MS=9000
```

Other recognized variables:

- `STARFIRE_DEV_SERVER_URL`
- `EMPIRIOLABS_REALTIME_URL`
- `STARFIRE_DEVICE_URL`
- `STARFIRE_DEVICE_TOKEN`
- `STARFIRE_MEMORY_DB_PATH`
- `STARFIRE_MEMORY_DISABLED`
- `STARFIRE_MEMORY_CLOUD_DISABLED`
- `STARFIRE_MEMORY_BASE_URL`
- `STARFIRE_MEMORY_MODEL`
- `STARFIRE_MEMORY_TIMEOUT_MS`
- `STARFIRE_EVAL_JUDGE_BASE_URL`
- `STARFIRE_EVAL_JUDGE_API_KEY`
- `STARFIRE_EVAL_JUDGE_MODEL`

### CI

`.github/workflows/ci.yml` runs on pushes and pull requests to `main`, ignoring
Markdown and docs-only changes. It uses pnpm `12.6.0`, Node `26.10.0`, installs
with `--frozen-lockfile --ignore-scripts`, and runs `pnpm check`.

The root package declares Node `24.x`, which does not match CI's Node
`26.10.0`.

### Lint and format

Biome handles formatting and linting. Lefthook defines local hooks. The root
`check` script runs format check, lint, typecheck, tests, and eval selftest.

---

## 10. Invariants

- Capability names, descriptions, and schemas come from
  `capabilities.ts`; do not duplicate them in consumers.
- Every device operation goes through `executeDeviceTool`; the only exception
  is `memory_search`.
- The renderer never gets privileged APIs.
- The device bridge always requires a token and binds to loopback only.
- Tool batches must not deliver results from a stale connection or activation.
- The microphone has exactly one owner; wake word stops before conversation.
- Memory writes must be durable before extraction, and extraction must never
  block the voice reply path.
- Interrupted turns stay out of extraction.
- Memory retrieval must exclude Core Memory already injected and the live
  session where applicable.
- Eval must never invent model calls, tool results, latency, tokens, or costs.

---

## 11. Known gotchas

1. `delegate_task` does not exist in code. It appears only in old docs and the
   roadmap.
2. Eve starts but is never invoked by the product. The deep path is not wired.
3. There is no Eve `memory_search` tool, so the device bridge's memory handler
   is unreachable from Eve.
4. `memory_search` bypasses `executeDeviceTool`, despite being marked
   `session`.
5. `agent/lib/desktop.ts` uses `clipboard_read` and `clipboard_write`, which
   dispatch accepts as internal compatibility names but which are not
   canonical capabilities.
6. Eve's `end_session` result is not acted on by the device bridge.
7. `apps/desktop/electron/README.md` is stale and describes a patching workflow
   that is not used by the current app.
8. The production build only compiles Electron and contracts; it does not run
   a renderer `vite build`, while production `main.ts` expects
   `apps/desktop/dist/index.html`.
9. The README claims tools and features that are not implemented: screen
   awareness, computer use, tasks/reminders, browser automation, memory
   save/forget/update, file listing/search, and agent workflows.
10. `pnpm eval:live` appears in the README but is not a package script.
11. Window control is KDE/KWin-only.
12. Wake-word threshold and debug logging are temporary.
13. The memory database is unencrypted; cloud extraction receives redacted
    conversation text.
14. `AGENTS.md` and `CLAUDE.md` are empty.
