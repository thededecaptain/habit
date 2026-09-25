import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isInvalidUrlError,
  parseRequestUrl,
  throwInvalidUrlAs400,
} from "../../app/lib/request-url.server";

test("parseRequestUrl returns a URL for a valid request", () => {
  const url = parseRequestUrl(new Request("https://example.com/app?host=abc"));
  assert.equal(url.pathname, "/app");
  assert.equal(url.searchParams.get("host"), "abc");
});

test("parseRequestUrl answers 400 when the request URL is not a valid URL", () => {
  const request = { url: "https://not a host" } as Request;
  assert.throws(
    () => parseRequestUrl(request),
    (error: unknown) => error instanceof Response && error.status === 400,
  );
});

test("throwInvalidUrlAs400 turns ERR_INVALID_URL into a 400 Response", () => {
  let caught: unknown;
  try {
    new URL("https://\u00f7\u00df|bad");
  } catch (error) {
    caught = error;
  }
  assert.equal(isInvalidUrlError(caught), true);
  assert.throws(
    () => throwInvalidUrlAs400(caught),
    (error: unknown) => error instanceof Response && error.status === 400,
  );
});

test("throwInvalidUrlAs400 rethrows other errors", () => {
  assert.throws(() => throwInvalidUrlAs400(new Error("nope")), /nope/);
});

test("recognises the URL error that new Request() wraps", () => {
  let wrapped: unknown;
  try {
    new Request("not a url");
  } catch (error) {
    wrapped = error;
  }
  assert.equal(isInvalidUrlError(wrapped), true);
  assert.equal(isInvalidUrlError(new TypeError("Failed to fetch")), false);
});

test("withInvalidUrlGuard passes results through and turns bad URLs into 400s", async () => {
  const { withInvalidUrlGuard } = await import("../../app/lib/request-url.server");
  assert.equal(await withInvalidUrlGuard(async (x: number) => x * 2)(21), 42);
  const invalid = withInvalidUrlGuard(async () => {
    new URL("not a url");
  });
  const thrown = await invalid().catch((error: unknown) => error);
  assert.ok(thrown instanceof Response);
  assert.equal((thrown as Response).status, 400);
  const other = withInvalidUrlGuard(async () => {
    throw new Error("boom");
  });
  await assert.rejects(other(), /boom/);
});
