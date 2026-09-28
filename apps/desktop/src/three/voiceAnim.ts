import { type PoseTarget, addBone, clamp, deg } from "./pose";

export type VoiceAnimState =
  | "user-speaking"
  | "thinking"
  | "assistant-speaking";

/*
 * ---------------------------------------------------
 * SEEDED VARIETY ENGINE
 * ---------------------------------------------------
 * Every voice episode gets one random seed chosen by the scene.
 * Talking is divided into BEHAVIOR SEGMENTS (2.6-4.4s each): free
 * gestures, folded hands, a hair touch, a weight shift, or a small
 * stance shuffle — crossfaded smoothly, exactly like people change
 * stance while talking. Deterministic per seed, so it is fully
 * testable. Continuous accents (head bob, sway, shrugs, lean) run
 * on top and never pop.
 *
 * The scene resets its accumulator every frame; offsets stay small
 * (the elbow in the hair-touch reaches ~32deg by design).
 */
function hashToUnit(seed: number, salt: number): number {
  const x = Math.sin(seed * 127.1 + salt * 311.7) * 43758.5453;

  return x - Math.floor(x);
}

type TalkBehavior = "gestures" | "fold" | "hair" | "weight" | "shuffle";

function pickBehavior(
  seed: number,
  index: number,
  avoid?: TalkBehavior,
): TalkBehavior {
  const roll = hashToUnit(seed, 200 + index * 13);

  let kind: TalkBehavior;

  if (roll < 0.4) {
    kind = "gestures";
  } else if (roll < 0.58) {
    kind = "fold";
  } else if (roll < 0.73) {
    kind = "hair";
  } else if (roll < 0.88) {
    kind = "weight";
  } else {
    kind = "shuffle";
  }

  if (kind === avoid) {
    kind = "gestures";
  }

  return kind;
}

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

/*
 * Free conversational gestures: alternating hand raises with
 * beat-pulsed elbows and wrist accents.
 */
function behaviorGestures(
  acc: PoseTarget,
  t: number,
  s: number,
  fx: number,
  lv: number,
  seed: number,
  w: number,
): void {
  const phase0 = hashToUnit(seed, 1) * Math.PI * 2;

  const tt = t * 0.95 + phase0;

  const pulse = Math.max(0, Math.sin(tt * 6.4)) ** 3;

  const cycle = Math.sin((t * Math.PI * 2) / 2.4 + phase0);

  const leftPhase = Math.max(0, cycle);

  const rightPhase = Math.max(0, -cycle);

  const bothBeat = (1 - Math.abs(cycle)) ** 2 * hashToUnit(seed, 5);

  const lift = deg(1.2) + deg(3.8) * lv;

  const elbow = (deg(3.2) + deg(3.6) * lv) * (0.35 + 0.65 * pulse);

  const leadHand = hashToUnit(seed, 4) < 0.5 ? 1 : -1;

  const leftAmount = Math.min(
    1,
    (leftPhase * (leadHand > 0 ? 1 : 0.55) + bothBeat * 0.7) * w,
  );

  const rightAmount = Math.min(
    1,
    (rightPhase * (leadHand < 0 ? 1 : 0.55) + bothBeat * 0.7) * w,
  );

  addBone(acc, "leftUpperArm", 0, 0, -s * lift * leftAmount);

  addBone(
    acc,
    "leftLowerArm",
    fx * deg(1.2) * leftAmount * lv,
    s * deg(1.4) * pulse * leftAmount * lv,
    s * elbow * leftAmount,
  );

  addBone(acc, "rightUpperArm", 0, 0, s * lift * rightAmount);

  addBone(
    acc,
    "rightLowerArm",
    fx * deg(1.2) * rightAmount * lv,
    -s * deg(1.4) * pulse * rightAmount * lv,
    -s * elbow * rightAmount,
  );
}

/*
 * Folded hands in front, like holding a notebook — a calm, held
 * stance with a small head tilt.
 */
function behaviorFold(
  acc: PoseTarget,
  s: number,
  fx: number,
  lv: number,
  w: number,
): void {
  const fold = deg(18 + 4 * lv) * w;

  addBone(acc, "leftLowerArm", fx * deg(6) * w, 0, s * fold);

  addBone(acc, "rightLowerArm", fx * deg(6) * w, 0, -s * fold);

  addBone(acc, "head", 0, 0, fx * deg(1.2) * w);
}

/*
 * One hand drifts up to touch her hair/head, head tilting into it.
 * The elbow genuinely bends here (~32deg) — that is the gesture.
 */
function behaviorHair(
  acc: PoseTarget,
  t: number,
  s: number,
  fx: number,
  seed: number,
  index: number,
  w: number,
): void {
  const side = hashToUnit(seed, 300 + index * 13) < 0.5 ? 1 : -1;

  const drift = Math.sin(t * 1.9);

  if (side < 0) {
    addBone(acc, "leftUpperArm", 0, 0, -s * deg(7) * w);

    addBone(
      acc,
      "leftLowerArm",
      fx * deg(6) * w,
      0,
      s * (deg(30) + drift * deg(2.5)) * w,
    );

    addBone(acc, "head", 0, 0, -fx * deg(3) * w);
  } else {
    addBone(acc, "rightUpperArm", 0, 0, s * deg(7) * w);

    addBone(
      acc,
      "rightLowerArm",
      fx * deg(6) * w,
      0,
      -s * (deg(30) + drift * deg(2.5)) * w,
    );

    addBone(acc, "head", 0, 0, fx * deg(3) * w);
  }
}

/*
 * Weight shift: hips settle to one side, torso counters, the free
 * leg relaxes a touch.
 */
function behaviorWeight(
  acc: PoseTarget,
  fx: number,
  seed: number,
  index: number,
  w: number,
): void {
  const side = hashToUnit(seed, 400 + index * 13) < 0.5 ? 1 : -1;

  addBone(acc, "hips", 0, 0, side * deg(2.2) * w);

  addBone(acc, "spine", 0, side * deg(1.0) * w, -side * deg(1.6) * w);

  addBone(acc, "head", 0, 0, side * deg(1.0) * w);

  addBone(
    acc,
    side < 0 ? "leftUpperLeg" : "rightUpperLeg",
    fx * deg(1.5) * w,
    0,
    0,
  );
}

/*
 * Small stance shuffle: feet re-position with a gentle alternating
 * leg motion and hip sway — "moving her weight around".
 */
function behaviorShuffle(
  acc: PoseTarget,
  t: number,
  fx: number,
  w: number,
): void {
  const phase = t * Math.PI * 2 * 0.55;

  const step = Math.sin(phase) * deg(3) * w;

  addBone(acc, "leftUpperLeg", step, 0, 0);

  addBone(acc, "rightUpperLeg", -step, 0, 0);

  addBone(
    acc,
    "leftLowerLeg",
    Math.max(0, Math.sin(phase + 1.4)) * deg(2.5) * w,
    0,
    0,
  );

  addBone(
    acc,
    "rightLowerLeg",
    Math.max(0, Math.sin(phase + 1.4 + Math.PI)) * deg(2.5) * w,
    0,
    0,
  );

  addBone(acc, "hips", 0, 0, Math.sin(phase) * deg(1.2) * w);

  addBone(acc, "spine", fx * deg(0.5) * w, 0, 0);
}

/*
 * ---------------------------------------------------
 * ASSISTANT SPEAKING
 * ---------------------------------------------------
 * Continuous accents (bob, sway, shrug, lean, hip motion) plus the
 * blended behavior timeline.
 */
function talkPose(
  acc: PoseTarget,
  t: number,
  s: number,
  fx: number,
  lv: number,
  seed: number,
): void {
  const segLen = 2.6 + hashToUnit(seed, 7) * 1.8;

  const idx = Math.floor(t / segLen);

  const localT = t - idx * segLen;

  const cur = pickBehavior(seed, idx);

  const nxt = pickBehavior(seed, idx + 1, cur);

  const u = clamp((localT - (segLen - 0.8)) / 0.8, 0, 1);

  const wNext = smoothstep(u);

  const wCur = 1 - wNext;

  const phase0 = hashToUnit(seed, 1) * Math.PI * 2;

  const freq = 0.85 + hashToUnit(seed, 2) * 0.5;

  const energy = 0.65 + hashToUnit(seed, 3) * 0.5;

  const tt = t * freq + phase0;

  const bob = Math.sin(tt * 7.3) * deg(0.8 + 1.8 * lv * energy);

  const nod = Math.max(0, Math.sin(tt * 0.9)) ** 24;

  const sway = Math.sin(tt * 1.1) * deg(1.0 * energy);

  const cycle = Math.sin((t * Math.PI * 2) / 2.4 + phase0);

  const gestureSide = cycle >= 0 ? -1 : 1;

  const shrug =
    Math.max(0, Math.sin(tt * 1.05 + 1.2)) ** 10 * hashToUnit(seed, 6) * lv;

  const shoulderLife =
    deg((1.0 + 1.6 * lv) * energy) * 0.6 + sway * 0.4 + deg(3.2) * shrug;

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

  addBone(
    acc,
    "hips",
    0,
    Math.sin(tt * 0.55) * deg(1.0) * lv,
    -gestureSide * deg(1.0) * lv,
  );

  addBone(acc, "leftShoulder", 0, 0, -s * shoulderLife);

  addBone(acc, "rightShoulder", 0, 0, s * shoulderLife);

  const apply = (kind: TalkBehavior, w: number): void => {
    if (w <= 0.001) {
      return;
    }

    if (kind === "gestures") {
      behaviorGestures(acc, t, s, fx, lv, seed, w);
    } else if (kind === "fold") {
      behaviorFold(acc, s, fx, lv, w);
    } else if (kind === "hair") {
      behaviorHair(acc, t, s, fx, seed, idx, w);
    } else if (kind === "weight") {
      behaviorWeight(acc, fx, seed, idx, w);
    } else {
      behaviorShuffle(acc, t, fx, w);
    }
  };

  apply(cur, wCur);

  apply(nxt, wNext);
}

/*
 * ---------------------------------------------------
 * THINKING
 * ---------------------------------------------------
 * One base pose per episode (seed): chin-hand, look-away, hmm-tilt
 * or still — with a continuous gentle rock so she never freezes.
 * The scene adds wandering gaze and a soft thinking murmur.
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
    addBone(
      acc,
      "head",
      Math.sin(t * 0.45) * deg(1.0),
      Math.sin(t * 0.5) * deg(3.2),
      -Math.sin(t * 0.5) * deg(1.4),
    );

    addBone(acc, "spine", 0, Math.sin(t * 0.5) * deg(0.8), rock * deg(0.4));

    return;
  }

  if (roll < 0.85) {
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

  addBone(acc, "head", Math.sin(t * 0.4) * deg(0.6), rock * deg(0.4), 0);

  addBone(acc, "spine", fx * deg(0.4), 0, rock * deg(0.3));
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

/*
 * Slow seeded body wander: while talking (and faintly while
 * thinking) she drifts a few millimetres around her spot, like a
 * person shifting position. The scene adds this to model.position.x.
 */
export function talkingWanderX(t: number, seed: number): number {
  const a = hashToUnit(seed, 30) * Math.PI * 2;

  const b = hashToUnit(seed, 31) * Math.PI * 2;

  return (Math.sin(t * 0.35 + a) * 0.7 + Math.sin(t * 0.13 + b) * 0.3) * 0.014;
}
