/**
 * Shopify does not let a UI extension talk to us directly — it proxies the
 * fetch through its own infrastructure, which sends its own User-Agent. That
 * User-Agent is classified as a bot by the isbot check inside
 * authenticate.public.*, which answers 410 Gone before our loader ever runs,
 * so the extension silently gets no data. The library only allowlists
 * "Shopify POS/" and "Shopify Mobile/".
 *
 * These endpoints are only ever called by our extensions and still require a
 * valid session token, so bot filtering buys us nothing here. Relabel the
 * request so it reaches the session token check.
 */
const ALLOWLISTED_USER_AGENT = "Shopify Mobile/habit-extension-proxy";

export function allowExtensionUserAgent(request: Request) {
  const headers = new Headers(request.headers);
  const original = headers.get("User-Agent") ?? "";
  headers.set("User-Agent", ALLOWLISTED_USER_AGENT);

  // Body is intentionally dropped: these handlers read the session token and
  // query string only, and cloning a stream here would need duplex plumbing.
  return {
    request: new Request(request.url, { method: request.method, headers }),
    originalUserAgent: original,
  };
}
