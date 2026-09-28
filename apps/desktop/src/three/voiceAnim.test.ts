import { describe, expect, it } from "vitest";

import { applyVoiceAnimation, talkingWanderX } from "./voiceAnim";

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
  it("never produces NaN and stays within safe bounds over long episodes", () => {
    const acc = createPoseTarget();

    for (const state of [
      "assistant-speaking",
      "user-speaking",
      "thinking",
    ] as const) {
      for (const level of [0, 0.5, 1, Number.NaN]) {
        for (const seed of [1, 42, 999, 123456]) {
          for (let t = 0; t < 40; t += 0.37) {
            resetPoseTarget(acc);

            applyVoiceAnimation(acc, state, t, 1, -1, level, seed);

            for (const name of Object.keys(acc.bones)) {
              const offset = acc.bones[name as keyof typeof acc.bones];

              expect(Number.isNaN(offset.x)).toBe(false);
              expect(Number.isNaN(offset.y)).toBe(false);
              expect(Number.isNaN(offset.z)).toBe(false);

              /*
               * The hair-touch elbow legitimately reaches ~32deg;
               * everything else stays far below.
               */
              expect(Math.abs(offset.x)).toBeLessThan(deg(45));
              expect(Math.abs(offset.y)).toBeLessThan(deg(45));
              expect(Math.abs(offset.z)).toBeLessThan(deg(45));
            }
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

    applyVoiceAnimation(a, "assistant-speaking", 3.7, 1, -1, 1, 123);

    applyVoiceAnimation(b, "assistant-speaking", 3.7, 1, -1, 1, 123);

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

  it("changes behavior over an episode (multiple distinct stances)", () => {
    const acc = createPoseTarget();

    const buckets = new Set<string>();

    for (let t = 0; t < 40; t += 0.5) {
      resetPoseTarget(acc);

      applyVoiceAnimation(acc, "assistant-speaking", t, 1, -1, 1, 42);

      const left = Math.round(acc.bones.leftLowerArm.z / deg(5));

      const right = Math.round(acc.bones.rightLowerArm.z / deg(5));

      buckets.add(`${left}:${right}`);
    }

    expect(buckets.size).toBeGreaterThanOrEqual(3);
  });

  it("both hands activate at some point during the episode", () => {
    const acc = createPoseTarget();

    let leftMoved = false;

    let rightMoved = false;

    for (let t = 0; t < 40; t += 0.25) {
      resetPoseTarget(acc);

      applyVoiceAnimation(acc, "assistant-speaking", t, 1, -1, 1, 42);

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

  it("the hair touch occurs for some seeds (deep elbow bend)", () => {
    let found = false;

    for (let seed = 0; seed < 40 && !found; seed += 1) {
      for (let t = 0; t < 20 && !found; t += 0.4) {
        const acc = createPoseTarget();

        applyVoiceAnimation(acc, "assistant-speaking", t, 1, -1, 1, seed);

        if (Math.abs(acc.bones.leftLowerArm.z) > deg(20)) {
          found = true;
        }

        if (Math.abs(acc.bones.rightLowerArm.z) > deg(20)) {
          found = true;
        }
      }
    }

    expect(found).toBe(true);
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

describe("talkingWanderX", () => {
  it("stays tiny, bounded, and NaN-free", () => {
    for (let t = 0; t < 60; t += 0.5) {
      for (const seed of [1, 42, 999]) {
        const x = talkingWanderX(t, seed);

        expect(Number.isNaN(x)).toBe(false);

        expect(Math.abs(x)).toBeLessThanOrEqual(0.02);
      }
    }
  });

  it("is deterministic per seed", () => {
    expect(talkingWanderX(3.3, 42)).toBe(talkingWanderX(3.3, 42));
  });

  it("drifts over time (not constant)", () => {
    const a = talkingWanderX(0, 42);

    const b = talkingWanderX(9, 42);

    expect(Math.abs(a - b)).toBeGreaterThan(0.001);
  });
});
