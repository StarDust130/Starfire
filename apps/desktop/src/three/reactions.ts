import type { VRM } from "@pixiv/three-vrm";

import { addBone, clamp, deg, findExpression, type PoseTarget } from "./pose";

export const MICRO_MIN_DELAY = 14;
export const MICRO_MAX_DELAY = 28;

export const LISTENING_ACTION_S = 2.75;
export const LISTENING_ATTACK_S = 0.28;
export const LISTENING_RELEASE_S = 0.55;

export type MicroKind =
  | "curious"
  | "happy"
  | "shy"
  | "glance"
  | "sway"
  | "left-fidget"
  | "right-fidget";

export type MicroReaction = {
  kind: MicroKind;
  startedAt: number;
  duration: number;
  expression: string | null;
  strength: number;
};

export type ListeningVariant = "greet" | "bounce" | "peek";

export type ListeningSide = "left" | "right";

export type ListeningAction = {
  variant: ListeningVariant;
  side: ListeningSide;
  startedAt: number;
  expression: string | null;
};

function easeOutCubic(value: number): number {
  return 1 - (1 - value) ** 3;
}

export function chooseMicro(previous: MicroKind | null): MicroKind {
  const pool: MicroKind[] = [
    "curious",
    "happy",
    "shy",
    "glance",
    "sway",
    "left-fidget",
    "right-fidget",
  ];

  const options = pool.filter((kind) => kind !== previous);

  return options[Math.floor(Math.random() * options.length)] ?? "curious";
}

export function microDuration(kind: MicroKind): number {
  if (kind === "glance") {
    return 1.3;
  }

  if (kind === "sway") {
    return 1.7;
  }

  if (kind === "shy") {
    return 1.15;
  }

  return 0.9;
}

export function microExpression(vrm: VRM, kind: MicroKind): string | null {
  if (kind === "happy") {
    return findExpression(vrm, ["happy", "relaxed"]);
  }

  if (kind === "curious") {
    return findExpression(vrm, ["relaxed", "surprised"]);
  }

  if (kind === "shy") {
    return findExpression(vrm, ["relaxed", "sad"]);
  }

  return null;
}

/*
 * Bell-curve envelope: every offset starts and ends at exactly zero.
 * Returns `amount` so the scene can drive the expression with it.
 */
export function applyMicroReaction(
  acc: PoseTarget,
  micro: MicroReaction,
  elapsed: number,
  s: number,
  fx: number,
): number {
  const progress = clamp((elapsed - micro.startedAt) / micro.duration, 0, 1);

  const bell = Math.sin(progress * Math.PI);

  const amount = bell * micro.strength;
  const wiggle = Math.sin(progress * Math.PI * 3) * amount;

  if (micro.kind === "curious") {
    addBone(acc, "head", 0, deg(6) * amount, -deg(5) * amount);
  }

  if (micro.kind === "happy") {
    acc.bounce += 0.011 * amount;
    addBone(acc, "head", -deg(2) * amount, 0, 0);
    addBone(acc, "leftShoulder", 0, 0, -s * deg(6) * amount);
    addBone(acc, "rightShoulder", 0, 0, s * deg(6) * amount);
  }

  if (micro.kind === "shy") {
    addBone(acc, "head", deg(3.5) * amount, deg(5) * amount, deg(3) * amount);
    addBone(acc, "spine", 0, 0, -deg(1.5) * amount);
    addBone(acc, "leftUpperArm", 0, 0, s * deg(2) * amount);
    addBone(acc, "rightUpperArm", 0, 0, -s * deg(2) * amount);
    addBone(acc, "leftLowerArm", fx * deg(4) * amount, 0, 0);
    addBone(acc, "rightLowerArm", fx * deg(4) * amount, 0, 0);
  }

  if (micro.kind === "glance") {
    addBone(
      acc,
      "head",
      0,
      Math.sin(progress * Math.PI * 2) * deg(7) * micro.strength,
      0,
    );
  }

  if (micro.kind === "sway") {
    addBone(
      acc,
      "spine",
      0,
      0,
      Math.sin(progress * Math.PI * 2) * deg(1.6) * micro.strength,
    );
    addBone(
      acc,
      "hips",
      0,
      0,
      -Math.sin(progress * Math.PI * 2) * deg(1.2) * micro.strength,
    );
  }

  if (micro.kind === "left-fidget") {
    addBone(acc, "leftUpperArm", 0, 0, -s * deg(3) * amount);
    addBone(acc, "leftLowerArm", fx * deg(5) * amount, 0, s * deg(14) * wiggle);
  }

  if (micro.kind === "right-fidget") {
    addBone(acc, "rightUpperArm", 0, 0, s * deg(3) * amount);
    addBone(
      acc,
      "rightLowerArm",
      fx * deg(5) * amount,
      0,
      -s * deg(14) * wiggle,
    );
  }

  return amount;
}

export function chooseListeningVariant(
  previous: ListeningVariant | null,
): ListeningVariant {
  const pool: ListeningVariant[] = ["greet", "bounce", "peek"];

  const options = pool.filter((variant) => variant !== previous);

  return options[Math.floor(Math.random() * options.length)] ?? "greet";
}

export function listeningExpression(
  vrm: VRM,
  variant: ListeningVariant,
): string | null {
  if (variant === "peek") {
    return findExpression(vrm, ["relaxed", "surprised"]);
  }

  return findExpression(vrm, ["happy", "relaxed"]);
}

/*
 * Attack/hold/release envelope. Returns `env` for the expression.
 */
export function applyListeningAction(
  acc: PoseTarget,
  action: ListeningAction,
  elapsed: number,
  s: number,
  fx: number,
): number {
  const t = elapsed - action.startedAt;

  const attack = easeOutCubic(clamp(t / LISTENING_ATTACK_S, 0, 1));
  const release = easeOutCubic(
    clamp((LISTENING_ACTION_S - t) / LISTENING_RELEASE_S, 0, 1),
  );

  const env = attack * release;

  const sideSign = action.side === "left" ? 1 : -1;
  const closeSide = action.side === "left" ? s : -s;

  if (action.variant === "greet") {
    const wobble = Math.sin(t * Math.PI * 2 * 1.7);

    addBone(
      acc,
      "head",
      0,
      sideSign * deg(3) * env,
      s * sideSign * deg(6) * env,
    );
    addBone(acc, "spine", 0, 0, closeSide * deg(1.2) * env);

    if (action.side === "left") {
      addBone(acc, "leftShoulder", 0, 0, s * deg(4) * env);
      addBone(acc, "leftUpperArm", 0, 0, s * deg(2) * env);
      addBone(
        acc,
        "leftLowerArm",
        fx * deg(6) * env,
        0,
        s * deg(78 + wobble * 6) * env,
      );
    } else {
      addBone(acc, "rightShoulder", 0, 0, -s * deg(4) * env);
      addBone(acc, "rightUpperArm", 0, 0, -s * deg(2) * env);
      addBone(
        acc,
        "rightLowerArm",
        fx * deg(6) * env,
        0,
        -s * deg(78 + wobble * 6) * env,
      );
    }
  }

  if (action.variant === "bounce") {
    const hop = Math.abs(Math.sin(t * Math.PI * 2 * 1.15));

    acc.bounce += hop * 0.012 * env;
    addBone(acc, "head", -deg(2) * hop * env, 0, 0);
    addBone(acc, "leftShoulder", 0, 0, -s * deg(5) * env);
    addBone(acc, "rightShoulder", 0, 0, s * deg(5) * env);
    addBone(acc, "leftLowerArm", fx * deg(4) * env, 0, 0);
    addBone(acc, "rightLowerArm", fx * deg(4) * env, 0, 0);
  }

  if (action.variant === "peek") {
    addBone(acc, "spine", fx * deg(2.5) * env, 0, closeSide * deg(1.5) * env);
    addBone(
      acc,
      "head",
      fx * deg(1.5) * env,
      Math.sin(t * Math.PI * 1.6) * deg(2.5) * env,
      s * sideSign * deg(4) * env,
    );
    addBone(acc, "leftUpperArm", 0, 0, s * deg(3) * env);
    addBone(acc, "rightUpperArm", 0, 0, -s * deg(3) * env);
    addBone(acc, "leftLowerArm", fx * deg(6) * env, 0, 0);
    addBone(acc, "rightLowerArm", fx * deg(6) * env, 0, 0);
  }

  return env;
}
