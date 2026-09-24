/**
 * Admin API calls from Railway occasionally fail before any response arrives
 * ("GraphQL Client: fetch failed" — a reset keep-alive socket or a DNS blip).
 * Those are safe to retry; GraphQL errors and HTTP responses are not.
 */
export function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "HttpRequestError") return true;
  if (/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(error.message)) {
    return true;
  }
  return isTransientFetchError((error as { cause?: unknown }).cause);
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 150 }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isTransientFetchError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
}
