import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { appBridge } from "../helpers/ui";

vi.mock("@shopify/app-bridge-react", async () => {
  const { appBridge: bridge } = await import("../helpers/ui");
  return { useAppBridge: () => bridge };
});
vi.mock("@shopify/shopify-app-react-router/react", () => ({
  AppProvider: ({ children }: { children: unknown }) => children,
}));

// jsdom replaces AbortSignal and FormData, but Node's own Request (used by
// React Router for loaders and actions) only accepts Node's versions. Tests
// never abort requests, so drop the signal; send forms URL-encoded.
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init) {
      init = { ...init };
      delete init.signal;
      const body = init.body as unknown;
      if (body && typeof body === "object" && typeof (body as FormData).entries === "function") {
        const params = new URLSearchParams();
        for (const [key, value] of (body as FormData).entries()) params.append(key, String(value));
        const headers = new Headers(init.headers as HeadersInit);
        headers.set("Content-Type", "application/x-www-form-urlencoded");
        init = { ...init, body: params.toString(), headers };
      }
    }
    super(input, init);
  }
} as typeof Request;

beforeEach(() => {
  appBridge.toast.show.mockReset();
  appBridge.saveBar.show.mockReset();
  appBridge.saveBar.hide.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
