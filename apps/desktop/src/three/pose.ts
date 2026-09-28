import type { VRM } from "@pixiv/three-vrm";

import * as THREE from "three";

export type StarfireBoneName =
  | "head"
  | "spine"
  | "hips"
  | "leftShoulder"
  | "rightShoulder"
  | "leftUpperArm"
  | "rightUpperArm"
  | "leftLowerArm"
  | "rightLowerArm"
  | "leftHand"
  | "rightHand"
  | "leftUpperLeg"
  | "rightUpperLeg"
  | "leftLowerLeg"
  | "rightLowerLeg";

export const STARFIRE_BONES: readonly StarfireBoneName[] = [
  "head",
  "spine",
  "hips",
  "leftShoulder",
  "rightShoulder",
  "leftUpperArm",
  "rightUpperArm",
  "leftLowerArm",
  "rightLowerArm",
  "leftHand",
  "rightHand",
  "leftUpperLeg",
  "rightUpperLeg",
  "leftLowerLeg",
  "rightLowerLeg",
];

export type PoseOffset = {
  x: number;
  y: number;
  z: number;
};

/*
 * A full pose as offsets from the calibrated relaxed base.
 * bones are damped; bounce passes through instantly.
 */
export type PoseTarget = {
  bones: Record<StarfireBoneName, PoseOffset>;
  positionY: number;
  lookX: number;
  lookY: number;
  bounce: number;
};

export function createPoseTarget(): PoseTarget {
  const bones = {} as Record<StarfireBoneName, PoseOffset>;

  for (const name of STARFIRE_BONES) {
    bones[name] = { x: 0, y: 0, z: 0 };
  }

  return {
    bones,
    positionY: 0,
    lookX: 0,
    lookY: 0,
    bounce: 0,
  };
}

export function resetPoseTarget(target: PoseTarget): void {
  for (const name of STARFIRE_BONES) {
    const offset = target.bones[name];

    offset.x = 0;
    offset.y = 0;
    offset.z = 0;
  }

  target.positionY = 0;
  target.lookX = 0;
  target.lookY = 0;
  target.bounce = 0;
}

export function setBone(
  target: PoseTarget,
  name: StarfireBoneName,
  x: number,
  y: number,
  z: number,
): void {
  const offset = target.bones[name];

  offset.x = x;
  offset.y = y;
  offset.z = z;
}

export function addBone(
  target: PoseTarget,
  name: StarfireBoneName,
  x: number,
  y: number,
  z: number,
): void {
  const offset = target.bones[name];

  offset.x += x;
  offset.y += y;
  offset.z += z;
}

/*
 * Exponential damping toward a target pose. This single function
 * gives every posture transition its smooth, organic feel.
 */
export function dampPoseTarget(
  current: PoseTarget,
  target: PoseTarget,
  rate: number,
): void {
  for (const name of STARFIRE_BONES) {
    const c = current.bones[name];
    const t = target.bones[name];

    c.x += (t.x - c.x) * rate;
    c.y += (t.y - c.y) * rate;
    c.z += (t.z - c.z) * rate;
  }

  current.positionY += (target.positionY - current.positionY) * rate;
  current.lookX += (target.lookX - current.lookX) * rate;
  current.lookY += (target.lookY - current.lookY) * rate;
}

export type BoneRig = {
  bone: THREE.Object3D;
  baseX: number;
  baseY: number;
  baseZ: number;
};

export type Rig = {
  armSign: number;
  forwardX: number;

  /*
   * Measured thigh segment length (hip joint -> knee joint) in
   * world units after scene scaling. Used by the sit pose so her
   * hips drop by exactly the right amount and her feet stay
   * planted on the floor.
   */
  legUpperLen: number;

  bones: Partial<Record<StarfireBoneName, BoneRig>>;
  head: BoneRig | null;
};

export type HeadAnchor = {
  x: number;
  y: number;
  r: number;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function deg(value: number): number {
  return THREE.MathUtils.degToRad(value);
}

export function findExpression(vrm: VRM, names: string[]): string | null {
  for (const name of names) {
    if (vrm.expressionManager?.getExpression(name)) {
      return name;
    }
  }

  return null;
}

export function setExpression(
  vrm: VRM,
  name: string | null,
  value: number,
): void {
  if (!name) {
    return;
  }

  const manager = vrm.expressionManager;

  if (!manager) {
    return;
  }

  if (!manager.getExpression(name)) {
    return;
  }

  manager.setValue(name, clamp(value, 0, 1));
}

/*
 * Hide accidental environment objects inside the VRM.
 */
export function removeObviousEnvironment(vrm: VRM): void {
  const environmentNames =
    /background|backdrop|stage|studio|environment|billboard|screen|starfield/i;

  vrm.scene.traverse((object) => {
    const name = object.name.toLowerCase();

    if (environmentNames.test(name)) {
      object.visible = false;
    }

    if (object instanceof THREE.Sprite) {
      object.visible = false;
    }
  });
}

export function getNormalizedBone(
  vrm: VRM,
  name: StarfireBoneName,
): THREE.Object3D | null {
  return vrm.humanoid.getNormalizedBoneNode(name) ?? null;
}

function captureBone(vrm: VRM, name: StarfireBoneName): BoneRig | null {
  const bone = getNormalizedBone(vrm, name);

  if (!bone) {
    return null;
  }

  return {
    bone,
    baseX: bone.rotation.x,
    baseY: bone.rotation.y,
    baseZ: bone.rotation.z,
  };
}

/*
 * Angle of the a->b segment below the horizontal plane, in degrees.
 * Uses |dx| so it works for either arm.
 */
function angleBelowHorizontalDeg(
  from: THREE.Vector3,
  to: THREE.Vector3,
): number {
  const dx = Math.abs(to.x - from.x);
  const dy = from.y - to.y;

  return THREE.MathUtils.radToDeg(Math.atan2(dy, Math.max(dx, 1e-4)));
}

/*
 * Absolute pose targets (degrees below horizontal, from outward):
 * upper arm 52deg down, forearm 102deg = 12deg past vertical
 * angled slightly inward -> a clearly visible natural elbow bend.
 */
const TARGET_UPPER_DEG = 52;
const TARGET_FOREARM_DEG = 102;

const SHOULDER_DROP_DEG = 2.5;

const FOREARM_FORWARD_DEG = 6;

/*
 * Self-calibrating relaxed pose.
 *
 * 1. Probe discovers the correct arm rotation direction for THIS
 *    model empirically (elbow must move DOWN in world space).
 * 2. The model's real rest arm angles are measured (many VRMs ship
 *    with an A-pose rest, not a T-pose).
 * 3. Chain math lands the final world angles exactly on the targets:
 *
 *      appliedUpper = TARGET_UPPER - restUpper
 *      appliedElbow = (TARGET_FOREARM - TARGET_UPPER)
 *                     - (restForearm - restUpper)
 *
 * forwardX is the local X sign that tips forearms toward the camera;
 * it also drives "toward camera" for legs (knees up in the sit pose).
 */
export function createRig(vrm: VRM): Rig {
  vrm.humanoid.resetNormalizedPose();

  const metaVersion = (vrm.meta as { metaVersion?: string }).metaVersion;

  const modelFacesNegativeZ = metaVersion === "0";

  let s = modelFacesNegativeZ ? 1 : -1;

  const probe = new THREE.Vector3();

  const leftUpper = getNormalizedBone(vrm, "leftUpperArm");
  const leftLower = getNormalizedBone(vrm, "leftLowerArm");

  if (leftUpper && leftLower) {
    const yBefore = leftLower.getWorldPosition(probe).y;

    leftUpper.rotation.z += deg(10);

    const yAfter = leftLower.getWorldPosition(probe).y;

    leftUpper.rotation.z -= deg(10);

    s = yAfter < yBefore ? 1 : -1;
  }

  const forwardX = modelFacesNegativeZ ? 1 : -1;

  const calibrate = (
    side: "left" | "right",
  ): { upper: number; lower: number } => {
    const upper = getNormalizedBone(
      vrm,
      side === "left" ? "leftUpperArm" : "rightUpperArm",
    );

    const lower = getNormalizedBone(
      vrm,
      side === "left" ? "leftLowerArm" : "rightLowerArm",
    );

    if (!upper || !lower) {
      return {
        upper: TARGET_UPPER_DEG,
        lower: TARGET_FOREARM_DEG - TARGET_UPPER_DEG,
      };
    }

    const hand = getNormalizedBone(
      vrm,
      side === "left" ? "leftHand" : "rightHand",
    );

    const shoulderPos = upper.getWorldPosition(new THREE.Vector3());
    const elbowPos = lower.getWorldPosition(new THREE.Vector3());
    const handPos = (hand ?? lower).getWorldPosition(new THREE.Vector3());

    const restUpper = angleBelowHorizontalDeg(shoulderPos, elbowPos);
    const restForearm = angleBelowHorizontalDeg(elbowPos, handPos);

    const appliedUpper = clamp(TARGET_UPPER_DEG - restUpper, 0, 85);

    const appliedElbow = clamp(
      TARGET_FOREARM_DEG - TARGET_UPPER_DEG - (restForearm - restUpper),
      0,
      85,
    );

    return {
      upper: appliedUpper,
      lower: appliedElbow,
    };
  };

  const leftCal = calibrate("left");
  const rightCal = calibrate("right");

  /*
   * Measure this model's real thigh segment length (hip -> knee,
   * world units after scene scaling). Distances are rotation
   * invariant, so measuring in the rest pose is exact. This drives
   * the sit pose: hips lower by exactly the thigh length so her
   * feet remain planted on the floor.
   */
  const hipL = getNormalizedBone(vrm, "leftUpperLeg");
  const kneeL = getNormalizedBone(vrm, "leftLowerLeg");

  let legUpperLen = 0.17;

  if (hipL && kneeL) {
    const hipPos = hipL.getWorldPosition(new THREE.Vector3());
    const kneePos = kneeL.getWorldPosition(new THREE.Vector3());

    legUpperLen = Math.max(hipPos.distanceTo(kneePos), 0.05);
  }

  const apply = (
    name: StarfireBoneName,
    x: number,
    y: number,
    z: number,
  ): void => {
    const bone = getNormalizedBone(vrm, name);

    if (!bone) {
      return;
    }

    bone.rotation.set(x, y, z);
  };

  apply("leftUpperArm", 0, 0, s * deg(leftCal.upper));
  apply("rightUpperArm", 0, 0, -s * deg(rightCal.upper));

  apply(
    "leftLowerArm",
    forwardX * deg(FOREARM_FORWARD_DEG),
    0,
    s * deg(leftCal.lower),
  );
  apply(
    "rightLowerArm",
    forwardX * deg(FOREARM_FORWARD_DEG),
    0,
    -s * deg(rightCal.lower),
  );

  apply("leftShoulder", 0, 0, s * deg(SHOULDER_DROP_DEG));
  apply("rightShoulder", 0, 0, -s * deg(SHOULDER_DROP_DEG));

  const bones: Partial<Record<StarfireBoneName, BoneRig>> = {};

  for (const name of STARFIRE_BONES) {
    const captured = captureBone(vrm, name);

    if (captured) {
      bones[name] = captured;
    }
  }

  return {
    armSign: s,
    forwardX,
    legUpperLen,
    bones,
    head: bones.head ?? null,
  };
}
