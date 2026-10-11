import { describe, expect, it } from "vitest";

import { redactSecrets, redactTurns } from "../redaction.js";

describe("redactSecrets", () => {
  it("redacts spoken passwords (english and hinglish)", () => {
    const a = redactSecrets("my password is hunter2 don't tell");

    expect(a.text).not.toContain("hunter2");
    expect(a.text).toContain("[REDACTED");
    expect(a.redactions).toContain("spoken");

    const b = redactSecrets("mera password hai abc12345");

    expect(b.text).not.toContain("abc12345");
  });

  it("redacts api-key-shaped tokens", () => {
    const result = redactSecrets("use key sk-abcdefghijklmnopqrstuvwx");

    expect(result.text).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(result.redactions).toContain("api-key-shape");
  });

  it("redacts PEM private key blocks completely", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA7",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    const result = redactSecrets(`here is my key\n${pem}\nthanks`);

    expect(result.text).not.toContain("MIIEpAIBAAKCAQEA7");
    expect(result.text).toContain("[REDACTED:private-key]");
  });

  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P";

    const result = redactSecrets(`token ${jwt}`);

    expect(result.text).not.toContain("eyJhbGciOiJIUzI1NiIs");
  });

  it("redacts assignment-style secrets with quotes", () => {
    const result = redactSecrets(`token: "super-secret-value-123"`);

    expect(result.text).not.toContain("super-secret-value-123");
  });

  it("redacts long hex strings", () => {
    const hex = "aabbccdd00112233aabbccdd00112233";

    const result = redactSecrets(`hash ${hex}`);

    expect(result.text).not.toContain(hex);
  });

  it("leaves normal conversation untouched", () => {
    const text = "I love pizza with extra cheese, see you tomorrow at 5!";

    const result = redactSecrets(text);

    expect(result.text).toBe(text);
    expect(result.redactions).toEqual([]);
  });
});

describe("redactTurns", () => {
  it("redacts each turn and aggregates redaction names", () => {
    const { turns, redactions } = redactTurns([
      { id: 1, role: "user", content: "my password is hunter2" },
      { id: 2, role: "assistant", content: "Okay, I will not save it." },
      {
        id: 3,
        role: "user",
        content: "here is a key sk-abcdefghijklmnopqrstuvwx",
      },
    ]);

    expect(turns[1]?.content).toBe("Okay, I will not save it.");
    expect(turns[0]?.content).not.toContain("hunter2");
    expect(turns[2]?.content).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(redactions).toEqual(
      expect.arrayContaining(["spoken", "api-key-shape"]),
    );
  });
});
