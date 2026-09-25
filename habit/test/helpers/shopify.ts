import { vi } from "vitest";

export const TEST_SHOP = "habit-test.myshopify.com";

type Variables = Record<string, unknown> | undefined;
type Handler = (variables: Variables) => unknown;

/**
 * Stand-in for Shopify's Admin GraphQL client. Handlers are registered per
 * operation name (every query/mutation in the app is named); an unhandled
 * operation answers `{ data: {} }`. A handler returning an Error makes the
 * call throw, like a network failure.
 */
export function createFakeAdmin() {
  const handlers = new Map<string, Handler>();
  const calls: { operation: string; variables: Variables }[] = [];

  const graphql = vi.fn(async (query: string, options?: { variables?: Record<string, unknown> }) => {
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
    calls.push({ operation, variables: options?.variables });
    const handler = handlers.get(operation);
    const result = handler ? await handler(options?.variables) : { data: {} };
    if (result instanceof Error) throw result;
    return Response.json(result);
  });

  return {
    graphql,
    calls,
    on(operation: string, handler: Handler) {
      handlers.set(operation, handler);
      return this;
    },
    callsTo(operation: string) {
      return calls.filter((c) => c.operation === operation);
    },
  };
}

export type FakeAdmin = ReturnType<typeof createFakeAdmin>;

/** Shopify's HttpRequestError for a request that never got a response. */
export function networkError() {
  const error = new Error("Http request error, no response available: GraphQL Client: fetch failed");
  error.name = "HttpRequestError";
  return error;
}

function redirect(url: string, init?: { target?: string }) {
  return new Response(null, {
    status: 302,
    headers: { Location: url, ...(init?.target ? { "X-Target": init.target } : {}) },
  });
}

/** The pieces tests reach into: one fake admin and billing per test. */
export const shopify = {
  admin: createFakeAdmin(),
  billing: {
    check: vi.fn(),
    cancel: vi.fn(),
  },
  redirect: vi.fn(redirect),
  /** Customer gid the checkout/customer-account session token carries. */
  sessionSub: undefined as string | undefined,
  sessionDest: `https://${TEST_SHOP}`,
};

const cors = (response: Response) => response;

/** Module double for app/shopify.server, installed by test/setup/shopify-mock.ts. */
export const shopifyServerModule = {
  default: {},
  apiVersion: "2026-07",
  addDocumentResponseHeaders: vi.fn(),
  registerWebhooks: vi.fn(),
  sessionStorage: {},
  login: vi.fn(),
  authenticate: {
    admin: vi.fn(),
    webhook: vi.fn(),
    public: {
      appProxy: vi.fn(),
      checkout: vi.fn(),
      customerAccount: vi.fn(),
    },
  },
  unauthenticated: {
    admin: vi.fn(),
  },
};

export function adminContext() {
  return {
    admin: shopify.admin,
    billing: shopify.billing,
    redirect: shopify.redirect,
    session: { id: `offline_${TEST_SHOP}`, shop: TEST_SHOP },
    cors,
  };
}

export function resetShopify() {
  shopify.admin = createFakeAdmin();
  shopify.billing.check.mockReset().mockResolvedValue({ hasActivePayment: false, appSubscriptions: [] });
  shopify.billing.cancel.mockReset().mockResolvedValue({});
  shopify.redirect.mockReset().mockImplementation(redirect);
  shopify.sessionSub = undefined;
  shopify.sessionDest = `https://${TEST_SHOP}`;

  const { authenticate, unauthenticated, login } = shopifyServerModule;
  authenticate.admin.mockReset().mockImplementation(async () => adminContext());
  authenticate.webhook.mockReset().mockImplementation(async () => {
    throw new Error("Set authenticate.webhook for this test (see webhookContext)");
  });
  authenticate.public.appProxy.mockReset().mockImplementation(async () => ({
    session: { shop: TEST_SHOP },
  }));
  const sessionToken = () => ({ dest: shopify.sessionDest, sub: shopify.sessionSub });
  authenticate.public.checkout.mockReset().mockImplementation(async () => ({ sessionToken: sessionToken(), cors }));
  authenticate.public.customerAccount.mockReset().mockImplementation(async () => ({ sessionToken: sessionToken(), cors }));
  unauthenticated.admin.mockReset().mockImplementation(async () => ({ admin: shopify.admin }));
  login.mockReset().mockResolvedValue({});
}

/** Makes authenticate.webhook resolve like a verified delivery. */
export function webhookContext(topic: string, payload: Record<string, unknown>, options: { session?: boolean } = {}) {
  const withSession = options.session ?? true;
  shopifyServerModule.authenticate.webhook.mockResolvedValue({
    shop: TEST_SHOP,
    topic,
    payload,
    session: withSession ? { id: `offline_${TEST_SHOP}`, shop: TEST_SHOP } : undefined,
    admin: withSession ? shopify.admin : undefined,
  });
}
