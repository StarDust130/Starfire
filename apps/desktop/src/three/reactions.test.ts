import { describe, expect, it } from "vitest";
import { createPoseTarget } from "./pose";
import {
  applyListeningAction,
  applyMicroReaction,
  chooseListeningVariant,
  chooseMicro,
  LISTENING_ACTION_S,
  type ListeningVariant,
  type MicroKind,
  type MicroReaction,
  microDuration,
} from "./reactions";

const micro = (kind: MicroKind, startedAt = 0): MicroReaction => ({
  kind,
  startedAt,
  duration: microDuration(kind),
  expression: null,
  strength: 1,
});

describe("chooseMicro", () => {
  it("never repeats the previous micro-reaction", () => {
    const kinds: MicroKind[] = [
      "curious",
      "happy",
      "shy",
      "glance",
      "sway",
      "left-fidget",
      "right-fidget",
    ];

    for (const previous of kinds) {
      for (let i = 0; i < 30; i += 1) {
        expect(chooseMicro(previous)).not.toBe(previous);
      }
    }
  });
});

describe("microDuration", () => {
  it("is positive for every kind", () => {
    const kinds: MicroKind[] = [
      "curious",
      "happy",
      "shy",
      "glance",
      "sway",
      "left-fidget",
      "right-fidget",
    ];

    for (const kind of kinds) {
      expect(microDuration(kind)).toBeGreaterThan(0);
    }
  });
});

describe("applyMicroReaction", () => {
  it("starts and ends at zero and peaks mid-way", () => {
    const m = micro("curious", 0);

    const headAt = (t: number) => {
      const acc = createPoseTarget();

      applyMicroReaction(acc, m, t, 1, -1);

      return acc.bones.head;
    };

    expect(headAt(0).y).toBe(0);

    const mid = headAt(m.duration / 2);

    expect(mid.y).toBeGreaterThan(0.05);

    expect(headAt(m.duration).y).toBeCloseTo(0, 6);
  });
});

describe("chooseListeningVariant", () => {
  it("never repeats the previous variant", () => {
    const variants: ListeningVariant[] = ["greet", "bounce", "peek"];

    for (const previous of variants) {
      for (let i = 0; i < 30; i += 1) {
        expect(chooseListeningVariant(previous)).not.toBe(previous);
      }
    }
  });
});

describe("applyListeningAction", () => {
  it("ramps in, holds, and ramps out", () => {
    const action = {
      variant: "greet" as ListeningVariant,
      side: "left" as const,
      startedAt: 0,
      expression: null,
    };

    const envAt = (t: number) => {
      const acc = createPoseTarget();

      return applyListeningAction(acc, action, t, 1, -1);
    };

    expect(envAt(0)).toBeCloseTo(0, 6);
    expect(envAt(LISTENING_ACTION_S)).toBeCloseTo(0, 6);
    expect(envAt(LISTENING_ACTION_S / 2)).toBeGreaterThan(0.5);
  });

  it("greet raises the hand (forearm offset peaks mid-action)", () => {
    const action = {
      variant: "greet" as ListeningVariant,
      side: "left" as const,
      startedAt: 0,
      expression: null,
    };

    const acc = createPoseTarget();

    applyListeningAction(acc, action, LISTENING_ACTION_S / 2, 1, -1);

    expect(acc.bones.leftLowerArm.z).not.toBe(0);
  });
});
