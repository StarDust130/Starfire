

## 🎙️ `voice/` — The Ear and the Mouth

Two systems **share one microphone** — and must never fight over it. 🥊🚫

## 🌙 System 1: Wake Word — Cheap, Always On

| File | Role |
|---|---|
| ⭐ `onnxWakeWord.ts` | Hears **"Starfire"** locally using small ONNX models — no cloud, no cost. |
| 🎤 `microphone.ts` | Selects the real microphone and filters out HDMI/loopback devices. |

The wake-word system runs continuously until a conversation starts.

When the conversation begins, the `VoiceController` **pauses the wake-word system**. ⏸️

## ⚡ System 2: Realtime Conversation — Active Only While Talking

The realtime conversation system lives in [`realtime/`](https://chat.z.ai/c/realtime/README.md).

It handles the actual **voice conversation with Qwen via EmpirioLabs**.

Unlike the wake-word system, it only uses the microphone while Starfire is actively talking with the user.

## 👑 The Microphone Ownership Rule

There is **one microphone and one owner at a time**.

```text
┌───────────────────────────────┐
│       Wake Word Listening     │
│             🎤                │
└───────────────┬───────────────┘
                │
                │ Starfire detected
                ↓
        VoiceController
                │
                ↓
┌───────────────────────────────┐
│    Realtime Conversation      │
│             🎙️                │
└───────────────┬───────────────┘
                │
                │ Session ends
                ↓
        VoiceController
                │
                ↓
┌───────────────────────────────┐
│       Wake Word Listening     │
│             🎤                │
└───────────────────────────────┘
```

### 🔒 Ownership States

| State | Wake Word | Conversation | Microphone Owner |
|---|---|---|---|
| 🌙 Idle | 🟢 ON | 🔴 OFF | Wake Word |
| 🎙️ Talking | 🔴 PAUSED | 🟢 ON | Conversation |
| 💤 Session Ended | 🟢 ON | 🔴 OFF | Wake Word |

### 🎀 The Rule

> **Wake word ON → conversation OFF**  
> **Conversation ON → wake word PAUSED**  
> **Session ends → wake word resumes automatically** 🔁

**One microphone. One owner. `VoiceController` enforces the rule.** 🎀