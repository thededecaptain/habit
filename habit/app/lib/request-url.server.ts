/**
 * React Router loaders treat a thrown TypeError as a 500 "Unexpected Server
 * Error". Shopify's automated review (and anyone sending a garbage Host or
 * shop dest) can make `new URL(...)` throw ERR_INVALID_URL. Answer 400 instead.
 */
export function isInvalidUrlError(error: unknown): error is TypeError {
  if (!(error instanceof TypeError)) return false;
  if (error.message === "Invalid URL") return true;
  if ("code" in error && (error as { code?: string }).code === "ERR_INVALID_URL") return true;
  // `new Request(badUrl)` wraps the URL error: "Failed to parse URL from …".
  return isInvalidUrlError((error as { cause?: unknown }).cause);
}

export function throwInvalidUrlAs400(error: unknown): never {
  if (isInvalidUrlError(error)) {
    throw new Response("Invalid URL", { status: 400 });
  }
  throw error;
}

export function parseRequestUrl(request: Request) {
  try {
    return new URL(request.url);
  } catch (error) {
    throwInvalidUrlAs400(error);
  }
}

export function withInvalidUrlGuard<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<T>,
) {
  return async (...args: Args): Promise<T> => {
    try {
      return await fn(...args);
    } catch (error) {
      throwInvalidUrlAs400(error);
    }
  };
}
