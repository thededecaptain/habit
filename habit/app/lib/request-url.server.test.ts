import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isInvalidUrlError,
  parseRequestUrl,
  throwInvalidUrlAs400,
} from "./request-url.server";

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
