import { describe, expect, it } from "vitest";

import {
  addBone,
  clamp,
  createPoseTarget,
  dampPoseTarget,
  deg,
  resetPoseTarget,
  STARFIRE_BONES,
} from "./pose";

describe("clamp", () => {
  it("clamps within bounds", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-2, 0, 3)).toBe(0);
    expect(clamp(1.5, 0, 3)).toBe(1.5);
  });
});

describe("deg", () => {
  it("converts degrees to radians", () => {
    expect(deg(180)).toBeCloseTo(Math.PI, 10);
    expect(deg(90)).toBeCloseTo(Math.PI / 2, 10);
  });
});

describe("pose targets", () => {
  it("creates a zeroed target for every bone", () => {
    const target = createPoseTarget();

    for (const name of STARFIRE_BONES) {
      const offset = target.bones[name];

      expect(offset.x).toBe(0);
      expect(offset.y).toBe(0);
      expect(offset.z).toBe(0);
    }

    expect(target.bounce).toBe(0);
  });

  it("addBone accumulates and resetPoseTarget clears", () => {
    const target = createPoseTarget();

    addBone(target, "head", 0.1, 0.2, 0.3);
    addBone(target, "head", 0.1, 0.2, 0.3);

    expect(target.bones.head.x).toBeCloseTo(0.2);
    expect(target.bones.head.y).toBeCloseTo(0.4);

    resetPoseTarget(target);

    expect(target.bones.head.x).toBe(0);
    expect(target.bones.head.y).toBe(0);
  });

  it("dampPoseTarget converges toward the target", () => {
    const current = createPoseTarget();
    const target = createPoseTarget();

    addBone(target, "spine", 1, 0, 0);

    for (let i = 0; i < 120; i += 1) {
      dampPoseTarget(current, target, 0.2);
    }

    expect(current.bones.spine.x).toBeGreaterThan(0.999);
  });

  it("dampPoseTarget never touches bounce (instant layer only)", () => {
    const current = createPoseTarget();
    const target = createPoseTarget();

    target.bounce = 1;

    dampPoseTarget(current, target, 0.5);

    expect(current.bounce).toBe(0);
  });
});
