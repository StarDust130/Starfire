import { describe, expect, it, vi } from "vitest";

import {
  buildExtractionMessages,
  type ExtractionConfig,
  type ExtractionResult,
  GlmExtractionProvider,
  parseExtractionPayload,
  parseRetryAfterMs,
  resolveExtractionConfig,
} from "../extraction.js";

function testConfig(overrides?: Partial<ExtractionConfig>): ExtractionConfig {
  return {
    enabled: true,
    apiKey: "test-key",
    baseUrl: "https://provider.test/v1",
    model: "glm-4-7-flash",
    maxRequestsPerMinute: 1_000,
    maxTokensPerMinute: 10_000_000,
    minIntervalMs: 0,
    timeoutMs: 1_000,
    ...overrides,
  };
}

type CapturedRequest = { url: string; init: RequestInit };

function makeFetch(responder: () => Response): {
  fetchFn: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];

  const fetchFn = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push({ url: String(url), init: init ?? {} });

    return responder();
  }) as unknown as typeof fetch;

  return { fetchFn, requests };
}

function okBody(content: string, usage?: Record<string, number>): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
      ...(usage ? { usage } : {}),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function extractWith(
  provider: GlmExtractionProvider,
  batch: Array<{ id: number; role: "user" | "assistant"; content: string }>,
): Promise<ExtractionResult> {
  return provider.extract({ context: [], batch });
}

describe("resolveExtractionConfig", () => {
  it("is disabled without an API key", () => {
    const config = resolveExtractionConfig({});

    expect(config.enabled).toBe(false);
    expect(config.apiKey).toBeNull();
    expect(config.baseUrl).toBe("https://api.empiriolabs.ai/v1");
    expect(config.model).toBe("glm-4-7-flash");
  });

  it("is enabled with a key and honors the kill switch", () => {
    expect(
      resolveExtractionConfig({ STARFIRE_MEMORY_API_KEY: " k " }).enabled,
    ).toBe(true);

    expect(
      resolveExtractionConfig({
        STARFIRE_MEMORY_API_KEY: "k",
        STARFIRE_MEMORY_CLOUD_DISABLED: "1",
      }).enabled,
    ).toBe(false);
  });

  it("honors custom overrides", () => {
    const config = resolveExtractionConfig({
      STARFIRE_MEMORY_API_KEY: "k",
      STARFIRE_MEMORY_MODEL: "glm-4-7-flash",
      STARFIRE_MEMORY_BASE_URL: "https://mirror.test/v1",
      STARFIRE_GLM_MAX_RPM: "10",
    });

    expect(config.baseUrl).toBe("https://mirror.test/v1");
    expect(config.maxRequestsPerMinute).toBe(10);
  });
});

describe("buildExtractionMessages", () => {
  it("includes ids and roles, keeping batch verbatim and context capped", () => {
    const context = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      role: "user" as const,
      content: `old ${index + 1}`,
    }));

    const { user } = buildExtractionMessages({
      context,
      batch: [{ id: 99, role: "assistant", content: "The full reply text." }],
    });

    expect(user).toContain("#99 assistant: The full reply text.");
    expect(user).not.toContain("#1 user: old 1");
    expect(user).toContain("#9 user: old 9");
    expect(user).toContain("READ-ONLY");
  });
});

describe("parseExtractionPayload", () => {
  // #14 was spoken by the user; #15 by the assistant.
  const provenance = new Map<number, "user" | "assistant">([
    [14, "user"],
    [15, "assistant"],
  ]);

  it("parses valid drafts, normalizes keys, filters provenance ids", () => {
    const result = parseExtractionPayload(
      JSON.stringify({
        memories: [
          {
            category: "profile",
            key: "User Name",
            content: "The user's name is Thor.",
            importance: 4,
            sourceMessageIds: ["14", 999],
          },
        ],
      }),
      provenance,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.drafts[0]?.key).toBe("user-name");
    expect(result.ok && result.drafts[0]?.sourceMessageIds).toEqual([14]);
    expect(result.ok && result.drafts[0]?.importance).toBe(4);
  });

  it("accepts fenced JSON and coerces string numbers", () => {
    const result = parseExtractionPayload(
      '```json\n{"memories":[{"category":"fact","key":"Editor","content":"Uses VS Code.","importance":"3","sourceMessageIds":[14]}]}\n```',
      provenance,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.drafts[0]?.importance).toBe(3);
  });

  it("drops invalid items but keeps valid siblings", () => {
    const result = parseExtractionPayload(
      JSON.stringify({
        memories: [
          { category: "nonsense", key: "x", content: "bad category" },
          {
            category: "fact",
            key: "editor",
            content: "Uses VS Code.",
            sourceMessageIds: [14],
          },
        ],
      }),
      provenance,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.drafts).toHaveLength(1);
    expect(result.ok && result.drafts[0]?.key).toBe("editor");
  });

  it("rejects prose and non-memory payloads as malformed", () => {
    expect(
      parseExtractionPayload("I found some memories!", provenance).ok,
    ).toBe(false);

    expect(parseExtractionPayload('{"other":1}', provenance).ok).toBe(false);
  });

  it("unwraps a nested memories object (real model behavior)", () => {
    const result = parseExtractionPayload(
      JSON.stringify({
        answer: {
          memories: [
            {
              category: "profile",
              key: "user.name",
              content: "The user's name is Thor.",
              sourceMessageIds: [14],
            },
          ],
        },
      }),
      provenance,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.drafts).toHaveLength(1);
  });

  it("drops drafts that echo redaction placeholders", () => {
    const result = parseExtractionPayload(
      JSON.stringify({
        memories: [
          {
            category: "fact",
            key: "pw",
            content: "password is [REDACTED:assignment]",
          },
          {
            category: "fact",
            key: "editor",
            content: "Uses VS Code.",
            sourceMessageIds: [14],
          },
        ],
      }),
      provenance,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.drafts.map((draft) => draft.key)).toEqual([
      "editor",
    ]);
  });

  it("drops absence-style non-facts (backstop)", () => {
    const result = parseExtractionPayload(
      JSON.stringify({
        memories: [
          {
            category: "profile",
            key: "user.name",
            content: "The user's name is not yet known.",
          },
          {
            category: "profile",
            key: "user.name",
            content: "Thor is the user's name.",
            sourceMessageIds: [14],
          },
        ],
      }),
      provenance,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.drafts.map((draft) => draft.content)).toEqual([
      "Thor is the user's name.",
    ]);
  });

  it("REJECTS drafts whose only provenance is assistant messages", () => {
    const result = parseExtractionPayload(
      JSON.stringify({
        memories: [
          {
            category: "fact",
            key: "assistant.only",
            content: "Unproven claim.",
            sourceMessageIds: [15],
          },
          {
            category: "fact",
            key: "user.backed",
            content: "Proven claim.",
            sourceMessageIds: [15, 14],
          },
        ],
      }),
      provenance,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.drafts).toHaveLength(1);
    expect(result.ok && result.drafts[0]?.key).toBe("user.backed");
    expect(result.ok && result.drafts[0]?.sourceMessageIds).toEqual([14]);
  });

  it("REJECTS drafts with no valid source ids at all", () => {
    const result = parseExtractionPayload(
      JSON.stringify({
        memories: [
          { category: "fact", key: "orphan", content: "Nobody said this." },
        ],
      }),
      provenance,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.drafts).toEqual([]);
  });
});

describe("parseRetryAfterMs", () => {
  it("treats small values as seconds and huge values as milliseconds", () => {
    expect(parseRetryAfterMs("7")).toBe(7_000);
    expect(parseRetryAfterMs("60000")).toBe(60_000); // not 16.7 hours!
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("nonsense")).toBeNull();
    expect(parseRetryAfterMs("99999999")).toBe(600_000); // 10-min clamp
  });
});

describe("GlmExtractionProvider", () => {
  it("returns disabled without calling fetch when not configured", async () => {
    const { fetchFn, requests } = makeFetch(() => okBody("{}"));

    const provider = new GlmExtractionProvider(
      testConfig({ enabled: false }),
      fetchFn,
    );

    const result = await extractWith(provider, [
      { id: 1, role: "user", content: "hi" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.kind).toBe("disabled");
    expect(requests).toHaveLength(0);
  });

  it("sends the documented request shape and parses drafts", async () => {
    const { fetchFn, requests } = makeFetch(() =>
      okBody(
        JSON.stringify({
          memories: [
            {
              category: "profile",
              key: "user.name",
              content: "The user's name is Thor.",
              importance: 5,
              sourceMessageIds: [14],
            },
          ],
        }),
        { prompt_tokens: 500, completion_tokens: 40 },
      ),
    );

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const result = await extractWith(provider, [
      { id: 14, role: "user", content: "My name is Thor." },
    ]);

    expect(result.ok).toBe(true);
    expect(result.ok && result.empty).toBe(false);
    expect(result.ok && result.drafts[0]?.content).toBe(
      "The user's name is Thor.",
    );
    expect(result.ok && result.usage?.inputTokens).toBe(500);

    expect(requests[0]?.url).toBe("https://provider.test/v1/chat/completions");

    const headers = new Headers(requests[0]?.init.headers);

    expect(headers.get("authorization")).toBe("Bearer test-key");

    const body = JSON.parse(String(requests[0]?.init.body));

    expect(body.model).toBe("glm-4-7-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.tools).toBeUndefined();
  });

  it("treats a valid empty payload as success with empty=true", async () => {
    const { fetchFn } = makeFetch(() =>
      okBody(JSON.stringify({ memories: [] })),
    );

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const result = await extractWith(provider, [
      { id: 1, role: "user", content: "hello" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.ok && result.empty).toBe(true);
    expect(result.ok && result.drafts).toEqual([]);
  });

  it("never sends unredacted secrets", async () => {
    const { fetchFn, requests } = makeFetch(() =>
      okBody(JSON.stringify({ memories: [] })),
    );

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    await extractWith(provider, [
      {
        id: 7,
        role: "user",
        content: "my password is hunter2 and key sk-abcdefghijklmnopqrstuvwx",
      },
    ]);

    const body = String(requests[0]?.init.body);

    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(body).toContain("[REDACTED");
  });

  it("classifies auth errors as permanent", async () => {
    const { fetchFn } = makeFetch(
      () => new Response("denied", { status: 401 }),
    );

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const result = await extractWith(provider, [
      { id: 1, role: "user", content: "hi" },
    ]);

    expect(result.ok ? null : result.kind).toBe("auth");
    expect(result.ok ? null : result.retryable).toBe(false);
  });

  it("classifies 429 as retryable with the Retry-After delay", async () => {
    const { fetchFn } = makeFetch(
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "7" },
        }),
    );

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const result = await extractWith(provider, [
      { id: 1, role: "user", content: "hi" },
    ]);

    expect(result.ok ? null : result.kind).toBe("rate_limited");
    expect(result.ok ? null : result.retryable).toBe(true);
    expect(result.ok ? null : result.retryAfterMs).toBe(7_000);
  });

  it("classifies 5xx as retryable and 4xx as permanent", async () => {
    const server = new GlmExtractionProvider(
      testConfig(),
      makeFetch(() => new Response("boom", { status: 503 })).fetchFn,
    );

    const serverResult = await extractWith(server, [
      { id: 1, role: "user", content: "hi" },
    ]);

    expect(serverResult.ok ? null : serverResult.kind).toBe("server");
    expect(serverResult.ok ? null : serverResult.retryable).toBe(true);

    const client = new GlmExtractionProvider(
      testConfig(),
      makeFetch(() => new Response("bad request", { status: 400 })).fetchFn,
    );

    const clientResult = await extractWith(client, [
      { id: 1, role: "user", content: "hi" },
    ]);

    expect(clientResult.ok ? null : clientResult.kind).toBe("client");
    expect(clientResult.ok ? null : clientResult.retryable).toBe(false);
  });

  it("maps aborts to timeout and throws to network, both retryable", async () => {
    const aborting = async (): Promise<Response> => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };

    const timeoutProvider = new GlmExtractionProvider(
      testConfig(),
      aborting as unknown as typeof fetch,
    );

    const timeoutResult = await extractWith(timeoutProvider, [
      { id: 1, role: "user", content: "hi" },
    ]);

    expect(timeoutResult.ok ? null : timeoutResult.kind).toBe("timeout");
    expect(timeoutResult.ok ? null : timeoutResult.retryable).toBe(true);

    const breaking = async (): Promise<Response> => {
      throw new Error("ECONNRESET");
    };

    const networkProvider = new GlmExtractionProvider(
      testConfig(),
      breaking as unknown as typeof fetch,
    );

    const networkResult = await extractWith(networkProvider, [
      { id: 1, role: "user", content: "hi" },
    ]);

    expect(networkResult.ok ? null : networkResult.kind).toBe("network");
    expect(networkResult.ok ? null : networkResult.retryable).toBe(true);
  });

  it("timeout covers reading the response BODY, not just the headers", async () => {
    /*
     * Simulates a server that returns headers instantly, then stalls
     * the body forever. The abort must fire during text() and map to
     * a retryable timeout — this exact hang was a confirmed bug.
     */
    const fetchFn = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const signal = init?.signal;

      const stall = (): Promise<string> =>
        new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            reject(
              Object.assign(new Error("The operation was aborted."), {
                name: "AbortError",
              }),
            );
          };

          if (signal?.aborted) {
            onAbort();

            return;
          }

          signal?.addEventListener("abort", onAbort);
        });

      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: stall,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const provider = new GlmExtractionProvider(
      testConfig({ timeoutMs: 50 }),
      fetchFn,
    );

    const result = await extractWith(provider, [
      { id: 1, role: "user", content: "hi" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.kind).toBe("timeout");
    expect(result.ok ? null : result.retryable).toBe(true);
  });

  it("classifies malformed model output as retryable", async () => {
    const { fetchFn } = makeFetch(() => okBody("I cannot do that, sorry."));

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const result = await extractWith(provider, [
      { id: 1, role: "user", content: "hi" },
    ]);

    expect(result.ok ? null : result.kind).toBe("malformed");
    expect(result.ok ? null : result.retryable).toBe(true);
  });

  it("serializes concurrent extracts into one in-flight request", async () => {
    let inFlight = 0;

    let maxInFlight = 0;

    const fetchFn = (async (): Promise<Response> => {
      inFlight += 1;

      maxInFlight = Math.max(maxInFlight, inFlight);

      await new Promise((resolve) => setTimeout(resolve, 10));

      inFlight -= 1;

      return okBody(JSON.stringify({ memories: [] }));
    }) as unknown as typeof fetch;

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    await Promise.all([
      extractWith(provider, [{ id: 1, role: "user", content: "a" }]),
      extractWith(provider, [{ id: 2, role: "user", content: "b" }]),
      extractWith(provider, [{ id: 3, role: "user", content: "c" }]),
    ]);

    expect(maxInFlight).toBe(1);
  });

  it("account-quota 429 applies the shared cooldown and skips the network", async () => {
    let calls = 0;

    const fetchFn = (async (): Promise<Response> => {
      calls += 1;

      return new Response("rate limit exceeded", {
        status: 429,
        headers: { "retry-after": "60000" },
      });
    }) as unknown as typeof fetch;

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const first = await extractWith(provider, [
      { id: 1, role: "user", content: "hi" },
    ]);

    expect(first.ok ? null : first.kind).toBe("rate_limited");
    expect(first.ok ? null : first.retryAfterMs).toBe(60_000);
    expect(calls).toBe(1);

    const second = await extractWith(provider, [
      { id: 2, role: "user", content: "hi" },
    ]);

    expect(second.ok ? null : second.kind).toBe("rate_limited");
    expect(calls).toBe(1); // network NOT touched during cooldown
  });

  it("overload 429 does NOT apply the account cooldown (fallback stays possible)", async () => {
    let calls = 0;

    const fetchFn = (async (): Promise<Response> => {
      calls += 1;

      return new Response("temporarily overloaded", { status: 429 });
    }) as unknown as typeof fetch;

    const provider = new GlmExtractionProvider(testConfig(), fetchFn);

    const first = await extractWith(provider, [
      { id: 1, role: "user", content: "hi" },
    ]);

    expect(first.ok ? null : first.kind).toBe("rate_limited");
    expect(first.ok ? null : first.modelOverload).toBe(true);
    expect(first.ok ? null : first.retryAfterMs).toBe(30_000);

    const second = await extractWith(provider, [
      { id: 2, role: "user", content: "hi" },
    ]);

    // Overload is model-specific: the limiter must NOT block later
    // attempts, otherwise the healthy fallback could never be tried.
    expect(second.ok ? null : second.kind).toBe("rate_limited");
    expect(calls).toBe(2);
  });

  it("never logs the API key", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const { fetchFn } = makeFetch(() =>
        okBody(JSON.stringify({ memories: [] })),
      );

      const provider = new GlmExtractionProvider(testConfig(), fetchFn);

      await extractWith(provider, [{ id: 1, role: "user", content: "hi" }]);

      const logged = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

      expect(logged).not.toContain("test-key");
    } finally {
      logSpy.mockRestore();
    }
  });
});
