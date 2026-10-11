import { describe, expect, it } from "vitest";

import { ExtractionRateLimiter, estimateTokens } from "../rate-limit.js";

describe("estimateTokens", () => {
  it("estimates ~4 chars per token plus fixed overhead", () => {
    expect(estimateTokens(0)).toBe(64);
    expect(estimateTokens(400)).toBe(164);
  });
});

describe("ExtractionRateLimiter", () => {
  function makeLimiter(
    options: Partial<
      Parameters<typeof ExtractionRateLimiter.prototype.acquire>["length"]
    > extends never
      ? never
      : {
          maxRequestsPerMinute: number;
          maxTokensPerMinute: number;
          minIntervalMs: number;
        },
  ) {
    let now = 1_000_000;

    const sleeps: number[] = [];

    const limiter = new ExtractionRateLimiter({
      ...options,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);

        now += ms;
      },
    });

    const advance = (ms: number): void => {
      now += ms;
    };

    return { limiter, sleeps, advance, getNow: () => now };
  }

  it("allows requests under the per-minute limit immediately", async () => {
    const { limiter, sleeps } = makeLimiter({
      maxRequestsPerMinute: 3,
      maxTokensPerMinute: 100_000,
      minIntervalMs: 0,
    });

    await limiter.acquire(100);
    await limiter.acquire(100);
    await limiter.acquire(100);

    expect(sleeps).toEqual([]);
  });

  it("waits when the requests-per-minute budget is exhausted", async () => {
    const { limiter, sleeps, getNow } = makeLimiter({
      maxRequestsPerMinute: 2,
      maxTokensPerMinute: 100_000,
      minIntervalMs: 0,
    });

    await limiter.acquire(10);
    await limiter.acquire(10);

    await limiter.acquire(10);

    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(59_000);

    // After the sleep advanced the fake clock past the window, the
    // next request is free again.
    const before = sleeps.length;

    await limiter.acquire(10);

    expect(sleeps.length).toBe(before);
    expect(getNow()).toBeGreaterThan(1_059_000);
  });

  it("waits when the token budget would be exceeded", async () => {
    const { limiter, sleeps } = makeLimiter({
      maxRequestsPerMinute: 100,
      maxTokensPerMinute: 1_000,
      minIntervalMs: 0,
    });

    await limiter.acquire(800);

    await limiter.acquire(800);

    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(59_000);
  });

  it("enforces the minimum interval between requests", async () => {
    const { limiter, sleeps } = makeLimiter({
      maxRequestsPerMinute: 100,
      maxTokensPerMinute: 100_000,
      minIntervalMs: 5_000,
    });

    await limiter.acquire(10);

    await limiter.acquire(10);

    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(5_000);
  });
});
