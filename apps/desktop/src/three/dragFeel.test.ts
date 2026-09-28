import { describe, expect, it } from "vitest";

import { carryWalk, createDragFeelState, updateDragFeel } from "./dragFeel";

describe("updateDragFeel", () => {
  it("trails behind horizontal motion and settles after release", () => {
    const state = createDragFeelState();

    let x = 0;

    for (let i = 0; i < 90; i += 1) {
      x += 8;

      updateDragFeel(state, 1 / 60, true, 1, x, 0);
    }

    expect(state.winVX).toBeGreaterThan(0);
    expect(state.springX).toBeLessThan(0);

    for (let i = 0; i < 300; i += 1) {
      updateDragFeel(state, 1 / 60, false, 1, x, 0);
    }

    expect(Math.abs(state.springX)).toBeLessThan(1e-3);
    expect(Math.abs(state.springVX)).toBeLessThan(1e-2);
  });

  it("turns her toward the direction of travel", () => {
    const state = createDragFeelState();

    let x = 0;

    for (let i = 0; i < 120; i += 1) {
      x += 10;

      updateDragFeel(state, 1 / 60, true, 1, x, 0);
    }

    expect(state.dirYaw).toBeGreaterThan(5);
  });

  it("does not turn for purely vertical motion", () => {
    const state = createDragFeelState();

    let y = 0;

    for (let i = 0; i < 120; i += 1) {
      y += 10;

      updateDragFeel(state, 1 / 60, true, 1, 500, y);
    }

    expect(Math.abs(state.dirYaw)).toBeLessThan(0.5);
  });
});

describe("carryWalk", () => {
  it("is silent at zero intensity", () => {
    const walk = carryWalk(0.3, 0, -1);

    expect(walk.leftUpperX).toBe(0);
    expect(walk.rightUpperX).toBe(0);
    expect(walk.bob).toBe(0);
    expect(walk.hipRollZ).toBe(0);
  });

  it("swings legs in opposite phase with positive bob", () => {
    const quarterStep = 0.25 / 2.1;

    const walk = carryWalk(quarterStep, 1, -1);

    expect(walk.leftUpperX).not.toBe(0);
    expect(walk.leftUpperX).toBeCloseTo(-walk.rightUpperX, 6);
    expect(walk.bob).toBeGreaterThan(0);
  });

  it("counter-swings the arms against the legs (6/16 ratio)", () => {
    const quarterStep = 0.25 / 2.1;

    const walk = carryWalk(quarterStep, 1, -1);

    expect(walk.leftArmX).toBeCloseTo(-walk.leftUpperX * (6 / 16), 3);
  });

  it("flexes the knee during the swing window", () => {
    const quarterStep = 0.25 / 2.1;

    const walk = carryWalk(quarterStep, 1, -1);

    expect(walk.leftLowerX).not.toBe(0);
  });

  it("rolls hips and counter-rotates shoulders", () => {
    const quarterStep = 0.25 / 2.1;

    const walk = carryWalk(quarterStep, 1, -1);

    expect(walk.hipRollZ).not.toBe(0);
    expect(walk.spineYawY).not.toBe(0);
    expect(walk.leanX).not.toBe(0);
    expect(walk.headCompX).not.toBe(0);
  });
});
