
## 📦 `public/` — Static Assets

Static assets that are **served as-is** by the desktop app.

These files are not processed by Vite or TypeScript at runtime. They are available directly through their public paths.

## 📁 Folders

| Folder | What's inside |
|---|---|
| `models/` | 👗 Starfire's VRM models. `starfire-2.vrm` is the currently active model. |
| `openwakeword/models/` | 🧠 Wake-word ONNX models — mel-spectrogram → embedding → `starfire.onnx`, the custom **"Starfire"** keyword model. |
| `worklets/` | ⚡ AudioWorklet processors that run on the audio thread. See [`src/voice/realtime/README.md`](../src/voice/realtime/README.md) for the audio contract. |
| `audio/` | 🔉 Reserved for future sound assets. |

---

## ⚠️ AudioWorklet Rules

The files inside `worklets/` are special.

### 🎤 `mic-worklet.js`

Captures microphone audio on the **audio render thread**.

### 🔊 `play-worklet.js`

Handles speaker playback on the **audio render thread**, including:

- Audio queuing
- Jitter buffering
- Output loudness measurement
- Audio drain detection
- Playback clearing

Both worklets are **plain JavaScript** — not TypeScript.

They run directly inside the browser's `AudioWorklet` environment, so they must stay lightweight and avoid unnecessary work.

---

## 🔒 The Playback Message Contract

`play-worklet.js` and `playback.ts` communicate through a strict message contract.

### Messages sent to the worklet

```ts
{ pcm }
```

Queues PCM audio for playback.

```ts
{ type: "clear" }
```

Immediately clears queued playback.

### Messages sent back from the worklet

```ts
{ type: "level" }
```

Reports real-time speaker output loudness for Starfire's mouth animation.

```ts
{ type: "drained" }
```

Reports that all queued audio has finished playing.

---

## 🧪 Keep Both Sides in Sync

The contract is protected by:

```text
playback.ts
     │
     │  strict message contract
     ↓
play-worklet.js
     │
     ↓
playback.test.ts
```

If you change the message format on **either side**, update the other side too and keep the tests passing. 🔒

> **Never silently change the worklet protocol.**

A small mismatch between the sender and the worklet can break playback, mouth animation, interruption handling, or drain detection.