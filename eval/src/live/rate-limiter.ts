/*
 * ---------------------------------------------------
 * ACCOUNT-LEVEL RATE LIMITER
 * ---------------------------------------------------
 * EmpirioLabs default account: 50 requests/minute and
 * 2M tokens/minute (account-wide, all keys combined).
 *
 * We stay well under both so normal runs never see a 429:
 *  - max 45 requests / rolling 60s
 *  - estimated tokens per request are tracked; if the projected
 *    rolling minute would cross 1.9M, we wait before sending.
 */

const MAX_REQUESTS_PER_MINUTE = 45;

const TOKEN_SOFT_LIMIT_PER_MINUTE = 1_900_000;

const WINDOW_MS = 60_000;

export type RateLimiter = {
  /**
   * Waits until one more request (of the given estimated token size)
   * is allowed, then records it. Call BEFORE every send.
   */
  acquire(requestTokens: number): Promise<void>;
};

export function createRateLimiter(): RateLimiter {
  const requests: number[] = [];

  const tokenEvents: Array<{ at: number; tokens: number }> = [];

  async function wait(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  return {
    async acquire(requestTokens: number): Promise<void> {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const now = Date.now();

        while (requests.length > 0 && now - requests[0] > WINDOW_MS) {
          requests.shift();
        }

        while (tokenEvents.length > 0 && now - tokenEvents[0].at > WINDOW_MS) {
          tokenEvents.shift();
        }

        const tokensInWindow = tokenEvents.reduce(
          (sum, event) => sum + event.tokens,
          0,
        );

        if (
          requests.length < MAX_REQUESTS_PER_MINUTE &&
          tokensInWindow + requestTokens <= TOKEN_SOFT_LIMIT_PER_MINUTE
        ) {
          requests.push(now);

          tokenEvents.push({ at: now, tokens: requestTokens });

          return;
        }

        /*
         * Oldest entry defines how long until a slot frees up.
         */
        const oldestRequest = requests[0] ?? now;

        const oldestToken = tokenEvents[0]?.at ?? now;

        const waitUntil = Math.min(oldestRequest, oldestToken) + WINDOW_MS;

        await wait(Math.max(waitUntil - Date.now(), 250));
      }
    },
  };
}
