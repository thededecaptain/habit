import { beforeEach, vi } from "vitest";
import { resetShopify } from "../helpers/shopify";

// No test talks to Shopify: app/shopify.server is replaced everywhere.
vi.mock("../../app/shopify.server", async () => (await import("../helpers/shopify")).shopifyServerModule);

beforeEach(() => {
  resetShopify();
});
