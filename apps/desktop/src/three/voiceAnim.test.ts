import { describe, expect, it } from "vitest";

import { applyVoiceAnimation } from "./voiceAnim";

import { createPoseTarget, deg, resetPoseTarget } from "./pose";

function checksum(acc: ReturnType<typeof createPoseTarget>): number {
  let sum = 0;

  for (const name of Object.keys(acc.bones)) {
    const offset = acc.bones[name as keyof typeof acc.bones];

    sum += Math.abs(offset.x) + Math.abs(offset.y) + Math.abs(offset.z);
  }

  return sum;
}

describe("applyVoiceAnimation", () => {
  it("never produces NaN and stays within tasteful bounds", () => {
    const acc = createPoseTarget();

    for (const state of [
      "assistant-speaking",
      "user-speaking",
      "thinking",
    ] as const) {
      for (const level of [0, 0.5, 1, Number.NaN]) {
        for (const seed of [1, 42, 999, 123456]) {
          resetPoseTarget(acc);

          applyVoiceAnimation(acc, state, 1.234, 1, -1, level, seed);

          for (const name of Object.keys(acc.bones)) {
            const offset = acc.bones[name as keyof typeof acc.bones];

            expect(Number.isNaN(offset.x)).toBe(false);
            expect(Number.isNaN(offset.y)).toBe(false);
            expect(Number.isNaN(offset.z)).toBe(false);

            expect(Math.abs(offset.x)).toBeLessThan(deg(10));
            expect(Math.abs(offset.y)).toBeLessThan(deg(10));
            expect(Math.abs(offset.z)).toBeLessThan(deg(10));
          }
        }
      }
    }
  });

  it("repeated frames do not accumulate pose rotations", () => {
    const acc = createPoseTarget();

    let reference: number | null = null;

    for (let frame = 0; frame < 200; frame += 1) {
      resetPoseTarget(acc);

      applyVoiceAnimation(acc, "assistant-speaking", 0.5, 1, -1, 1, 42);

      if (reference === null) {
        reference = acc.bones.head.x;
      }

      expect(acc.bones.head.x).toBeCloseTo(reference, 10);
    }
  });

  it("is deterministic for a given seed", () => {
    const a = createPoseTarget();

    const b = createPoseTarget();

    applyVoiceAnimation(a, "assistant-speaking", 0.7, 1, -1, 1, 123);

    applyVoiceAnimation(b, "assistant-speaking", 0.7, 1, -1, 1, 123);

    expect(a.bones.head.x).toBe(b.bones.head.x);

    expect(a.bones.leftLowerArm.z).toBe(b.bones.leftLowerArm.z);
  });

  it("different seeds gesture differently", () => {
    const a = createPoseTarget();

    const b = createPoseTarget();

    applyVoiceAnimation(a, "assistant-speaking", 0.3, 1, -1, 1, 3);

    applyVoiceAnimation(b, "assistant-speaking", 0.3, 1, -1, 1, 7);

    expect(Math.abs(checksum(a) - checksum(b))).toBeGreaterThan(0.001);
  });

  it("talking motion scales with audio level", () => {
    const quiet = createPoseTarget();

    const loud = createPoseTarget();

    applyVoiceAnimation(quiet, "assistant-speaking", 0.5, 1, -1, 0, 42);

    applyVoiceAnimation(loud, "assistant-speaking", 0.5, 1, -1, 1, 42);

    expect(checksum(loud)).toBeGreaterThanOrEqual(checksum(quiet));
  });

  it("both hands activate at some point during a gesture cycle", () => {
    const acc = createPoseTarget();

    let leftMoved = false;

    let rightMoved = false;

    for (let i = 0; i < 60; i += 1) {
      resetPoseTarget(acc);

      applyVoiceAnimation(acc, "assistant-speaking", i * 0.1, 1, -1, 1, 42);

      if (acc.bones.leftLowerArm.z !== 0) {
        leftMoved = true;
      }

      if (acc.bones.rightLowerArm.z !== 0) {
        rightMoved = true;
      }
    }

    expect(leftMoved).toBe(true);

    expect(rightMoved).toBe(true);
  });

  it("thinking produces the chin-hand pose for some seeds", () => {
    let found = false;

    for (let seed = 0; seed < 50 && !found; seed += 1) {
      const acc = createPoseTarget();

      applyVoiceAnimation(acc, "thinking", 1.0, 1, -1, 0, seed);

      if (Math.abs(acc.bones.rightLowerArm.z) > deg(5)) {
        found = true;
      }
    }

    expect(found).toBe(true);
  });

  it("thinking stays bounded for every seed bucket", () => {
    const acc = createPoseTarget();

    for (let seed = 0; seed < 60; seed += 1) {
      resetPoseTarget(acc);

      applyVoiceAnimation(acc, "thinking", 2.5, 1, -1, 0, seed);

      expect(checksum(acc)).toBeLessThan(deg(10) * 15);
    }
  });
});
