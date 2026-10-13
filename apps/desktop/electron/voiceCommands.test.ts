import { describe, expect, it } from "vitest";

import { detectVoiceCommand } from "./voiceCommands.js";

describe("detectVoiceCommand", () => {
  it("recognizes silence commands with natural variations", () => {
    expect(detectVoiceCommand("be quiet and listen")).toBe("silence");
    expect(detectVoiceCommand("Okay Starfire, be quiet and listen now!")).toBe(
      "silence",
    );
    expect(detectVoiceCommand("just listen for a bit")).toBe("silence");
    expect(detectVoiceCommand("mute yourself please.")).toBe("silence");
  });

  it("recognizes resume commands", () => {
    expect(detectVoiceCommand("you can speak now")).toBe("resume");
    expect(detectVoiceCommand("Okay, you can talk again")).toBe("resume");
    expect(detectVoiceCommand("unmute")).toBe("resume");
    expect(detectVoiceCommand("start talking again!")).toBe("resume");
  });

  it("recognizes stop commands", () => {
    expect(detectVoiceCommand("stop")).toBe("stop");
    expect(detectVoiceCommand("Stop.")).toBe("stop");
    expect(detectVoiceCommand("stop listening now")).toBe("stop");
    expect(detectVoiceCommand("end session")).toBe("stop");
  });

  it("NEVER triggers inside unrelated sentences", () => {
    expect(detectVoiceCommand("stop the music please")).toBeNull();
    expect(
      detectVoiceCommand("I told him to be quiet and listen to the teacher"),
    ).toBeNull();
    expect(
      detectVoiceCommand("when can you speak about this topic"),
    ).toBeNull();
    expect(detectVoiceCommand("can you mute the video")).toBeNull();
  });

  it("ignores empty, oversized, and ordinary speech", () => {
    expect(detectVoiceCommand("")).toBeNull();
    expect(detectVoiceCommand("   ")).toBeNull();
    expect(detectVoiceCommand("x".repeat(120))).toBeNull();
    expect(detectVoiceCommand("what's the weather today")).toBeNull();
    expect(detectVoiceCommand("my name is Thor")).toBeNull();
  });
});
