import { type PoseTarget, addBone, clamp, deg } from "./pose";

export type VoiceAnimState =
  | "user-speaking"
  | "thinking"
  | "assistant-speaking";

/*
 * ---------------------------------------------------
 * SEEDED VARIETY ENGINE
 * ---------------------------------------------------
 * Every voice episode (a reply, a thinking pause, a listening
 * stretch) gets one random seed chosen by the scene. The seed
 * deterministically derives gesture phase, which hand leads, the
 * energy personality, gesture frequency, and two-hand affinity —
 * so every reply gestures differently, while remaining a pure,
 * testable function of (state, t, level, seed).
 *
 * The scene resets its accumulator every frame, so nothing here
 * can accumulate. All offsets stay under 10 degrees.
 */
function hashToUnit(seed: number, salt: number): number {
  const x = Math.sin(seed * 127.1 + salt * 311.7) * 43758.5453;

  return x - Math.floor(x);
}

/*
 * ---------------------------------------------------
 * ASSISTANT SPEAKING
 * ---------------------------------------------------
 * Natural conversational gesturing:
 *  - audio-level-driven head bob and lean-in
 *  - alternating hand raises with beat-pulsed elbow accents
 *  - random two-hand emphasis beats ("and then THIS big")
 *  - weight shift on the hips and torso yaw toward the active hand
 *  - occasional tiny nods on emphasis
 */
function talkPose(
  acc: PoseTarget,
  t: number,
  s: number,
  fx: number,
  lv: number,
  seed: number,
): void {
  const phase0 = hashToUnit(seed, 1) * Math.PI * 2;

  const freq = 0.85 + hashToUnit(seed, 2) * 0.5;

  const energy = 0.65 + hashToUnit(seed, 3) * 0.5;

  const leadHand = hashToUnit(seed, 4) < 0.5 ? 1 : -1;

  const bothHandsAffinity = hashToUnit(seed, 5);

  const tt = t * freq + phase0;

  const pulse = Math.max(0, Math.sin(tt * 6.4)) ** 3;

  const bob = Math.sin(tt * 7.3) * deg(0.8 + 1.8 * lv * energy);

  const nod = Math.max(0, Math.sin(tt * 0.9)) ** 24;

  const sway = Math.sin(tt * 1.1) * deg(1.0 * energy);

  /*
   * Gesture cycle: every ~2.4s (jittered by phase) the active hand
   * switches. Near the switch both hands lift a little — a natural
   * two-handed emphasis — more often for high-affinity seeds.
   */
  const cycle = Math.sin((t * Math.PI * 2) / 2.4 + phase0);

  const leftPhase = Math.max(0, cycle);

  const rightPhase = Math.max(0, -cycle);

  const bothBeat = (1 - Math.abs(cycle)) ** 2 * bothHandsAffinity;

  const lift = deg(1.0) + deg(3.4) * lv * energy;

  const elbow = (deg(3.2) + deg(3.6) * lv) * (0.35 + 0.65 * pulse);

  const leftAmount = leftPhase * (leadHand > 0 ? 1 : 0.55) + bothBeat * 0.7;

  const rightAmount = rightPhase * (leadHand < 0 ? 1 : 0.55) + bothBeat * 0.7;

  const gestureSide = cycle >= 0 ? -1 : 1;

  const shoulderLife = deg((1.0 + 1.6 * lv) * energy) * 0.6 + sway * 0.4;

  addBone(
    acc,
    "head",
    bob + nod * deg(2.6),
    Math.sin(tt * 1.7) * deg(1.1) * lv,
    sway,
  );

  addBone(
    acc,
    "spine",
    fx * deg(1.5) * lv,
    gestureSide * deg(1.2) * lv,
    sway * 0.5,
  );

  addBone(acc, "hips", 0, 0, -gestureSide * deg(1.2) * lv);

  addBone(acc, "leftShoulder", 0, 0, -s * shoulderLife);

  addBone(acc, "rightShoulder", 0, 0, s * shoulderLife);

  /*
   * Raising the LEFT upper arm rotates -s; raising the RIGHT is +s.
   * (Getting this sign backwards makes hands sink instead of lift.)
   */
  addBone(acc, "leftUpperArm", 0, 0, -s * lift * Math.min(1, leftAmount));

  addBone(
    acc,
    "leftLowerArm",
    fx * deg(1.2) * Math.min(1, leftAmount) * lv,
    0,
    s * elbow * Math.min(1, leftAmount),
  );

  addBone(acc, "rightUpperArm", 0, 0, s * lift * Math.min(1, rightAmount));

  addBone(
    acc,
    "rightLowerArm",
    fx * deg(1.2) * Math.min(1, rightAmount) * lv,
    0,
    -s * elbow * Math.min(1, rightAmount),
  );
}

/*
 * ---------------------------------------------------
 * THINKING
 * ---------------------------------------------------
 * Seed picks one of four poses per episode:
 *  chin-hand  — hand up near the chin, head tilted, slow wander
 *  look-away  — slow big head scan, relaxed body (gaze handled by scene)
 *  hmm-tilt   — held head tilt with a slow "hmm" nod
 *  still      — nearly still, just thoughtful micro motion
 */
function thinkPose(
  acc: PoseTarget,
  t: number,
  s: number,
  fx: number,
  seed: number,
): void {
  const roll = hashToUnit(seed, 10);

  const thinkNod = Math.max(0, Math.sin(t * 0.35)) ** 24;

  const rock = Math.sin(t * 0.55);

  if (roll < 0.35) {
    /*
     * chin-hand: raise the right hand toward the chin and hold it.
     */
    addBone(
      acc,
      "head",
      Math.sin(t * 0.5) * deg(1.0) + thinkNod * deg(2),
      Math.sin(t * 0.6) * deg(1.6),
      fx * deg(2.5) * Math.sin(t * 0.4),
    );

    addBone(acc, "spine", fx * deg(0.8), 0, rock * deg(0.5));

    addBone(acc, "rightUpperArm", 0, 0, s * deg(3));

    addBone(acc, "rightLowerArm", fx * deg(1.5), 0, -s * deg(9.3));

    addBone(acc, "leftLowerArm", 0, 0, s * deg(1.5));

    return;
  }

  if (roll < 0.6) {
    /*
     * look-away: slow curious scan, hands relaxed.
     */
    addBone(
      acc,
      "head",
      Math.sin(t * 0.45) * deg(1.0),
      Math.sin(t * 0.5) * deg(3.2),
      -Math.sin(t * 0.5) * deg(1.4),
    );

    addBone(acc, "spine", 0, Math.sin(t * 0.5) * deg(0.8), 0);

    return;
  }

  if (roll < 0.85) {
    /*
     * hmm-tilt: a held tilt with a slow thoughtful nod.
     */
    const holdTilt = Math.sin(t * 0.3 + hashToUnit(seed, 11) * Math.PI);

    addBone(
      acc,
      "head",
      thinkNod * deg(2.2),
      holdTilt * deg(2.0),
      fx * deg(3.0) * holdTilt,
    );

    addBone(acc, "spine", fx * deg(0.5), 0, rock * deg(0.4));

    return;
  }

  /*
   * still: quiet, composed thinking.
   */
  addBone(acc, "head", Math.sin(t * 0.4) * deg(0.6), 0, 0);

  addBone(acc, "spine", fx * deg(0.4), 0, 0);
}

/*
 * ---------------------------------------------------
 * USER SPEAKING (attentive listening)
 * ---------------------------------------------------
 * Seed picks the tilt side; an occasional tiny "mhm" nod.
 */
function listenPose(
  acc: PoseTarget,
  t: number,
  fx: number,
  seed: number,
): void {
  const side = hashToUnit(seed, 20) < 0.5 ? 1 : -1;

  const tilt = Math.sin(t * 0.5) * deg(1.6);

  const nod = Math.max(0, Math.sin(t * 0.8)) ** 24;

  addBone(acc, "head", nod * deg(1.3), fx * side * tilt, fx * side * deg(1));

  addBone(acc, "spine", 0, 0, fx * side * deg(0.4));
}

export function applyVoiceAnimation(
  acc: PoseTarget,
  state: VoiceAnimState,
  t: number,
  s: number,
  fx: number,
  level: number,
  seed: number,
): void {
  const lv = clamp(Number.isFinite(level) ? level : 0, 0, 1);

  if (state === "assistant-speaking") {
    talkPose(acc, t, s, fx, lv, seed);

    return;
  }

  if (state === "user-speaking") {
    listenPose(acc, t, fx, seed);

    return;
  }

  thinkPose(acc, t, s, fx, seed);
}
