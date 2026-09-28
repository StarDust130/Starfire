import { clamp, deg } from "./pose";

export type DragFeelState = {
  springX: number;
  springY: number;
  springVX: number;
  springVY: number;

  winVX: number;
  winVY: number;

  lean: number;
  yaw: number;
  pitch: number;
  dirYaw: number;

  lastX: number;
  lastY: number;
  inited: boolean;
};

export type DragFeelResult = {
  offsetX: number;
  offsetY: number;
  leanDeg: number;
  yawDeg: number;
  pitchDeg: number;
  dirYawDeg: number;
  speed: number;
};

export function createDragFeelState(): DragFeelState {
  return {
    springX: 0,
    springY: 0,
    springVX: 0,
    springVY: 0,

    winVX: 0,
    winVY: 0,

    lean: 0,
    yaw: 0,
    pitch: 0,
    dirYaw: 0,

    lastX: 0,
    lastY: 0,
    inited: false,
  };
}

const SPRING_STIFFNESS = 46;
const SPRING_DAMPING = 9.5;

const POSE_RATE = 8;

/*
 * Whole-body turn toward the drag direction. Softened so she
 * glides into the turn instead of cranking sideways.
 */
const WALK_YAW_GAIN = 0.014;
const WALK_YAW_MAX = 18;

/*
 * The window position is injected by the caller so this module has
 * no hidden global dependency and is fully unit-testable.
 */
export function updateDragFeel(
  state: DragFeelState,
  dt: number,
  dragging: boolean,
  sign: number,
  windowX: number,
  windowY: number,
): DragFeelResult {
  if (!state.inited) {
    state.lastX = windowX;
    state.lastY = windowY;
    state.inited = true;
  }

  const step = Math.max(dt, 1e-3);

  const rawVX = (windowX - state.lastX) / step;
  const rawVY = (windowY - state.lastY) / step;

  state.lastX = windowX;
  state.lastY = windowY;

  const smooth = Math.min(1, dt * 14);

  state.winVX += (rawVX - state.winVX) * smooth;
  state.winVY += (rawVY - state.winVY) * smooth;

  /*
   * Body lag: she trails behind the motion while carried,
   * then springs back to center on release.
   */
  const targetX = dragging ? clamp(-state.winVX * 2.6e-5, -0.05, 0.05) : 0;
  const targetY = dragging ? clamp(state.winVY * 2.6e-5, -0.05, 0.05) : 0;

  state.springVX +=
    ((targetX - state.springX) * SPRING_STIFFNESS -
      state.springVX * SPRING_DAMPING) *
    dt;
  state.springX += state.springVX * dt;

  state.springVY +=
    ((targetY - state.springY) * SPRING_STIFFNESS -
      state.springVY * SPRING_DAMPING) *
    dt;
  state.springY += state.springVY * dt;

  const leanTarget = dragging ? clamp(sign * state.winVX * 0.004, -4, 4) : 0;
  const yawTarget = dragging ? clamp(sign * state.winVX * 0.0022, -5, 5) : 0;
  const pitchTarget = dragging ? clamp(sign * state.winVY * 0.0016, -3, 3) : 0;
  const dirYawTarget = dragging
    ? clamp(state.winVX * WALK_YAW_GAIN, -WALK_YAW_MAX, WALK_YAW_MAX)
    : 0;

  const poseRate = Math.min(1, dt * POSE_RATE);

  state.lean += (leanTarget - state.lean) * poseRate;
  state.yaw += (yawTarget - state.yaw) * poseRate;
  state.pitch += (pitchTarget - state.pitch) * poseRate;
  state.dirYaw += (dirYawTarget - state.dirYaw) * poseRate;

  return {
    offsetX: state.springX,
    offsetY: state.springY,
    leanDeg: state.lean,
    yawDeg: state.yaw,
    pitchDeg: state.pitch,
    dirYawDeg: state.dirYaw,
    speed: Math.hypot(state.winVX, state.winVY),
  };
}

export type WalkCycle = {
  leftUpperX: number;
  rightUpperX: number;
  leftLowerX: number;
  rightLowerX: number;
  leftArmX: number;
  rightArmX: number;
  bob: number;
  hipRollZ: number;
  spineYawY: number;
  leanX: number;
  headCompX: number;
};

const STEP_FREQ = 2.1;

/*
 * ---------------------------------------------------
 * CARRY WALK — shaped like a real gait, not a raw sine
 * ---------------------------------------------------
 *
 *  - Thighs swing sinusoidally (16deg at full intensity).
 *  - Knees flex ONLY during the swing-through window of each leg
 *    (cos-gated), peaking just before mid-swing — the defining
 *    feature that separates a walk from a pendulum.
 *  - Arms counter-swing against the opposite leg (6deg).
 *  - Hips roll toward the planted side; shoulders counter-rotate
 *    against the hips (real gait pelvis/shoulder opposition).
 *  - She leans forward into the walk with speed; the head
 *    counter-pitches to keep her gaze level.
 *  - Bob peaks twice per stride.
 *
 * fx is the calibrated "toward camera" sign for hanging limbs.
 */
export function carryWalk(t: number, intensity: number, fx: number): WalkCycle {
  if (intensity <= 0) {
    return {
      leftUpperX: 0,
      rightUpperX: 0,
      leftLowerX: 0,
      rightLowerX: 0,
      leftArmX: 0,
      rightArmX: 0,
      bob: 0,
      hipRollZ: 0,
      spineYawY: 0,
      leanX: 0,
      headCompX: 0,
    };
  }

  const phase = t * Math.PI * 2 * STEP_FREQ;

  const sinL = Math.sin(phase);
  const sinR = Math.sin(phase + Math.PI);

  const swing = deg(16) * intensity;
  const knee = deg(22) * intensity;
  const armSwing = deg(6) * intensity;

  /*
   * Knee flexion window: the leg bends while it travels forward,
   * peaking slightly before mid-swing (cos gated, phase-shifted).
   */
  const kneeL = Math.max(0, Math.cos(phase - 0.55)) * knee;
  const kneeR = Math.max(0, Math.cos(phase + Math.PI - 0.55)) * knee;

  const sway = sinL;

  return {
    leftUpperX: sinL * swing * fx,
    rightUpperX: sinR * swing * fx,

    leftLowerX: kneeL * -fx,
    rightLowerX: kneeR * -fx,

    leftArmX: sinR * armSwing * fx,
    rightArmX: sinL * armSwing * fx,

    bob: Math.abs(sinL) * 0.005 * intensity,

    hipRollZ: -sway * deg(2.2) * intensity,
    spineYawY: sinR * deg(2) * intensity,
    leanX: fx * deg(3.2) * intensity,
    headCompX: -fx * deg(1.6) * intensity,
  };
}
