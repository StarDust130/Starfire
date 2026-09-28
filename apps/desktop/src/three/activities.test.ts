import { describe, expect, it } from "vitest";

import {
  activityExpressionAmount,
  applyActivityLife,
  applyActivityPose,
  breathingFor,
  chooseActivity,
  startActivity,
} from "./activities";

import { createPoseTarget, type Rig } from "./pose";

/*
 * The pose functions only read armSign/forwardX/legUpperLen from
 * the rig, so a minimal literal satisfies the type without a VRM.
 */
const fakeRig: Rig = {
  armSign: 1,
  forwardX: -1,
  legUpperLen: 0.18,
  bones: {},
  head: null,
};

describe("chooseActivity", () => {
  it("never repeats the previous activity", () => {
    const kinds = ["sit", "sleep", "look-around", "groove"] as const;

    for (const previous of kinds) {
      for (let i = 0; i < 40; i += 1) {
        expect(chooseActivity(previous)).not.toBe(previous);
      }
    }
  });

  it("returns a valid activity", () => {
    const valid = new Set(["sit", "sleep", "look-around", "groove"]);

    for (let i = 0; i < 40; i += 1) {
      expect(valid.has(chooseActivity(null))).toBe(true);
    }
  });
});

describe("startActivity", () => {
  it("holds sleep for 9-15s and marks zzz", () => {
    for (let i = 0; i < 20; i += 1) {
      const activity = startActivity("sleep", 0);

      expect(activity.hold).toBeGreaterThanOrEqual(9);
      expect(activity.hold).toBeLessThanOrEqual(15);
      expect(activity.zzz).toBe(true);
    }
  });
});

describe("sit pose", () => {
  it("lowers her hips by exactly the measured thigh length", () => {
    const target = createPoseTarget();

    applyActivityPose(target, startActivity("sit", 0), 1.2, fakeRig);

    expect(target.positionY).toBeCloseTo(-fakeRig.legUpperLen, 5);
  });

  it("lifts both knees mirrored, shins folded the opposite way", () => {
    const target = createPoseTarget();

    applyActivityPose(target, startActivity("sit", 0), 1.2, fakeRig);

    expect(target.bones.leftUpperLeg.x).not.toBe(0);

    expect(target.bones.leftUpperLeg.x).toBeCloseTo(
      target.bones.rightUpperLeg.x,
    );

    expect(target.bones.leftLowerLeg.x).toBeCloseTo(
      -target.bones.leftUpperLeg.x * (78 / 84),
      3,
    );
  });
});

describe("sleep pose", () => {
  it("tips the head and stays near standing height", () => {
    const target = createPoseTarget();

    applyActivityPose(target, startActivity("sleep", 0), 2, fakeRig);

    expect(target.bones.head.z).not.toBe(0);
    expect(Math.abs(target.positionY)).toBeLessThan(0.05);
  });
});

describe("look-around pose", () => {
  it("sweeps the head", () => {
    const target = createPoseTarget();

    applyActivityPose(target, startActivity("look-around", 0), 1, fakeRig);

    expect(target.bones.head.y).not.toBe(0);
  });
});

describe("groove life", () => {
  it("adds a bounce on the beat", () => {
    const acc = createPoseTarget();

    applyActivityLife(acc, startActivity("groove", 0), 0.172, fakeRig);

    expect(acc.bounce).toBeGreaterThan(0);
  });
});

describe("breathingFor", () => {
  it("sleeps slower and deeper than standing", () => {
    const sleep = breathingFor("sleep");
    const stand = breathingFor(null);

    expect(sleep.rate).toBeLessThan(stand.rate);
    expect(sleep.scale).toBeGreaterThan(stand.scale);
  });
});

describe("activityExpressionAmount", () => {
  it("groove is stronger than sit", () => {
    expect(activityExpressionAmount("groove")).toBeGreaterThan(
      activityExpressionAmount("sit"),
    );
  });
});
