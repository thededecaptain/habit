import { afterEach, describe, expect, test } from "vitest";
import { isBillingTest } from "./billing";

describe("isBillingTest", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBillingTest = process.env.BILLING_TEST;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalBillingTest === undefined) delete process.env.BILLING_TEST;
    else process.env.BILLING_TEST = originalBillingTest;
  });

  test("defaults to true outside production", () => {
    delete process.env.BILLING_TEST;
    process.env.NODE_ENV = "development";
    expect(isBillingTest()).toBe(true);
  });

  test("defaults to false in production", () => {
    delete process.env.BILLING_TEST;
    process.env.NODE_ENV = "production";
    expect(isBillingTest()).toBe(false);
  });

  test("honors an explicit BILLING_TEST override", () => {
    process.env.NODE_ENV = "production";
    process.env.BILLING_TEST = "true";
    expect(isBillingTest()).toBe(true);
  });
});
