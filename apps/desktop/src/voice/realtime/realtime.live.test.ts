import WebSocket from "ws";

import { afterAll, describe, expect, it } from "vitest";

import {
  buildConversationItemCreate,
  buildResponseCreate,
  buildSessionUpdate,
  parseServerEvent,
  REALTIME_MODEL,
} from "../../../electron/realtimeProtocol";

const enabled =
  process.env.STARFIRE_LIVE_E2E === "1" && !!process.env.EMPIRIOLABS_API_KEY;

const endpoint =
  process.env.EMPIRIOLABS_REALTIME_URL ??
  `wss://api.empiriolabs.ai/v1/realtime?model=${REALTIME_MODEL}`;

describe.skipIf(!enabled)("live EmpirioLabs realtime smoke", () => {
  let socket: WebSocket | null = null;

  afterAll(() => {
    socket?.close(1000);
  });

  it("connects, receives session.created, and gets one audio response", {
    timeout: 30000,
  }, async () => {
    const key = process.env.EMPIRIOLABS_API_KEY as string;

    socket = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${key}` },
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("connect timeout")),
        15000,
      );

      socket?.once("open", () => {
        clearTimeout(timer);

        resolve();
      });

      socket?.once("error", (error) => {
        clearTimeout(timer);

        reject(error);
      });
    });

    let sawAudio = false;

    let sawDone = false;

    let sawSession = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("did not receive a full response in time")),
        20000,
      );

      socket?.on("message", (data) => {
        const event = parseServerEvent(data.toString());

        if (!event) {
          return;
        }

        if (event.kind === "session") {
          sawSession = true;

          socket?.send(buildSessionUpdate());

          socket?.send(buildConversationItemCreate("Hi"));

          socket?.send(buildResponseCreate());
        }

        if (event.kind === "audio-delta" || event.kind === "transcript-delta") {
          sawAudio = true;
        }

        if (event.kind === "response-done") {
          sawDone = true;

          clearTimeout(timer);

          resolve();
        }

        if (event.kind === "error") {
          clearTimeout(timer);

          reject(new Error(`server error: ${event.message}`));
        }
      });
    });

    expect(sawSession).toBe(true);

    expect(sawAudio).toBe(true);

    expect(sawDone).toBe(true);
  });
});
