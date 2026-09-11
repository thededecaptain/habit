/**
 * authenticate.public.* runs the request's User-Agent through isbot and
 * answers 410 Gone before our loader sees it. isbot flags more than crawlers:
 * any Electron-based or embedded browser matches, because "Electron" appears
 * in its User-Agent. A customer in one of those would silently get no rewards
 * data.
 *
 * These endpoints only ever serve our own UI extensions and are secured by
 * session token validation, so bot filtering adds nothing — a crawler has no
 * valid token. Relabel the agent so the request reaches that check, and let
 * the token decide.
 */
const ALLOWLISTED_USER_AGENT = "Shopify Mobile/habit-extension";

export function allowExtensionUserAgent(request: Request) {
  const headers = new Headers(request.headers);
  headers.set("User-Agent", ALLOWLISTED_USER_AGENT);

  // Body is intentionally dropped: these handlers read the session token and
  // query string only, and cloning a stream here would need duplex plumbing.
  return new Request(request.url, { method: request.method, headers });
}

/**
 * The `dest` claim is not consistently a full URL — Thank you page tokens
 * carry a bare domain, which makes `new URL(dest)` throw and the endpoint
 * answer 500. Accept either shape.
 */
export function shopFromSessionTokenDest(dest: unknown) {
  const value = String(dest ?? "");
  try {
    return new URL(value).hostname;
  } catch {
    return value.replace(/^https?:\/\//, "").split("/")[0];
  }
}
