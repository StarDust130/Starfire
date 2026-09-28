## 🎀 `src/` — The App

Everything Starfire **sees, hears, and does** lives here. ✨

| Folder / File | What lives here |
|---|---|
| ⭐ `App.tsx` | The **switchboard** 🧭 — owns the wake-word engine and `VoiceController`, and sends every activation through **one path**. |
| 🎨 `components/` | The **React stage** — 3D Starfire, speech bubbles, thinking dots, Zzz, and other UI. |
| 🦴 `three/` | Her **body + soul** — poses, animations, dragging, activities, reactions, and easter eggs. |
| 🎤 `voice/` | Her **ears + mouth** — wake word, microphone, realtime voice conversation, and audio handling. |
| 🚪 `main.tsx` | React entry point. |
| 💅 `App.css` | App styling — glass bubbles, Zzz, thinking dots, and UI effects. |
| 🌉 `vite-env.d.ts` | Type declarations for the preload bridge and `window` APIs. |
| 🧓 `character.ts` | **Legacy** — kept for reference; not part of the active flow. |

### 🔄 The Core Flow

Every interaction follows the same activation pipeline:

```text
                    ACTIVATION
                        │
             ┌──────────┼──────────┐
             │          │          │
          🎤 Wake     🖱️ Click   ⌨️ Super + Z
             │          │          │
             └──────────┼──────────┘
                        ↓
             activateListening()
                        ↓
               VoiceController
                        ↓
             Microphone / Audio
                        ↓
              Voice Conversation
                        ↓
              Starfire's Response
                        ↓
             ┌──────────┴──────────┐
             ↓                     ↓
          🎨 React UI          🦴 3D Body
```

**One activation → one path → one `VoiceController`.** 🎀

There are no separate voice flows for different activation methods.

---

### 🎤 The Two Ways Starfire Wakes

#### 1. 🎤 Wake Word

Say:

> **"Starfire"**

- 🧠 Runs locally
- 💸 Free
- 👂 Always listening for the wake word
- ⚡ Activates the same `VoiceController` as every other trigger

```text
"Starfire"
    ↓
Wake-word detection
    ↓
activateListening()
    ↓
VoiceController
```

#### 2. 🖱️⌨️ Direct Activation

You can also activate Starfire manually:

- 🖱️ **Click Starfire**
- ⌨️ **Press `Super + Z`**

Both trigger the exact same function:

```text
Click / Super + Z
       ↓
activateListening()
       ↓
VoiceController
```

### 🎀 The Rule

> **Different triggers. One activation path.**

```text
Wake Word ───┐
             │
Click ───────┼──→ activateListening() → VoiceController
             │
Super + Z ───┘
```

This keeps Starfire's voice architecture **simple, predictable, and easy to extend**.