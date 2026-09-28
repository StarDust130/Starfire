import { describe, expect, it } from "vitest";

import { applyEasterEgg, chooseEasterEgg, startEasterEgg } from "./easterEgg";

import { createPoseTarget } from "./pose";

describe("chooseEasterEgg", () => {
  it("never repeats the previous egg", () => {
    const kinds = ["spin", "jump", "dance"] as const;

    for (const previous of kinds) {
      for (let i = 0; i < 30; i += 1) {
        expect(chooseEasterEgg(previous)).not.toBe(previous);
      }
    }
  });
});

describe("spin", () => {
  it("completes exactly 360deg, peaking at 180 mid-way", () => {
    const egg = startEasterEgg("spin", 0);

    const mid = applyEasterEgg(
      createPoseTarget(),
      egg,
      egg.duration / 2,
      1,
      -1,
    );

    expect(mid.spinYawDeg).toBeCloseTo(180, 0);

    const end = applyEasterEgg(createPoseTarget(), egg, egg.duration, 1, -1);

    expect(end.spinYawDeg).toBeCloseTo(360, 0);
  });

  it("starts and ends with zero bone offsets", () => {
    const egg = startEasterEgg("spin", 0);

    const startAcc = createPoseTarget();
    const endAcc = createPoseTarget();

    applyEasterEgg(startAcc, egg, 0, 1, -1);
    applyEasterEgg(endAcc, egg, egg.duration, 1, -1);

    expect(startAcc.bones.head.x).toBe(0);
    expect(endAcc.bones.head.x).toBe(0);
  });
});

describe("jump", () => {
  it("is airborne mid-way and grounded at start/end", () => {
    const egg = startEasterEgg("jump", 0);

    const startAcc = createPoseTarget();
    const midAcc = createPoseTarget();
    const endAcc = createPoseTarget();

    applyEasterEgg(startAcc, egg, 0, 1, -1);
    applyEasterEgg(midAcc, egg, egg.duration / 2, 1, -1);
    applyEasterEgg(endAcc, egg, egg.duration, 1, -1);

    expect(startAcc.bounce).toBe(0);
    expect(midAcc.bounce).toBeGreaterThan(0.03);
    expect(endAcc.bounce).toBeCloseTo(0, 6);
  });
});

describe("dance", () => {
  it("bounces on the beat and ends silent", () => {
    const egg = startEasterEgg("dance", 0);

    const onBeat = 0.25 / 1.15;

    const beatAcc = createPoseTarget();
    const endAcc = createPoseTarget();

    applyEasterEgg(beatAcc, egg, onBeat, 1, -1);
    applyEasterEgg(endAcc, egg, egg.duration, 1, -1);

    expect(beatAcc.bounce).toBeGreaterThan(0.005);
    expect(endAcc.bounce).toBeCloseTo(0, 6);
  });
});
