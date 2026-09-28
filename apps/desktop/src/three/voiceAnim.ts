import { type PoseTarget, addBone, clamp, deg } from "./pose";

export type VoiceAnimState =
  | "user-speaking"
  | "thinking"
  | "assistant-speaking";

/*
 * VOICE ANIMATION LAYER (instant layer, additive; the scene resets
 * its accumulator every frame, so nothing accumulates).
 *
 * assistant-speaking: audio-level-driven head bob, gentle body sway,
 * shoulder life, small alternating forearm gestures (like a person
 * emphasising words), an occasional tiny nod.
 * user-speaking: attentive tilt + occasional micro-nod, calm mouth.
 * thinking: slow wandering head, a thoughtful tilt, gaze handled by
 * the scene (looks up and away).
 */
export function applyVoiceAnimation(
  acc: PoseTarget,
  state: VoiceAnimState,
  t: number,
  s: number,
  fx: number,
  level: number,
): void {
  const lv = clamp(Number.isFinite(level) ? level : 0, 0, 1);

  if (state === "assistant-speaking") {
    const bob = Math.sin(t * 7.3) * deg(0.6 + 1.6 * lv);

    const sway = Math.sin(t * 1.1) * deg(0.9);

    const nod = Math.max(0, Math.sin(t * 0.9)) ** 24;

    const shoulder = Math.sin(t * 3.1) * deg(0.9 + 1.4 * lv);

    /*
     * Slow alternating hand gestures, emphasised with loudness —
     * the way people move their hands while talking.
     */
    const gesture = Math.sin(t * 2.3);

    const gestureAmount = deg(2.2 + 2.2 * lv);

    addBone(
      acc,
      "head",
      bob + nod * deg(2.6),
      Math.sin(t * 1.7) * deg(1.1) * lv,
      sway,
    );

    addBone(acc, "spine", 0, Math.sin(t * 0.7) * deg(0.9) * lv, sway * 0.5);

    addBone(acc, "leftShoulder", 0, 0, -s * shoulder);

    addBone(acc, "rightShoulder", 0, 0, s * shoulder);

    addBone(
      acc,
      "leftLowerArm",
      fx * deg(1.5) * Math.max(0, gesture) * lv,
      0,
      s * gestureAmount * Math.max(0, gesture),
    );

    addBone(
      acc,
      "rightLowerArm",
      fx * deg(1.5) * Math.max(0, -gesture) * lv,
      0,
      -s * gestureAmount * Math.max(0, -gesture),
    );

    return;
  }

  if (state === "user-speaking") {
    const tilt = Math.sin(t * 0.5) * deg(1.6);

    const nod = Math.max(0, Math.sin(t * 0.8)) ** 24;

    addBone(acc, "head", nod * deg(1.3), fx * tilt, fx * deg(1));

    addBone(acc, "spine", 0, 0, fx * deg(0.4));

    return;
  }

  /*
   * thinking — slow, thoughtful; the scene also lifts her gaze.
   */
  const thinkNod = Math.max(0, Math.sin(t * 0.35)) ** 24;

  addBone(
    acc,
    "head",
    Math.sin(t * 0.5) * deg(1.2) + thinkNod * deg(2),
    Math.sin(t * 0.6) * deg(2),
    Math.sin(t * 0.7) * deg(2.2),
  );

  addBone(acc, "spine", fx * deg(0.6), 0, 0);
}
