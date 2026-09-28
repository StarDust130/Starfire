
## 🎨 `components/` — The React Stage

The React layer that **puts Starfire on stage**. 🎬

It connects the visual UI with the underlying Three.js animation, voice, and interaction systems.

## 📁 Files

| File | Role |
|---|---|
| ⭐ `StarfireScene.tsx` | 🎬 **Stage director.** Sets up Three.js — scene, camera, lights — loads the VRM, and runs the 60 FPS render loop that combines **all animation layers**. Also handles 3D hit-testing for click/drag interactions and anchors the speech bubble and Zzz to Starfire's actual head bone. |
| 😴 `StarfireZzz.tsx` | Displays the floating **"z z Z"** beside Starfire's head while she sleeps. |

---

## 🎬 What `StarfireScene` Reads Every Frame

The scene combines state from multiple systems to decide what Starfire should look like **right now**.

### 🗣️ Voice State

Controls things like:

- 🎤 Listening
- 💬 Speaking
- 🧠 Thinking
- 💭 Current bubble text
- Voice-driven body animations

### 👄 Mouth Level

The mouth animation uses **real speaker output loudness** from the playback worklet.

```text
Qwen Audio
    ↓
Playback Pipeline
    ↓
Speaker Worklet
    ↓
Real Output Loudness
    ↓
Mouth Animation 👄
```

The loudness is measured from the **audio actually being played**, not merely when audio packets arrive.

This keeps her mouth moving for the **entire spoken response**, rather than only when audio first arrives.

### 🖐️ Drag State

The scene also reads the current drag state and passes it into the body/physics system.

```text
Mouse
  ↓
Hit Test
  ↓
Drag State
  ↓
dragFeel.ts
  ↓
Carry Physics 🖐️
```

---

## 🎯 The Hit-Test Rule

Starfire's window is **fully transparent**.

That means empty space must behave like empty space.

### ✅ Over Starfire

The cursor becomes **`grab`** when it is over her actual interactive body:

- Head
- Torso
- Arms
- Other defined body regions

### ❌ Empty Space

Clicking empty transparent space does **nothing**:

- No reaction
- No drag
- No activation
- No accidental interaction

---

## 🧠 Why We Don't Raycast the Mesh

A normal mesh raycast can be misleading here.

The VRM mesh is skinned and its geometry is based around the model's bind/rest pose. Starfire's visible body, however, is continuously changed by her animated bones.

Instead of relying on mesh raycasting, the hit-test system projects **important bones through the camera** and performs the interaction test against their current screen-space positions.

```text
Animated VRM
    ↓
Current Bone Positions
    ↓
Project Bones Through Camera
    ↓
Screen-Space Hit Test
    ↓
Is Cursor Near Her Actual Body?
       │
   ┌───┴───┐
   ↓       ↓
  YES      NO
   ↓       ↓
 grab    nothing
 drag
```

Because the test uses the **current animated bone positions**, interaction stays aligned with Starfire even while she:

- 🧍 Changes pose
- 💬 Talks
- 💤 Sleeps
- 💃 Moves
- 🖐️ Gets dragged

---

## 🎀 The Component Rule

> **React owns the stage. Three.js owns the body.**

`StarfireScene.tsx` connects the two without putting animation logic inside React components.

The heavy per-frame animation work stays in `three/`, while React handles the **scene lifecycle, UI state, and integration**.