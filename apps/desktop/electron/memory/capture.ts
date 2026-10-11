import { randomUUID } from "node:crypto";

import { MAX_MESSAGE_CHARS, type MessageStore } from "./messages.js";

/*
 * The realtime voice bridge notifies this recorder at the true
 * lifecycle points of a conversation. The recorder owns session
 * identity and turn ordering, and writes complete turns through the
 * MessageStore. It must NEVER throw into the voice path: every store
 * call is guarded, and memory problems degrade to "not captured".
 */

export interface VoiceTranscriptCapture {
  /** A voice activation became active. Once per activation. */
  onSessionStart(): void;
  /** The user finished one utterance (completed transcription). */
  onUserTranscript(text: string): void;
  /** One chunk of the assistant's spoken transcript. */
  onAssistantDelta(delta: string): void;
  /** The response finished. interrupted=true = cancelled/barge-in. */
  onAssistantDone(interrupted: boolean): void;
  /** The activation ended. Pending buffer is flushed as interrupted. */
  onSessionEnd(): void;
}

export class VoiceTranscriptRecorder implements VoiceTranscriptCapture {
  private sessionId: string | null = null;
  private assistantBuffer = "";

  constructor(private readonly store: MessageStore) {}

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  onSessionStart(): void {
    /*
     * A stale buffer can only exist if a socket died mid-response
     * without a clean deactivation. Flush it under the OLD session so
     * nothing leaks into the new conversation.
     */
    this.flushAssistant(true, "stale-before-session-start");

    this.sessionId = randomUUID();

    console.log(`[Memory] 🎙 session started ${this.sessionId}`);
  }

  onUserTranscript(text: string): void {
    if (!this.sessionId || typeof text !== "string") {
      return;
    }

    const content = text.trim();

    if (content.length === 0) {
      return;
    }

    /*
     * Ordering safety: if the user started talking while an assistant
     * response was still buffered, that response was interrupted.
     * Flush it first so it is stored BEFORE this user turn.
     */
    this.flushAssistant(true, "user-barge-in");

    this.insert("user", content, false, "transcript");
  }

  onAssistantDelta(delta: string): void {
    if (!this.sessionId || typeof delta !== "string" || delta.length === 0) {
      return;
    }

    this.assistantBuffer += delta;

    if (this.assistantBuffer.length > MAX_MESSAGE_CHARS) {
      this.assistantBuffer = this.assistantBuffer.slice(0, MAX_MESSAGE_CHARS);
    }
  }

  onAssistantDone(interrupted: boolean): void {
    this.flushAssistant(
      interrupted,
      interrupted ? "cancelled" : "response-done",
    );
  }

  onSessionEnd(): void {
    if (!this.sessionId) {
      return;
    }

    this.flushAssistant(true, "session-end");

    console.log(`[Memory] 🌙 session ended ${this.sessionId}`);

    this.sessionId = null;
  }

  private flushAssistant(interrupted: boolean, reason: string): void {
    const content = this.assistantBuffer.trim();

    this.assistantBuffer = "";

    if (content.length === 0 || !this.sessionId) {
      return;
    }

    this.insert("assistant", content, interrupted, reason);
  }

  private insert(
    role: "user" | "assistant",
    content: string,
    interrupted: boolean,
    reason: string,
  ): void {
    const sessionId = this.sessionId;

    if (!sessionId) {
      return;
    }

    try {
      const stored = this.store.insertTurn({
        sessionId,
        role,
        content,
        interrupted,
      });

      if (stored) {
        console.log(
          `[Memory] 📝 ${role} turn captured (chars=${content.length}` +
            `${interrupted ? ", interrupted" : ""}, ${reason})`,
        );
      }
    } catch (error) {
      console.warn(
        `[Memory] ⚠️ could not capture ${role} turn (${reason}):`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
