

## 🦴 `three/` — Her Body and Soul

Everything that makes Starfire **move**. 🎬

Pure **TypeScript + Three.js math** — no React inside.

The scene calls these functions every frame.

## 📁 Files

| File | Role |
|---|---|
| ⭐ `pose.ts` | 🧠 **Skeleton brain.** Loads the VRM and self-calibrates by probing arm rotation directions, measuring real rest angles, and calculating leg length. No model-specific magic numbers — designed to work across VRM models. Defines the core pose system. |
| 💬 `voiceAnim.ts` | **Talking body language.** A behavior sequencer that splits each reply into segments — gestures, folded hands, hair touches, weight shifts, stance shuffles, etc. — and crossfades between them smoothly. Every sequence is seeded, so replies feel different while remaining testable. |
| 🧍 `activities.ts` | **Her independent life.** Sits hugging her knees, sleeps with Zzz, looks around, grooves, and more. Uses a weighted random picker to choose activities. |
| ✨ `reactions.ts` | **Small reactions.** Curious head tilts, shyness, fidgets, plus listening gestures like greet, bounce, and peek. |
| 🖐️ `dragFeel.ts` | **Carrying physics.** Makes her trail behind the mouse with spring physics, bank into turns, dangle her legs, use a walk cycle, and settle with a wobble after release. |
| 🎉 `easterEgg.ts` | **Secret interaction.** Five fast clicks trigger a special spin, jump, and dance. |

---

## 👑 The Golden Rule

Every frame, **every animated bone is rebuilt from its calibrated base pose**:

```text
Final Rotation
      │
      ├── Calibrated BASE
      │
      ├── + DAMPED layer
      │      └── Slow poses / smooth movement
      │
      └── + INSTANT layer
             └── Fast beats / quick reactions
```

### ❌ Never Accumulate Rotations

```ts
bone.rotation.x += something
```

Never do this.

Repeatedly adding to the current rotation causes values to accumulate over time, eventually creating pose drift and broken animations. 💥

### ✅ Rebuild From Base Every Frame

```text
CALIBRATED BASE
      ↓
+ DAMPED LAYER
      ↓
+ INSTANT LAYER
      ↓
FINAL BONE ROTATION
```

This means:

- ❌ No pose drift
- ❌ No accumulated rotation bugs
- ✅ Any animation can be interrupted safely
- ✅ Animations can switch instantly
- ✅ Different systems can control the same skeleton without corrupting it

### ⏱️ Two Animation Layers

**Damped layer**

Used for slow movements:

- 🧍 Body poses
- 💃 Weight shifts
- 👀 Looking around
- 💤 Idle animations

These movements glide smoothly.

**Instant layer**

Used for fast movements:

- ⚡ Gesture beats
- 👋 Quick reactions
- 🎉 Easter eggs
- 💬 Sharp talking movements

These stay responsive instead of getting mushy from damping.

---

## 🌱 Why Seeds?

Every voice episode receives a random **seed**. 🎲

That seed deterministically controls things like:

- Gesture sequence
- Lead hand
- Energy level
- Thinking pose
- Movement timing
- Other small behavioral choices

```text
Voice Episode
      ↓
   Random Seed
      ↓
┌─────┼─────────────┐
↓     ↓             ↓
Gestures  Energy  Thinking Pose
      ↓
Deterministic Animation
```

The result:

> **No two replies look exactly the same — but the same seed always produces the same behavior.** 🎲🧪

That gives Starfire personality **without sacrificing determinism or testability**.