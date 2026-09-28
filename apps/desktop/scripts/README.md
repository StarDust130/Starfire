
## 🚀 `scripts/` — Dev Launcher

The scripts folder contains the tooling that starts Starfire's desktop development environment in the **correct order**.

## 📁 Files

| File | Role |
|---|---|
| ⭐ `dev-electron.mjs` | Starts the complete development environment in the correct order. |

## ⚡ What `dev-electron.mjs` Does

Every `pnpm dev` launch follows this sequence:

```text
1. 🔑 Load environment
       ↓
   apps/desktop/.env
       ↓
2. 🌐 Start Vite
       ↓
   UI server → :1420
       ↓
3. 📦 Compile Electron
       ↓
   main + preload → electron-dist/
       ↓
4. ⏳ Wait for Vite
       ↓
   Confirm the UI server is ready
       ↓
5. ⚡ Launch Electron
       ↓
   Start with the fresh compiled build
```

### 1. 🔑 Load Environment

Loads:

```text
apps/desktop/.env
```

This makes the required environment variables, such as the EmpirioLabs API key, available to the Electron process.

### 2. 🌐 Start Vite

Starts the Vite development server:

```text
http://localhost:1420
```

Vite serves the React renderer with fast development updates.

### 3. 📦 Compile Electron

Compiles:

```text
electron/main
electron/preload
        ↓
electron-dist/
```

This happens **on every launch**.

### 4. ⏳ Wait for Vite

The launcher waits until Vite is actually responding before starting Electron.

### 5. ⚡ Launch Electron

Only after the fresh Electron build exists and Vite is ready does the launcher start the desktop application.

---

## 🧨 Why Step 3 Matters

The renderer and Electron do **not** run the same way.

```text
React Renderer
     ↓
    Vite
     ↓
Fresh code
```

But Electron's main process runs the **compiled JavaScript**:

```text
electron/main
electron/preload
       ↓
   TypeScript
       ↓
   Compiled JS
       ↓
electron-dist/
```

If Electron is not recompiled before launch, it can silently run an **old build**.

That creates the worst kind of bug:

```text
You change the code
       ↓
Vite shows the new code
       ↓
Electron still runs old compiled JS
       ↓
"It works in review..."
       ↓
...but not in the actual app 😭
```

This previously caused bugs where **dragging and the global hotkey appeared broken for days**.

### 🎀 The Rule

> **Every `pnpm dev` launch → fresh Electron compilation.**

Never rely on yesterday's `electron-dist/`.

---

## 🛠️ Commands

### Development

```bash
pnpm dev
```

Runs `dev-electron.mjs` and starts the complete desktop development environment.

### Production Build

```bash
pnpm build
```

Runs the TypeScript check and Vite production build.

---

## 10. `apps/desktop/README.md`

# 💜 `apps/desktop` — The STARFIRE App

A transparent desktop AI companion for **Linux**.

Designed for:

- 🐧 KDE Plasma
- 🌊 Wayland
- 🖥️ X11

The app combines:

- 🎀 3D VRM Starfire
- 🎤 Local wake-word detection
- 🗣️ Realtime voice conversation
- 🧠 AI interaction
- 🖱️ Desktop interaction
- 💬 Reactive UI
- 🎬 Procedural animations

## 📚 Documentation

Detailed documentation lives next to the code:

```text
apps/desktop/
│
├── electron/       → Electron main process + preload
├── src/voice/      → Wake word + voice systems
├── src/three/      → Starfire's body + animation
├── src/components/ → React stage + UI
├── public/         → Static assets + worklets
└── scripts/        → Development launcher
```

Each folder has its own `README.md`.

---

## 🚀 Quick Start

Create the local environment file:

```bash
echo "EMPIRIOLABS_API_KEY=your-key" > .env
```

> ⚠️ `.env` is gitignored. Never commit your API key.

Then start Starfire:

```bash
pnpm dev
```

---

## ✅ Health Checks

Run the complete validation suite:

```bash
pnpm check
```

This checks:

- 🎨 Formatting
- 🔍 Linting
- 🔷 TypeScript
- 🧪 Tests

Production build:

```bash
pnpm build
```

---

## 🧯 Quick Troubleshooting

Read the terminal output first. Starfire logs important information about the voice pipeline.

| Log line | Meaning |
|---|---|
| `session ready (voice=…)` | ✅ Connected to the voice model. |
| `mic frames flowing (rms=0.0xxx)` | 🎤 Microphone is producing audio. A non-zero RMS means real audio is being detected. |
| `you said: …` | 🗣️ The server received and processed your speech. |
| `⏱ turn -> first audio: …ms` | ⚡ Time from the user's turn to the first response audio. Typical observed range: ~533–990 ms. |
| `connection lost — reconnecting` | 🔄 Connection dropped; automatic recovery is in progress. |
| `Microphone is not delivering audio` | 🎤 Check the selected input device in KDE/system audio settings. |
| `EmpirioLabs API key is not configured` | 🔑 `.env` is missing, empty, or the API key is not available to the app. |

---

## 🌱 Keeping the Documentation Alive

### 1. 📍 Keep Docs Near the Code

Documentation becomes outdated when it is separated from the code it describes.

That's why every important folder has its own README.

> **Update the folder README in the same commit as the code change.**

### 2. ⭐ One Starting Point Per Folder

The ⭐ marks the **"start reading here"** file.

Keep exactly **one ⭐ file per folder**.

This makes unfamiliar parts of the codebase easier to navigate.

### 3. ➕ Document New Files

When adding a new file:

```text
New file
   ↓
Add one row to the folder README
   ↓
Done
```

One line takes ~30 seconds and prevents the architecture map from becoming outdated.

### 4. 🌎 Keep the Root README Honest

The root README is Starfire's **GitHub front page**.

It is what:

- 👀 New contributors see first
- 👀 Potential users see first
- 👀 Future-you sees first

Keep the feature list and architecture description **accurate to the actual code**.

---

## 🎀 The Documentation Rule

> **Code changes → Documentation changes.**

If the architecture changes, the README should change with it.

That's how the Starfire codebase stays understandable as the project grows.