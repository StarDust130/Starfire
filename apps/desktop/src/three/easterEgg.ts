import { addBone, clamp, deg, type PoseTarget } from "./pose";

export type EasterEggKind = "spin" | "jump" | "dance";

export const EASTER_EGG_STREAK = 5;

export const EASTER_EGG_WINDOW_S = 2;

export type EasterEgg = {
  kind: EasterEggKind;
  startedAt: number;
  duration: number;
};

export function chooseEasterEgg(previous: EasterEggKind | null): EasterEggKind {
  const pool: EasterEggKind[] = ["spin", "jump", "dance"];

  const options = pool.filter((kind) => kind !== previous);

  return options[Math.floor(Math.random() * options.length)] ?? "spin";
}

export function startEasterEgg(
  kind: EasterEggKind,
  startedAt: number,
): EasterEgg {
  const duration = kind === "spin" ? 1.15 : kind === "jump" ? 1.0 : 1.7;

  return {
    kind,
    startedAt,
    duration,
  };
}

function easeInOutQuad(value: number): number {
  return value < 0.5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2;
}

/*
 * Envelope: fast attack, gentle release, flat hold between.
 */
function envelope(t: number, duration: number): number {
  return clamp(Math.min(t / 0.15, (duration - t) / 0.3, 1), 0, 1);
}

export type EasterEggResult = {
  spinYawDeg: number;
  env: number;
};

/*
 * ---------------------------------------------------
 * EASTER EGGS (instant layer only — fast, punchy, and
 * every channel starts and ends at exactly zero)
 * ---------------------------------------------------
 *
 * spin  — a full 360deg twirl on the whole body, arms slightly
 *         out, tiny hop, head doing one curious look-around.
 * jump  — crouch anticipation, airborne tuck, soft landing dip.
 * dance — two on-beat hops with hip sway, shoulder
 *         counter-rotation and alternating arm raises.
 *
 * s / fx are the calibrated signs from the rig, so all three read
 * correctly on both VRM 0.x and 1.x models.
 */
export function applyEasterEgg(
  acc: PoseTarget,
  egg: EasterEgg,
  elapsed: number,
  s: number,
  fx: number,
): EasterEggResult {
  const t = elapsed - egg.startedAt;

  const p = clamp(t / egg.duration, 0, 1);

  const env = envelope(t, egg.duration);

  if (egg.kind === "spin") {
    const spinYawDeg = 360 * easeInOutQuad(p);

    acc.bounce += Math.sin(p * Math.PI) * 0.012 * env;

    addBone(acc, "leftUpperArm", 0, 0, -s * deg(10) * env);
    addBone(acc, "rightUpperArm", 0, 0, s * deg(10) * env);
    addBone(acc, "leftLowerArm", 0, 0, s * deg(8) * env);
    addBone(acc, "rightLowerArm", 0, 0, -s * deg(8) * env);
    addBone(acc, "head", 0, Math.sin(p * Math.PI * 2) * deg(4) * env, 0);

    return { spinYawDeg, env };
  }

  if (egg.kind === "jump") {
    const crouchEnd = 0.22;
    const landStart = 0.72;

    if (t < crouchEnd) {
      const c = t / crouchEnd;
      const dip = Math.sin(c * Math.PI);

      acc.bounce -= 0.02 * dip;

      addBone(acc, "leftUpperLeg", fx * deg(24) * dip, 0, 0);
      addBone(acc, "rightUpperLeg", fx * deg(24) * dip, 0, 0);
      addBone(acc, "leftLowerLeg", -fx * deg(28) * dip, 0, 0);
      addBone(acc, "rightLowerLeg", -fx * deg(28) * dip, 0, 0);
      addBone(acc, "spine", fx * deg(6) * dip, 0, 0);
      addBone(acc, "head", fx * deg(3) * dip, 0, 0);
    } else if (t < egg.duration * landStart + 0.06) {
      const flight = clamp(
        (t - crouchEnd) / (egg.duration * landStart - crouchEnd),
        0,
        1,
      );
      const arc = Math.sin(flight * Math.PI);

      acc.bounce += 0.055 * arc;

      addBone(acc, "leftUpperLeg", fx * deg(38) * arc, 0, 0);
      addBone(acc, "rightUpperLeg", fx * deg(38) * arc, 0, 0);
      addBone(acc, "leftLowerLeg", -fx * deg(46) * arc, 0, 0);
      addBone(acc, "rightLowerLeg", -fx * deg(46) * arc, 0, 0);
      addBone(acc, "leftUpperArm", 0, 0, -s * deg(9) * arc);
      addBone(acc, "rightUpperArm", 0, 0, s * deg(9) * arc);
      addBone(acc, "spine", -fx * deg(3) * arc, 0, 0);
      addBone(acc, "head", -fx * deg(4) * arc, 0, 0);
    } else {
      const land = clamp(
        (t - egg.duration * landStart - 0.06) /
          (egg.duration * (1 - landStart) - 0.06),
        0,
        1,
      );
      const dip = Math.sin(land * Math.PI);

      acc.bounce -= 0.014 * dip;

      addBone(acc, "leftUpperLeg", fx * deg(18) * dip, 0, 0);
      addBone(acc, "rightUpperLeg", fx * deg(18) * dip, 0, 0);
      addBone(acc, "leftLowerLeg", -fx * deg(20) * dip, 0, 0);
      addBone(acc, "rightLowerLeg", -fx * deg(20) * dip, 0, 0);
      addBone(acc, "spine", fx * deg(4) * dip, 0, 0);
    }

    return { spinYawDeg: 0, env };
  }

  /*
   * dance
   */
  const beat = Math.sin(t * Math.PI * 2 * 1.15);
  const hop = Math.abs(beat);
  const turn = Math.sin(t * Math.PI * 2 * 0.575 + 1);

  const leftRaise = Math.max(0, beat);
  const rightRaise = Math.max(0, -beat);

  acc.bounce += hop * 0.01 * env;

  addBone(acc, "hips", 0, 0, beat * deg(4) * env);
  addBone(acc, "spine", 0, turn * deg(6) * env, -beat * deg(3) * env);
  addBone(
    acc,
    "head",
    0,
    turn * deg(6) * env,
    Math.sin(t * Math.PI * 2 * 1.15 + 0.6) * deg(5) * env,
  );

  addBone(acc, "leftUpperArm", 0, 0, -s * deg(13) * leftRaise * env);
  addBone(acc, "leftLowerArm", 0, 0, s * deg(12) * leftRaise * env);
  addBone(acc, "rightUpperArm", 0, 0, s * deg(13) * rightRaise * env);
  addBone(acc, "rightLowerArm", 0, 0, -s * deg(12) * rightRaise * env);

  return { spinYawDeg: 0, env };
}
