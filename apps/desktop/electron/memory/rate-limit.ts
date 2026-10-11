/*
 * Client-side limiter for the extraction provider.
 *
 * Account ceilings: 50 requests/min and 2,000,000 tokens/min shared
 * across keys. Defaults sit well below both (20 req/min, 1.6M
 * tokens/min) plus a minimum gap between requests.
 *
 * Cooldown: when the provider answers 429, it is asking EVERYONE to
 * wait — penalty() blocks all acquisitions until then, so retries and
 * brand-new jobs cannot hammer an overloaded service.
 */

export const WINDOW_MS = 60_000;

export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4) + 64;
}

export type RateLimiterOptions = {
  maxRequestsPerMinute: number;
  maxTokensPerMinute: number;
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class ExtractionRateLimiter {
  private requestTimes: number[] = [];

  private tokenEvents: Array<{ at: number; tokens: number }> = [];

  private lastRequestAt = 0;

  private cooldownUntil = 0;

  private readonly now: () => number;

  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: RateLimiterOptions) {
    this.now = options.now ?? Date.now;

    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Provider asked everyone to wait: block acquisitions until then. */
  penalty(ms: number, now: number = this.now()): void {
    if (ms <= 0) {
      return;
    }

    this.cooldownUntil = Math.max(this.cooldownUntil, now + ms);
  }

  /** Ms until the cooldown lifts (0 = clear to call). */
  remainingCooldownMs(now: number = this.now()): number {
    return Math.max(0, this.cooldownUntil - now);
  }

  async acquire(estimatedTokens: number): Promise<void> {
    for (;;) {
      const now = this.now();

      this.prune(now);

      let waitMs = this.remainingCooldownMs(now);

      if (this.requestTimes.length >= this.options.maxRequestsPerMinute) {
        waitMs = Math.max(waitMs, this.requestTimes[0] + WINDOW_MS - now);
      }

      const tokenSum = this.tokenEvents.reduce(
        (sum, event) => sum + event.tokens,
        0,
      );

      const tokenBudgetWouldExceed =
        estimatedTokens <= this.options.maxTokensPerMinute &&
        this.tokenEvents.length > 0 &&
        tokenSum + estimatedTokens > this.options.maxTokensPerMinute;

      if (tokenBudgetWouldExceed) {
        waitMs = Math.max(waitMs, this.tokenEvents[0].at + WINDOW_MS - now);
      }

      const sinceLast = now - this.lastRequestAt;

      if (this.lastRequestAt > 0 && sinceLast < this.options.minIntervalMs) {
        waitMs = Math.max(waitMs, this.options.minIntervalMs - sinceLast);
      }

      if (waitMs <= 0) {
        this.requestTimes.push(now);

        this.tokenEvents.push({ at: now, tokens: estimatedTokens });

        this.lastRequestAt = now;

        return;
      }

      await this.sleep(waitMs + 1);
    }
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;

    this.requestTimes = this.requestTimes.filter((at) => at > cutoff);

    this.tokenEvents = this.tokenEvents.filter((event) => event.at > cutoff);
  }
}
