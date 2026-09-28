import { type PoseTarget, addBone, clamp, deg } from "./pose";

export type VoiceAnimState =
  | "user-speaking"
  | "thinking"
  | "assistant-speaking";

/*
 * VOICE ANIMATION LAYER (instant layer, additive; the scene resets
 * its accumulator every frame, so nothing accumulates).
 *
 * assistant-speaking: audio-level-driven head bob, lean-in, gentle
 * sway, shoulder life, ALTERNATING HAND RAISES emphasised by a
 * syllable-ish pulse, all scaling with loudness.
 * user-speaking: attentive tilt + occasional micro-nod.
 * thinking: chin-hand pose, thoughtful head wander, gentle rock.
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
    /*
     * Syllable-ish beat: rhythmic emphasis pulses tied to talking.
     */
    const pulse = Math.max(0, Math.sin(t * 6.4)) ** 3;

    const bob = Math.sin(t * 7.3) * deg(0.8 + 1.8 * lv);

    const nod = Math.max(0, Math.sin(t * 0.9)) ** 24;

    const sway = Math.sin(t * 1.1) * deg(1.0);

    const shoulder = Math.sin(t * 3.1) * deg(1.0 + 1.6 * lv);

    /*
     * Alternating hand raises: every ~2.4s the active hand switches;
     * lift amount grows with loudness, elbow accentuated by the beat.
     */
    const cycle = Math.sin((t * Math.PI * 2) / 2.4);

    const leftPhase = Math.max(0, cycle);

    const rightPhase = Math.max(0, -cycle);

    const lift = deg(1.2) + deg(3.2) * lv;

    const elbow = (deg(3.5) + deg(3.5) * lv) * (0.35 + 0.65 * pulse);

    addBone(
      acc,
      "head",
      bob + nod * deg(2.6),
      Math.sin(t * 1.7) * deg(1.1) * lv,
      sway,
    );

    addBone(
      acc,
      "spine",
      fx * deg(1.5) * lv,
      Math.sin(t * 0.7) * deg(0.9) * lv,
      sway * 0.5,
    );

    addBone(acc, "leftShoulder", 0, 0, -s * shoulder);

    addBone(acc, "rightShoulder", 0, 0, s * shoulder);

    addBone(acc, "leftUpperArm", 0, 0, s * lift * leftPhase);

    addBone(
      acc,
      "leftLowerArm",
      fx * deg(1.2) * leftPhase * lv,
      0,
      s * elbow * leftPhase,
    );

    addBone(acc, "rightUpperArm", 0, 0, -s * lift * rightPhase);

    addBone(
      acc,
      "rightLowerArm",
      fx * deg(1.2) * rightPhase * lv,
      0,
      -s * elbow * rightPhase,
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
   * thinking — chin-hand pose, thoughtful head wander, gentle rock.
   * The scene also lifts her gaze up and away.
   */
  const thinkNod = Math.max(0, Math.sin(t * 0.35)) ** 24;

  const rock = Math.sin(t * 0.55);

  addBone(
    acc,
    "head",
    Math.sin(t * 0.5) * deg(1.2) + thinkNod * deg(2),
    Math.sin(t * 0.6) * deg(2),
    fx * deg(2.5) * Math.sin(t * 0.4),
  );

  addBone(acc, "spine", fx * deg(0.8), 0, rock * deg(0.5));

  addBone(acc, "rightUpperArm", 0, 0, -s * deg(2.5));

  addBone(acc, "rightLowerArm", fx * deg(1.5), 0, -s * deg(8.5 + rock * 0.8));

  addBone(acc, "leftLowerArm", 0, 0, s * deg(1.5));
}
