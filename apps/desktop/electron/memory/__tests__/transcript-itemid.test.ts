import { describe, expect, it } from "vitest";

import { parseServerEvent } from "../../realtimeProtocol";

const TYPE = "conversation.item.input_audio_transcription.completed";

describe("parseServerEvent — input transcript item ids", () => {
  it("carries the provider item_id when present (never invented)", () => {
    const event = parseServerEvent(
      JSON.stringify({
        type: TYPE,
        item_id: "item_9",
        transcript: "hello there",
      }),
    );

    expect(event).toMatchObject({
      kind: "input-transcript",
      text: "hello there",
      itemId: "item_9",
    });
  });

  it("falls back to event_id when item_id is absent", () => {
    const event = parseServerEvent(
      JSON.stringify({ type: TYPE, event_id: "evt_1", transcript: "hi" }),
    );

    expect(event).toMatchObject({ kind: "input-transcript", itemId: "evt_1" });
  });

  it("omits itemId entirely when the provider supplies neither", () => {
    const event = parseServerEvent(
      JSON.stringify({ type: TYPE, transcript: "hi" }),
    );

    expect(event).toMatchObject({ kind: "input-transcript", text: "hi" });
    expect(event?.kind === "input-transcript" && event.itemId).toBeUndefined();
  });

  it("empty transcript is still unknown", () => {
    const event = parseServerEvent(
      JSON.stringify({ type: TYPE, item_id: "item_1", transcript: "" }),
    );

    expect(event?.kind).toBe("unknown");
  });
});
