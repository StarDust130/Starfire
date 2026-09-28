

## ⚡ `voice/realtime/` — Realtime Voice Conversation

The full **"talk to her live"** pipeline. 🗣️💙

## 📁 Files

| File | Role |
|---|---|
| ⭐ `controller.ts` | 🧠 **Brain / traffic cop.** Owns the state machine, echo guard 🛡️, idle timers ⏱️, interrupt rules ✋, auto-reconnect 🔁, and latency logs. Dependencies are injected, so it can be tested with **zero hardware**. |
| `state.ts` | 🔄 **State machine.** Defines the conversation flow: `idle → starting → connecting → listening → user-speaking → thinking → assistant-speaking → …` — one source of truth, no boolean soup. |
| `audio.ts` | 🧮 **Pure audio math.** Handles PCM/base64 conversions, resampling, RMS, mouth curves, pre-roll buffering, and the adaptive speech gate. No hardware. |
| `microphone.ts` | 🎤 Opens the conversation microphone at the device's **native sample rate**, then resamples to **16 kHz**. Linux lesson learned: forcing the microphone to 16 kHz can produce silence. |
| `playback.ts` | 🔊 Owns the reusable **24 kHz speaker pipeline**. It is pre-warmed during connection so Starfire's first word can play immediately. |

## 🔊 Audio Worklets

Located in `public/worklets/`.

These run on the **audio thread** for fast, low-latency processing:

| Worklet | Job |
|---|---|
| 🎤 `mic-worklet.js` | Captures ~16 ms microphone chunks and measures loudness. |
| 🔊 `play-worklet.js` | Manages the speaker queue with a 60-second ring buffer, jitter priming, real-time loudness output for mouth animation 👄, and audio-drain reporting. |

## 🗺️ The Golden Audio Path

```text
MIC
 ↓
Mic Worklet
 ↓
~16 ms chunk
 ↓
Resample → 16 kHz
 ↓
PCM16
 ↓
Base64
 ↓
IPC
 ↓
Main Process
 ↓
WebSocket
 ↓
Qwen
 ↓
Audio Response
 ↓
IPC
 ↓
Playback Queue
 ↓
Jitter Prime
 ↓
SPEAKER
```

Everything else — React, UI, logs, animations, etc. — **hangs off the side of this path**. 🪝

The audio path stays focused on one job:

> **Get audio from the microphone to Starfire's voice model and back to the speaker with as little latency as possible.** ⚡

---

## ✋ Interrupt Rules

These rules control what happens when the user interrupts Starfire.

### 1. 👑 Server VAD is the Boss

The server receives **echo-controlled microphone audio** and decides when the user's turn starts and ends.

### 2. 🛑 Talk Over Her → Stop Her Immediately

If the user starts talking while Starfire is speaking:

```text
User speaks
    ↓
Interrupt detected
    ↓
Clear playback
    ↓
Starfire stops speaking immediately
```

### 3. 🧟‍♂️ Drop Stale Audio

After an interrupted response, old audio from the dead response is discarded.

Stale audio remains blocked until a **new response** begins.

### 4. 🔊 Local Fallback Interrupt

If server-side detection is unavailable or delayed, the local fallback only interrupts after approximately **300 ms of sustained loud speech**.

Short noises do not trigger an interrupt.

### 5. 🛡️ Speaker Echo Must Never Trigger Interrupts

Starfire's own speaker output must not be mistaken for the user's voice.

An **echo floor** prevents her own audio from triggering the interrupt system.

---

## ⏱️ Idle & Cost

- 😴 After approximately **7 seconds of silence** following Starfire's speech, the conversation session closes.
- 🔁 When the session closes, the **wake-word system resumes**.
- 🎤 The microphone may remain active locally, but only actual audio is uploaded — **silence is never sent**.
- 💰 This reduces unnecessary API usage.
- 🔗 One WebSocket is used for the entire conversation — **not one connection per sentence**.

---

## 🧪 Tests

| Test | What it verifies |
|---|---|
| 🧠 `controller.test.ts` | The controller's complete lifecycle and state transitions. ~30 tests, with **zero hardware required**. |
| 🧮 `audio.test.ts` | Audio math is NaN-proof, clamped, and bounded. |
| 📡 `protocol.test.ts` | Server protocol and message parsing. |
| 🔊 `playback.test.ts` | Worklet message contract — sender and worklet stay in sync. |
| 🚨 `realtime.live.test.ts` | Real API end-to-end test. Runs **only** with `STARFIRE_LIVE_E2E=1` and a valid API key. This test makes a real API call and can cost a few cents. |

### 🚨 Live E2E Test

Never run the live test accidentally.

```text
Normal tests
    ↓
No real API
    ↓
No API cost
```

Only when explicitly enabled:

```text
STARFIRE_LIVE_E2E=1
        +
     API key
        ↓
Real API call
        ↓
Live voice test
```

---

## 🎀 The Architecture Rule

> **`controller.ts` owns the conversation.**  
> **`audio.ts` owns the math.**  
> **Worklets own real-time audio processing.**  
> **`microphone.ts` owns input.**  
> **`playback.ts` owns output.**

Keep those responsibilities separate.

That separation is what makes the realtime voice system **fast, testable, and predictable**. ⚡🎀