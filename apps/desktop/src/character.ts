export type CharacterState =
  | "idle"
  | "walking"
  | "listening"
  | "thinking"
  | "speaking"
  | "working"
  | "happy"
  | "success"
  | "error"
  | "sleeping";

export type CharacterEvent =
  | { type: "WALK" }
  | { type: "LISTEN" }
  | { type: "THINK" }
  | { type: "SPEAK" }
  | { type: "WORK" }
  | { type: "HAPPY" }
  | { type: "SUCCESS" }
  | { type: "ERROR" }
  | { type: "SLEEP" }
  | { type: "IDLE" };

export const initialCharacterState: CharacterState = "idle";

export function characterReducer(
  state: CharacterState,
  event: CharacterEvent,
): CharacterState {
  switch (event.type) {
    case "WALK":
      return "walking";

    case "LISTEN":
      return "listening";

    case "THINK":
      return "thinking";

    case "SPEAK":
      return "speaking";

    case "WORK":
      return "working";

    case "HAPPY":
      return "happy";

    case "SUCCESS":
      return "success";

    case "ERROR":
      return "error";

    case "SLEEP":
      return "sleeping";

    case "IDLE":
      return "idle";

    default:
      return state;
  }
}
