import type { VRM } from "@pixiv/three-vrm";

import {
  addBone,
  clamp,
  deg,
  findExpression,
  type PoseTarget,
  type Rig,
  setBone,
} from "./pose";

export type ActivityKind = "sit" | "sleep" | "look-around" | "groove";

export type Activity = {
  kind: ActivityKind;
  startedAt: number;
  hold: number;
  zzz: boolean;
  side: number;
};

export function startActivity(kind: ActivityKind, startedAt: number): Activity {
  return {
    kind,
    startedAt,
    hold: holdFor(kind),
    zzz: kind === "sleep",
    side: Math.random() < 0.5 ? -1 : 1,
  };
}

// ⏱️ Decide how long Starfire stays in each activity before changing
function holdFor(kind: ActivityKind): number {
  // 😴 Sleep longer so Starfire feels calm and relaxed
  if (kind === "sleep") {
    return 20 + Math.random() * 30; // ⏱️ 20–50 sec (avg ~35 sec)
  }

  // 🪑 Sit for a short random time
  if (kind === "sit") {
    return 6 + Math.random() * 4; // ⏱️ 6–10 sec (avg ~8 sec)
  }

  // 👀 Look around briefly before doing something else
  if (kind === "look-around") {
    return 3.5 + Math.random() * 2; // ⏱️ 3.5–5.5 sec (avg ~4.5 sec)
  }

  // ✨ Default activity duration
  return 3 + Math.random() * 1.2; // ⏱️ 3–4.2 sec (avg ~3.6 sec)
}

export function chooseActivity(previous: ActivityKind | null): ActivityKind {
  /*
   * Weighted pool: sitting and looking around are the most common,
   * sleeping and grooving are the special treats.
   */
  const pool: ActivityKind[] = [
    "sit",
    "sit",
    "look-around",
    "look-around",
    "sleep",
    "groove",
  ];

  const options = pool.filter((kind) => kind !== previous);

  return options[Math.floor(Math.random() * options.length)] ?? "look-around";
}

export function breathingFor(kind: ActivityKind | null): {
  rate: number;
  scale: number;
} {
  if (kind === "sleep") {
    return { rate: 0.55, scale: 2.4 };
  }

  if (kind === "sit") {
    return { rate: 1.15, scale: 1.2 };
  }

  return { rate: 1.4, scale: 1 };
}

export function activityExpression(
  vrm: VRM,
  kind: ActivityKind,
): string | null {
  if (kind === "look-around") {
    return findExpression(vrm, ["curious", "relaxed"]);
  }

  if (kind === "groove") {
    return findExpression(vrm, ["happy", "relaxed"]);
  }

  if (kind === "sit") {
    return findExpression(vrm, ["relaxed"]);
  }

  return null;
}

export function activityExpressionAmount(kind: ActivityKind): number {
  if (kind === "groove") {
    return 0.5;
  }

  if (kind === "look-around") {
    return 0.3;
  }

  if (kind === "sit") {
    return 0.18;
  }

  return 0;
}

/*
 * ---------------------------------------------------
 * SIT — a clean chair-sit, calibrated to this model
 * ---------------------------------------------------
 *
 * Geometry (derived, not guessed):
 *  - Thighs rotate forward to horizontal (84deg).
 *  - Shins counter-rotate to vertical (78deg) so her feet stay on
 *    the floor with a slight natural knee bend.
 *  - Her hips lower by EXACTLY her measured thigh length — that is
 *    what keeps the legs from penetrating the floor/skirt mesh and
 *    makes the pose read as real sitting instead of a glitch.
 *  - Arms rest forward, hands toward her knees.
 *
 * Sign conventions (matching the calibrated base pose):
 *  - Hanging limbs (thighs, shins, forearms) tip TOWARD the camera
 *    with `fx`.
 */
function sitPose(target: PoseTarget, t: number, rig: Rig): void {
  const fx = rig.forwardX;
  const s = rig.armSign;

  const rock = Math.sin(t * 1.05);
  const breatheArm = Math.sin(t * 1.6) * 1.5;

  const thighDeg = 84;
  const shinDeg = 78;

  setBone(target, "leftUpperLeg", fx * deg(thighDeg), 0, 0);
  setBone(target, "rightUpperLeg", fx * deg(thighDeg), 0, 0);
  setBone(target, "leftLowerLeg", -fx * deg(shinDeg), 0, 0);
  setBone(target, "rightLowerLeg", -fx * deg(shinDeg), 0, 0);

  setBone(target, "spine", 0, 0, rock * deg(1.2));
  setBone(target, "hips", 0, 0, -rock * deg(0.8));

  setBone(
    target,
    "head",
    -deg(2) + rock * deg(0.7),
    Math.sin(t * 0.5) * deg(4),
    rock * deg(1.6),
  );

  setBone(target, "leftShoulder", fx * deg(3), 0, s * deg(4));
  setBone(target, "rightShoulder", fx * deg(3), 0, -s * deg(4));

  setBone(target, "leftUpperArm", fx * deg(16 + breatheArm), 0, s * deg(5));
  setBone(target, "rightUpperArm", fx * deg(16 + breatheArm), 0, -s * deg(5));
  setBone(target, "leftLowerArm", fx * deg(30), 0, s * deg(6));
  setBone(target, "rightLowerArm", fx * deg(30), 0, -s * deg(6));

  target.positionY = -clamp(rig.legUpperLen, 0.08, 0.32);
  target.lookY = 0.1;
}

/*
 * SLEEP — head tipped to one side, body slumped, deep slow breathing.
 * Eyes are forced closed by the scene; Zzz is shown by React.
 */
function sleepPose(
  target: PoseTarget,
  t: number,
  activity: Activity,
  rig: Rig,
): void {
  const s = rig.armSign;

  const sway = Math.sin(t * 0.55);
  const bob = Math.sin(t * 1.1);

  setBone(
    target,
    "head",
    deg(6) + bob * deg(0.7),
    sway * deg(2),
    activity.side * deg(11) + sway * deg(1.2),
  );
  setBone(target, "spine", deg(2.5), sway * deg(1), -activity.side * deg(2));
  setBone(target, "hips", 0, 0, activity.side * deg(1.2));
  setBone(target, "leftShoulder", 0, 0, s * deg(2));
  setBone(target, "rightShoulder", 0, 0, -s * deg(2));
  setBone(target, "leftUpperArm", 0, 0, s * deg(2.5));
  setBone(target, "rightUpperArm", 0, 0, -s * deg(2.5));

  target.positionY = -0.02;
}

/*
 * LOOK AROUND — slow curious scans left and right.
 */
function lookAroundPose(target: PoseTarget, t: number): void {
  const sweep = Math.sin(t * 0.85);

  setBone(target, "head", 0, sweep * deg(13), -sweep * deg(2.5));
  setBone(target, "spine", 0, sweep * deg(2), 0);

  target.lookX = sweep * 0.35;
}

/*
 * GROOVE — slow weight shift lives in the damped layer...
 */
function groovePose(target: PoseTarget, t: number, rig: Rig): void {
  const s = rig.armSign;

  const sway = Math.sin(t * Math.PI * 2 * 0.725);

  setBone(target, "hips", 0, 0, sway * deg(2.2));
  setBone(target, "spine", 0, 0, -sway * deg(2.2));
  setBone(target, "head", 0, sway * deg(3), sway * deg(2));
  setBone(target, "leftUpperArm", 0, 0, s * deg(4) * sway);
  setBone(target, "rightUpperArm", 0, 0, -s * deg(4) * sway);
}

/*
 * ...and the rhythmic beat lives in the INSTANT layer, because the
 * damped layer would soften a 1.45Hz bounce into mush.
 */
function grooveLife(
  acc: PoseTarget,
  t: number,
  activity: Activity,
  rig: Rig,
): void {
  const s = rig.armSign;

  const beat = Math.sin(t * Math.PI * 2 * 1.45);
  const hop = Math.abs(beat);

  const ramp =
    Math.min(1, t / 0.35) * Math.min(1, Math.max(0, (activity.hold - t) / 0.4));

  acc.bounce += hop * 0.009 * ramp;

  addBone(acc, "head", (hop - 0.5) * deg(2) * ramp, 0, 0);
  addBone(acc, "leftShoulder", 0, 0, s * deg(3) * Math.max(0, beat) * ramp);
  addBone(acc, "rightShoulder", 0, 0, -s * deg(3) * Math.max(0, -beat) * ramp);
  addBone(acc, "leftLowerArm", 0, 0, s * deg(9) * Math.max(0, beat) * ramp);
  addBone(acc, "rightLowerArm", 0, 0, -s * deg(9) * Math.max(0, -beat) * ramp);
}

/*
 * Slow parts of the active activity, written into the damped target.
 */
export function applyActivityPose(
  target: PoseTarget,
  activity: Activity,
  t: number,
  rig: Rig,
): void {
  if (activity.kind === "sit") {
    sitPose(target, t, rig);
  } else if (activity.kind === "sleep") {
    sleepPose(target, t, activity, rig);
  } else if (activity.kind === "look-around") {
    lookAroundPose(target, t);
  } else {
    groovePose(target, t, rig);
  }
}

/*
 * Fast rhythmic parts, added into the instant accumulator.
 */
export function applyActivityLife(
  acc: PoseTarget,
  activity: Activity,
  t: number,
  rig: Rig,
): void {
  if (activity.kind === "groove") {
    grooveLife(acc, t, activity, rig);
  }
}
