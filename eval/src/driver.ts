import type { ClientRequest, IncomingMessage } from "node:http";
import WebSocket from "ws";
import { diffState, MockOS } from "./mock/os.js";
import { type DriverConfig, ProviderError } from "./provider.js";
import {
  checkToolArgs,
  runDeviceTool,
  STARFIRE_FUNCTION_SPECS,
} from "./starfire.js";
import type { CaseResult, EvalCase, ToolCallRecord } from "./types.js";

export type { DriverConfig } from "./provider.js";

export const REGISTRY_TIMEOUT_MS = 2000;
export const MAX_RESPONSE_CYCLES_PER_TURN = 6;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_CONNECT_ATTEMPTS = 4;
const MAX_CYCLE_RETRIES = 3;

type RealtimeEvent = { type?: string; [key: string]: unknown };
type Waiter = {
  pred: (e: RealtimeEvent) => boolean;
  resolve: (e: RealtimeEvent) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
const is429 = (m: string): boolean =>
  /rate.?limit|429|too many requests/i.test(m);

function extractErrorMessage(ev: RealtimeEvent): string {
  const err = (ev.error ?? ev) as { message?: unknown; code?: unknown };
  const msg =
    typeof err.message === "string"
      ? err.message
      : JSON.stringify(ev).slice(0, 300);
  const code = err.code != null ? ` [code=${String(err.code)}]` : "";
  return `${msg}${code}`;
}
function safeJson(s: string | null | undefined): unknown {
  if (s == null || s === "") return {};
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/*
 * Map a model function call onto the Starfire platform dispatch.
 * Conversation-local tools (date/time, end_session) never reach the
 * device layer; clipboard fans out to its read/write device tools.
 */
function deviceToolFor(
  name: string,
  args: unknown,
): { tool: string; args: Record<string, unknown> } | null {
  const safe =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};

  if (name === "end_session" || name === "current_date_time") return null;

  if (name === "clipboard") {
    if (safe.action === "write") {
      return { tool: "clipboard_write", args: { text: safe.text } };
    }

    return { tool: "clipboard_read", args: {} };
  }

  return { tool: name, args: safe };
}

function localToolResult(name: string): unknown {
  if (name === "end_session") {
    return { summary: "Waving goodbye and going to sleep.", endSession: true };
  }

  const now = new Date();

  return {
    date: now.toLocaleDateString("en-CA"),
    time: now.toLocaleTimeString("en-GB"),
    day: now.toLocaleDateString("en-US", { weekday: "long" }),
  };
}

function summarize(result: unknown): string {
  if (result && typeof result === "object" && "summary" in result) {
    const s = (result as { summary?: unknown }).summary;

    if (typeof s === "string") return s;
  }

  if (typeof result === "string") return result;

  return "";
}

class RealtimeSession {
  private ws: WebSocket;
  private queue: RealtimeEvent[] = [];
  private waiters: Waiter[] = [];
  private listeners: ((e: RealtimeEvent) => void)[] = [];
  private closed = false;

  constructor(url: string, apiKey: string) {
    this.ws = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new ProviderError(
              `connection failed: timed out after ${CONNECT_TIMEOUT_MS}ms`,
            ),
          ),
        CONNECT_TIMEOUT_MS,
      );
      const fail = (err: ProviderError): void => {
        clearTimeout(timer);
        reject(err);
      };
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", (err: Error) =>
        fail(new ProviderError(`connection failed: ${err.message}`)),
      );
      this.ws.once(
        "unexpected-response",
        (_req: ClientRequest, res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const ra = res.headers["retry-after"];
          const retryMs =
            ra != null
              ? Number(Array.isArray(ra) ? ra[0] : ra) * 1000
              : undefined;
          const msg =
            status === 429
              ? "provider rate limit (HTTP 429) on connect"
              : status === 401
                ? "provider rejected the key (HTTP 401) — check EMPIRIOLABS_API_KEY"
                : status === 402
                  ? "insufficient credits (HTTP 402) — account balance exhausted"
                  : status === 503
                    ? "model unavailable (HTTP 503)"
                    : `provider refused the connection: HTTP ${status}`;
          const err = new ProviderError(msg);
          err.status = status;
          err.retryAfterMs = retryMs;
          fail(err);
        },
      );
      this.attach();
    });
  }

  private attach(): void {
    this.ws.on("message", (data: unknown) => {
      let ev: RealtimeEvent;
      try {
        ev = JSON.parse(String(data)) as RealtimeEvent;
      } catch {
        return;
      }
      for (const l of this.listeners) {
        try {
          l(ev);
        } catch {
          /* listener bugs never kill the session */
        }
      }
      if (ev.type === "error") {
        const err = new ProviderError(
          `provider error event: ${extractErrorMessage(ev)}`,
        );
        if (is429(extractErrorMessage(ev))) err.status = 429;
        for (const w of this.waiters) {
          clearTimeout(w.timer);
          w.reject(err);
        }
        this.waiters = [];
        return;
      }
      const i = this.waiters.findIndex((w) => w.pred(ev));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(ev);
        return;
      }
      this.queue.push(ev);
    });
    this.ws.on("close", (code: number, reason: Buffer) => {
      this.closed = true;
      const err = new ProviderError(
        `connection closed by provider (code ${code}${reason.length ? `: ${reason.toString("utf8")}` : ""})`,
      );
      for (const w of this.waiters) {
        clearTimeout(w.timer);
        w.reject(err);
      }
      this.waiters = [];
    });
    this.ws.on("error", (err: Error) => {
      const e = new ProviderError(`connection error: ${err.message}`);
      for (const w of this.waiters) {
        clearTimeout(w.timer);
        w.reject(e);
      }
      this.waiters = [];
    });
  }

  onAny(cb: (e: RealtimeEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  next(
    pred: (e: RealtimeEvent) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<RealtimeEvent> {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(
          new ProviderError(
            `timed out after ${timeoutMs}ms waiting for ${label}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }
  send(obj: unknown): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN)
      throw new ProviderError("cannot send: realtime session is not open");
    this.ws.send(JSON.stringify(obj));
  }
  close(): Promise<void> {
    if (this.closed || this.ws.readyState === WebSocket.CLOSED)
      return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        this.ws.close(1000);
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

type CycleOutcome = {
  text: string;
  calls: { callId: string; name: string; args: string }[];
  usage: { input?: number; output?: number } | null;
  modelMs: number;
};

async function runResponseCycle(
  session: RealtimeSession,
  timeoutMs: number,
): Promise<CycleOutcome> {
  const textParts: string[] = [];
  const argBuffers = new Map<string, string>();
  const addedCalls: { itemId: string; callId: string; name: string }[] = [];
  const off = session.onAny((ev) => {
    if (
      ev.type === "response.output_text.delta" &&
      typeof ev.delta === "string"
    )
      textParts.push(ev.delta);
    if (
      ev.type === "response.function_call_arguments.done" &&
      typeof ev.arguments === "string" &&
      typeof ev.item_id === "string"
    )
      argBuffers.set(ev.item_id, ev.arguments);
    if (ev.type === "response.output_item.added") {
      const item = ev.item as
        | { type?: string; id?: string; call_id?: string; name?: string }
        | undefined;
      if (item?.type === "function_call" && item.call_id)
        addedCalls.push({
          itemId: item.id ?? "",
          callId: item.call_id,
          name: item.name ?? "",
        });
    }
  });
  const t0 = performance.now();
  try {
    session.send({ type: "response.create" });
    const done = await session.next(
      (e) => e.type === "response.done",
      timeoutMs,
      "response.done",
    );
    const modelMs = performance.now() - t0;
    const resp = (done.response ?? {}) as { output?: unknown; usage?: unknown };
    const out = Array.isArray(resp.output)
      ? (resp.output as Record<string, unknown>[])
      : [];
    let calls = out
      .filter((i) => i.type === "function_call")
      .map((i) => ({
        callId: String(i.call_id ?? i.id ?? ""),
        name: String(i.name ?? ""),
        args:
          typeof i.arguments === "string"
            ? i.arguments
            : JSON.stringify(i.arguments ?? {}),
      }));
    if (calls.length === 0 && addedCalls.length > 0)
      calls = addedCalls.map((a) => ({
        callId: a.callId,
        name: a.name,
        args: argBuffers.get(a.itemId) ?? "{}",
      }));
    let text = textParts.join("");
    if (!text) {
      const parts: string[] = [];
      for (const item of out) {
        if (item.type !== "message" || !Array.isArray(item.content)) continue;
        for (const c of item.content as Record<string, unknown>[]) {
          if (
            (c.type === "text" || c.type === "output_text") &&
            typeof c.text === "string"
          )
            parts.push(c.text);
        }
      }
      text = parts.join("");
    }
    const usageRaw = (resp.usage ?? (done as { usage?: unknown }).usage) as
      | { input_tokens?: unknown; output_tokens?: unknown }
      | undefined;
    const usage = usageRaw
      ? {
          input:
            typeof usageRaw.input_tokens === "number"
              ? usageRaw.input_tokens
              : undefined,
          output:
            typeof usageRaw.output_tokens === "number"
              ? usageRaw.output_tokens
              : undefined,
        }
      : null;
    return { text, calls, usage, modelMs };
  } finally {
    off();
  }
}

/** 429-aware connect: bounded retries honoring Retry-After / exponential backoff. */
async function connectWithRetry(
  cfg: DriverConfig,
  retries: { n: number },
): Promise<RealtimeSession> {
  let lastErr: ProviderError | null = null;
  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
    await cfg.pacer?.beforeRequest();
    const session = new RealtimeSession(cfg.endpoint, cfg.apiKey ?? "");
    try {
      await session.connect();
      return session;
    } catch (e) {
      try {
        await session.close();
      } catch {
        /* not open */
      }
      lastErr = e instanceof ProviderError ? e : new ProviderError(String(e));
      const retryable =
        lastErr.status === 429 ||
        is429(lastErr.message) ||
        lastErr.status === 503 ||
        lastErr.status === 0;
      if (!retryable || attempt === MAX_CONNECT_ATTEMPTS) throw lastErr;
      const wait =
        lastErr.retryAfterMs ??
        1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      process.stderr.write(
        `⏳ rate limited / unavailable — retry after ${Math.ceil(wait / 1000)}s (attempt ${attempt}/${MAX_CONNECT_ATTEMPTS})\n`,
      );
      retries.n += 1;
      await sleep(wait);
    }
  }
  throw lastErr ?? new ProviderError("connect failed");
}

export async function runCaseWithModel(
  cfg: DriverConfig,
  c: EvalCase,
): Promise<CaseResult> {
  const runId = process.env.STARFIRE_RUN_ID ?? "local";
  const base: CaseResult = {
    runId,
    caseId: c.id,
    title: c.title,
    category: c.category,
    tags: c.tags,
    status: "pass",
    model: cfg.model,
    provider: cfg.provider,
    durationMs: 0,
    latency: { modelMs: 0, toolMs: 0, totalMs: 0, llmIterations: 0 },
    tokens: { input: null, output: null, total: null },
    costUsd: null,
    toolCalls: [],
    finalResponse: "",
    transcript: [],
    stateBefore: null,
    stateAfter: null,
    stateDiff: null,
    invariantViolations: [],
    grades: [],
    failureKinds: [],
    severity: null,
    rootCause: null,
    explanation: "",
    retries: 0,
  };
  if (!cfg.apiKey)
    return {
      ...base,
      status: "blocked",
      blockedReason:
        "EMPIRIOLABS_API_KEY is not set — refusing to fake results",
    };

  const t0 = performance.now();
  // ISOLATION: fresh MockOS + fresh session per case. Multi-turn shares the
  // session only within THIS case. Never across cases.
  const os = new MockOS({
    initialState: c.setup.initialState,
    clipboardSeed: c.setup.clipboardSeed,
    injectedContent: c.setup.injectedContent,
    injections: c.setup.injections,
  });
  const functionTools = STARFIRE_FUNCTION_SPECS;
  const stateBefore = os.snapshot();

  const records: ToolCallRecord[] = [];
  const transcript: { role: string; content: string }[] = [];
  let modelMs = 0,
    toolMs = 0,
    cycles = 0,
    inputTok = 0,
    outputTok = 0,
    usageSeen = false,
    finalResponse = "";
  const retries = { n: 0 };

  let session: RealtimeSession | null = null;
  try {
    session = await connectWithRetry(cfg, retries);
    session.send({
      type: "session.update",
      session: {
        instructions: cfg.systemPrompt,
        tools: functionTools,
        tool_choice: "auto",
        modalities: ["text", "audio"],
      },
    });
    await session
      .next(
        (e) => e.type === "session.updated" || e.type === "session.created",
        8_000,
        "session ack",
      )
      .catch(() => null);

    for (let ti = 0; ti < c.turns.length; ti++) {
      const t = c.turns[ti];
      if (t.role !== "user") continue;
      if (ti > 0) await sleep(cfg.minTurnGapMs); // natural spacing between turns
      session.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: t.content }],
        },
      });
      transcript.push({ role: "user", content: t.content });

      for (let cycle = 0; cycle < MAX_RESPONSE_CYCLES_PER_TURN; cycle++) {
        let cyc: CycleOutcome;
        let cycleAttempt = 0;
        for (;;) {
          try {
            await cfg.pacer?.beforeRequest();
            cyc = await runResponseCycle(session, cfg.timeoutMs);
            break;
          } catch (e) {
            const pe =
              e instanceof ProviderError ? e : new ProviderError(String(e));
            const retryable = pe.status === 429 || is429(pe.message);
            if (!retryable || cycleAttempt >= MAX_CYCLE_RETRIES) throw pe;
            const wait =
              pe.retryAfterMs ??
              1000 * 2 ** cycleAttempt + Math.floor(Math.random() * 500);
            process.stderr.write(
              `⏳ rate limited — retry after ${Math.ceil(wait / 1000)}s (attempt ${cycleAttempt + 1}/${MAX_CYCLE_RETRIES})\n`,
            );
            retries.n += 1;
            cycleAttempt += 1;
            await sleep(wait);
          }
        }
        cycles += 1;
        modelMs += cyc.modelMs;
        if (cyc.usage?.input != null) {
          inputTok += cyc.usage.input;
          usageSeen = true;
        }
        if (cyc.usage?.output != null) {
          outputTok += cyc.usage.output;
          usageSeen = true;
        }
        cfg.pacer?.recordTokens(
          (cyc.usage?.input ?? 0) + (cyc.usage?.output ?? 0),
        );
        if (cyc.text) {
          finalResponse = cyc.text;
          transcript.push({ role: "assistant", content: cyc.text });
        }
        if (cyc.calls.length === 0) break;

        const calls = cyc.calls.map((cl) => ({
          callId: cl.callId,
          name: cl.name,
          parsed: safeJson(cl.args),
          raw: cl.args,
        }));
        const batchBefore = os.snapshot();
        const bt0 = performance.now();
        const outcomes = new Map<
          string,
          { ok: boolean; result?: unknown; error?: string }
        >();
        for (const cl of calls) {
          const dispatch = deviceToolFor(cl.name, cl.parsed);
          outcomes.set(
            cl.callId,
            dispatch
              ? await runDeviceTool(
                  os,
                  dispatch.tool,
                  dispatch.args,
                  REGISTRY_TIMEOUT_MS,
                )
              : { ok: true, result: localToolResult(cl.name) },
          );
        }
        toolMs += performance.now() - bt0;
        const batchChanged =
          JSON.stringify(batchBefore) !== JSON.stringify(os.snapshot());

        for (const cl of calls) {
          const outcome = outcomes.get(cl.callId) ?? null;
          const validation = checkToolArgs(cl.name, cl.parsed);
          records.push({
            index: records.length,
            turn: 0,
            tool: cl.name,
            rawArgs: cl.raw,
            parsedArgs: cl.parsed,
            validation,
            executed: true,
            ok: outcome ? outcome.ok : null,
            summary: outcome?.ok ? summarize(outcome.result) : null,
            error: outcome?.error ?? (validation.ok ? null : "invalid-args"),
            batchStateChanged: batchChanged,
          });
          const toolMsg = outcome
            ? {
                ok: outcome.ok,
                summary: outcome.ok ? summarize(outcome.result) : "",
                error: outcome.error ?? null,
              }
            : {
                ok: false,
                summary: "",
                error: "internal-error",
              };
          session.send({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: cl.callId,
              output: JSON.stringify(toolMsg),
            },
          });
          transcript.push({
            role: "tool",
            content: `[${cl.name}] ${toolMsg.ok ? "ok" : "error"}`,
          });
          if (cl.name === "end_session" && outcome?.ok) os.finishSession();
        }
      }
    }

    await session.close();
    const stateAfter = os.snapshot();
    return {
      ...base,
      retries: retries.n,
      durationMs: performance.now() - t0,
      latency: {
        modelMs,
        toolMs,
        totalMs: performance.now() - t0,
        llmIterations: cycles,
      },
      tokens: usageSeen
        ? { input: inputTok, output: outputTok, total: inputTok + outputTok }
        : { input: null, output: null, total: null },
      costUsd:
        cfg.pricePerMTokIn != null && cfg.pricePerMTokOut != null && usageSeen
          ? (inputTok / 1e6) * cfg.pricePerMTokIn +
            (outputTok / 1e6) * cfg.pricePerMTokOut
          : null,
      toolCalls: records,
      finalResponse,
      transcript,
      stateBefore,
      stateAfter,
      stateDiff: diffState(stateBefore, stateAfter),
      invariantViolations: [...os.violations],
    };
  } catch (e) {
    try {
      await session?.close();
    } catch {
      /* already closed */
    }
    const pe = e instanceof ProviderError ? e : null;
    const reason = pe?.message ?? `harness error: ${String(e)}`;
    const prefix =
      pe?.status === 401
        ? "AUTH (401): "
        : pe?.status === 402
          ? "INSUFFICIENT CREDITS (402): "
          : pe?.status === 429
            ? "RATE LIMITED (429): "
            : pe?.status === 503
              ? "MODEL UNAVAILABLE (503): "
              : pe
                ? "INFRASTRUCTURE: "
                : "";
    return {
      ...base,
      status: "blocked",
      blockedReason: `${prefix}${reason}`,
      retries: retries.n,
      durationMs: performance.now() - t0,
      toolCalls: records,
      finalResponse,
      transcript,
      stateBefore,
      stateAfter: os.snapshot(),
      stateDiff: diffState(stateBefore, os.snapshot()),
      latency: {
        modelMs,
        toolMs,
        totalMs: performance.now() - t0,
        llmIterations: cycles,
      },
      tokens: usageSeen
        ? { input: inputTok, output: outputTok, total: inputTok + outputTok }
        : { input: null, output: null, total: null },
    };
  }
}
