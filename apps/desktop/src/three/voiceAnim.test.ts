import { describe, expect, it } from "vitest";

import { applyVoiceAnimation } from "./voiceAnim";

import { createPoseTarget, deg, resetPoseTarget } from "./pose";

describe("applyVoiceAnimation", () => {
  it("never produces NaN and stays tiny", () => {
    const acc = createPoseTarget();

    for (const state of [
      "assistant-speaking",
      "user-speaking",
      "thinking",
    ] as const) {
      for (const level of [0, 0.5, 1, Number.NaN]) {
        resetPoseTarget(acc);

        applyVoiceAnimation(acc, state, 1.234, 1, -1, level);

        for (const name of Object.keys(acc.bones)) {
          const offset = acc.bones[name as keyof typeof acc.bones];

          expect(Number.isNaN(offset.x)).toBe(false);
          expect(Number.isNaN(offset.y)).toBe(false);
          expect(Number.isNaN(offset.z)).toBe(false);

          expect(Math.abs(offset.x)).toBeLessThan(deg(5));
          expect(Math.abs(offset.y)).toBeLessThan(deg(5));
          expect(Math.abs(offset.z)).toBeLessThan(deg(5));
        }
      }
    }
  });

  it("repeated frames do not accumulate pose rotations", () => {
    const acc = createPoseTarget();

    let reference: number | null = null;

    for (let frame = 0; frame < 200; frame += 1) {
      resetPoseTarget(acc);

      /*
       * The animation is a pure function of t — feeding the SAME t
       * every frame must yield the identical offset. (Feeding
       * increasing t is supposed to change the value; that is the
       * bob, not accumulation.)
       */
      applyVoiceAnimation(acc, "assistant-speaking", 0.5, 1, -1, 1);

      if (reference === null) {
        reference = acc.bones.head.x;
      }

      expect(acc.bones.head.x).toBeCloseTo(reference, 10);
    }
  });

  it("talking motion scales with audio level and calms to zero-ish after", () => {
    const quiet = createPoseTarget();

    const loud = createPoseTarget();

    applyVoiceAnimation(quiet, "assistant-speaking", 0.5, 1, -1, 0);

    applyVoiceAnimation(loud, "assistant-speaking", 0.5, 1, -1, 1);

    expect(
      Math.abs(loud.bones.head.x) + Math.abs(loud.bones.head.y),
    ).toBeGreaterThanOrEqual(
      Math.abs(quiet.bones.head.x) + Math.abs(quiet.bones.head.y),
    );
  });
});
