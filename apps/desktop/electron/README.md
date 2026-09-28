
## ⚙️ electron/ — The Trusted Backend

Everything here runs in the Electron **main process** (Node.js side).
It is the only "adult" in the room: it holds secrets and touches the OS. 🛡️

## Files

| File | Role |
|---|---|
| ⭐ **`main.ts`** | Starts the whole app: transparent window 🪟, always-on-top, drag by cursor-polling 🖐️, **Super+Z** global shortcut ⌨️, permission handling, launches the voice bridge. |
| **`realtimeVoice.ts`** | 🔐 Owns the API key. Opens the realtime **WebSocket**, streams mic audio up and her voice audio down over IPC. Connect-retry + latency logs. |
| **`realtimeProtocol.ts`** | 🌐 Translator for the server protocol: parses events (typed, crash-proof) and builds outgoing messages (session config, audio chunks). |
| **`preload.ts`** | 🌉 The security bridge. Exposes ONLY tiny typed functions (`starfireDesktop`, `starfireVoice`) to the web page. The key can never cross this bridge. |
| `package.json` | Pins this folder to **CommonJS** (required for Electron sandbox). |

## Why this folder exists

The renderer (web page) is untrusted — anyone could open devtools.
So: secrets, sockets, and window control live here. The page only gets
narrow, typed doors. 🚪

## ⚠️ Rules

- Never log the API key. Never put it in a URL. 🙈
- `electron-dist/` is build output — always regenerated, gitignored. 🧹
- After editing any file here, restart `pnpm dev` (dev script recompiles). 🔁