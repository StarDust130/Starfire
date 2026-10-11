import { describe, expect, it } from "vitest";

import { detectExplicitFact } from "../explicit.js";

describe("detectExplicitFact", () => {
  it("detects a stated name and normalizes its case", () => {
    const fact = detectExplicitFact("my name is thor");

    expect(fact).toEqual({
      category: "profile",
      key: "user.name",
      content: "The user's name is Thor.",
      importance: 5,
    });
  });

  it("detects call-me names and preserves given casing", () => {
    expect(detectExplicitFact("Call me McAllister")?.content).toBe(
      "The user's name is McAllister.",
    );
  });

  it("NEVER saves a negated name as a fact (regression)", () => {
    expect(detectExplicitFact("my name is not Thor")).toBeNull();
    expect(detectExplicitFact("my name is not sure")).toBeNull();
    expect(detectExplicitFact("my name is nothing special")).toBeNull();
  });

  it("supports conservative multi-word names (regression)", () => {
    // Continuation words must be Capitalized proper nouns.
    expect(detectExplicitFact("Call me Mary Jane")?.content).toBe(
      "The user's name is Mary Jane.",
    );

    // Lowercase continuation stays single-word — conservative.
    expect(detectExplicitFact("my name is john smith")?.content).toBe(
      "The user's name is John.",
    );
  });

  it("detects a favorite color including two-word colors", () => {
    const fact = detectExplicitFact("My favorite color is Light Blue");

    expect(fact?.category).toBe("preference");
    expect(fact?.key).toBe("favorite-color");
    expect(fact?.content).toBe("The user's favorite color is light blue.");
  });

  it("detects explicit remember-this statements with a stable key", () => {
    const fact = detectExplicitFact(
      "remember that I have a meeting on Friday.",
    );

    expect(fact?.category).toBe("fact");
    expect(fact?.key).toBe("note.i-have-a-meeting-on-friday");
    expect(fact?.content).toContain("I have a meeting on Friday");
  });

  it("never fires on questions or fragments", () => {
    expect(detectExplicitFact("Do you remember my name?")).toBeNull();
    expect(
      detectExplicitFact("Can you remember my favorite color?"),
    ).toBeNull();
    expect(detectExplicitFact("My name is.")).toBeNull();
    expect(detectExplicitFact("remember")).toBeNull();
    expect(detectExplicitFact("")).toBeNull();
  });
});
