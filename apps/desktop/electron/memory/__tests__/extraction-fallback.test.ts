import { describe, expect, it } from "vitest";

import {
  type ExtractionConfig,
  type ExtractionResult,
  GlmExtractionProvider,
} from "../extraction.js";

function testConfig(overrides?: Partial<ExtractionConfig>): ExtractionConfig {
  return {
    enabled: true,
    apiKey: "test-key",
    baseUrl: "https://provider.test/v1",
    model: "glm-4-7-flash",
    fallbackModel: "qwen3-5-4b",
    maxRequestsPerMinute: 1_000,
    maxTokensPerMinute: 10_000_000,
    minIntervalMs: 0,
    timeoutMs: 1_000,
    ...overrides,
  };
}

type Call = { model: string; status: number };

function makeScriptedFetch(script: Array<(call: number) => Response>): {
  fetchFn: typeof fetch;
  calls: Call[];
  bodies: string[];
} {
  let index = 0;

  const calls: Call[] = [];

  const bodies: string[] = [];

  const fetchFn = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const step = script[Math.min(index, script.length - 1)];

    const body = JSON.parse(String(init?.body)) as { model: string };

    bodies.push(String(init?.body));

    const response = step(index);

    calls.push({ model: body.model, status: response.status });

    index += 1;

    return response;
  }) as unknown as typeof fetch;

  return { fetchFn, calls, bodies };
}

function okBody(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
    }),
    { status: 200 },
  );
}

const BATCH = [{ id: 7, role: "user" as const, content: "My name is Thor." }];

const GOOD_JSON = JSON.stringify({
  memories: [
    {
      category: "profile",
      key: "user.name",
      content: "The user's name is Thor.",
      sourceMessageIds: [7],
    },
  ],
});

async function run(provider: GlmExtractionProvider): Promise<ExtractionResult> {
  return provider.extract({ context: [], batch: BATCH });
}

describe("GLM → Qwen fallback", () => {
  it("primary success NEVER calls the fallback", async () => {
    const { fetchFn, calls } = makeScriptedFetch([
      () => okBody(JSON.stringify({ memories: [] })),
    ]);

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const result = await run(provider);

    expect(result.ok).toBe(true);
    expect(result.ok && result.model).toBe("glm-4-7-flash");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("glm-4-7-flash");
  });

  it("server error on GLM falls back to Qwen with the same batch", async () => {
    const { fetchFn, calls, bodies } = makeScriptedFetch([
      () => new Response("boom", { status: 503 }),
      () => okBody(GOOD_JSON),
    ]);

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const result = await run(provider);

    expect(result.ok).toBe(true);
    expect(result.ok && result.model).toBe("qwen3-5-4b");
    expect(result.ok && result.drafts[0]?.sourceMessageIds).toEqual([7]);
    expect(calls.map((call) => call.model)).toEqual([
      "glm-4-7-flash",
      "qwen3-5-4b",
    ]);

    // Same conversation batch and provenance ids went to Qwen.
    const qwenBody = JSON.parse(bodies[1] ?? "{}") as {
      messages: Array<{ content: string }>;
    };

    expect(qwenBody.messages[1]?.content).toContain("#7 user:");
  });

  it("clear model-overload 429 falls back to Qwen (regression)", async () => {
    const { fetchFn, calls } = makeScriptedFetch([
      () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "The service may be temporarily overloaded, please try again later",
              code: 429,
            },
          }),
          { status: 429 },
        ),
      () => okBody(GOOD_JSON),
    ]);

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const result = await run(provider);

    expect(result.ok).toBe(true);
    expect(result.ok && result.model).toBe("qwen3-5-4b");
    expect(calls.map((call) => call.model)).toEqual([
      "glm-4-7-flash",
      "qwen3-5-4b",
    ]);
  });

  it("account-quota 429 body never falls back (regression)", async () => {
    const { fetchFn, calls } = makeScriptedFetch([
      () =>
        new Response(
          JSON.stringify({
            error: { message: "rate limit exceeded for account", code: 429 },
          }),
          { status: 429 },
        ),
    ]);

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const result = await run(provider);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.kind).toBe("rate_limited");
    expect(result.ok ? null : result.modelOverload).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("GLM failure then Qwen 429 preserves the rate_limited cooldown (regression)", async () => {
    const { fetchFn, calls } = makeScriptedFetch([
      () => new Response("boom", { status: 503 }),
      () =>
        new Response("rate limit exceeded", {
          status: 429,
          headers: { "retry-after": "90" },
        }),
    ]);

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const result = await run(provider);

    // Qwen's rate_limited (and its Retry-After) must govern — not the
    // primary's server error, which would burn a retry attempt.
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.kind).toBe("rate_limited");
    expect(result.ok ? null : result.retryAfterMs).toBe(90_000);
    expect(calls).toHaveLength(2);
  });

  it("malformed GLM output falls back; malformed Qwen preserves the job", async () => {
    const bothBad = makeScriptedFetch([
      () => okBody("prose, not json"),
      () => okBody("also prose"),
    ]);

    const provider = new GlmExtractionProvider(testConfig(), bothBad.fetchFn);

    const result = await run(provider);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.kind).toBe("malformed");
    expect(result.ok ? null : result.retryable).toBe(true);
    expect(result.ok ? null : result.message).toContain("fallback malformed");
    expect(bothBad.calls).toHaveLength(2);
  });

  it("AUTH failures do NOT waste a fallback attempt", async () => {
    const { fetchFn, calls } = makeScriptedFetch([
      () => new Response("denied", { status: 401 }),
    ]);

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const result = await run(provider);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.kind).toBe("auth");
    expect(calls).toHaveLength(1);
  });

  it("429 quota NEVER falls back and applies a shared cooldown", async () => {
    const { fetchFn, calls } = makeScriptedFetch([
      () =>
        new Response("rate limit exceeded", {
          status: 429,
          headers: { "retry-after": "60000" },
        }),
    ]);

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const first = await run(provider);

    expect(first.ok).toBe(false);
    expect(first.ok ? null : first.kind).toBe("rate_limited");
    expect(first.ok ? null : first.retryAfterMs).toBe(60_000);
    expect(calls).toHaveLength(1);

    const second = await run(provider);

    expect(second.ok).toBe(false);
    expect(second.ok ? null : second.kind).toBe("rate_limited");
    expect(calls).toHaveLength(1); // cooldown blocked the network too
  });

  it("fallback can be disabled with fallbackModel: null", async () => {
    const { fetchFn, calls } = makeScriptedFetch([
      () => new Response("boom", { status: 500 }),
    ]);

    const provider = new GlmExtractionProvider(
      testConfig({ fallbackModel: null }),
      fetchFn,
    );

    const result = await run(provider);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.kind).toBe("server");
    expect(calls).toHaveLength(1);
  });
});
