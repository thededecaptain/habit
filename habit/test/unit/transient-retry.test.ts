import assert from "node:assert/strict";
import { test } from "vitest";
import { isTransientFetchError, withTransientRetry } from "../../app/lib/transient-retry.server";

function httpRequestError() {
  const error = new Error("Http request error, no response available: GraphQL Client: fetch failed");
  error.name = "HttpRequestError";
  return error;
}

test("isTransientFetchError recognises network failures, not API errors", () => {
  assert.equal(isTransientFetchError(httpRequestError()), true);
  assert.equal(isTransientFetchError(new TypeError("fetch failed")), true);
  assert.equal(
    isTransientFetchError(new Error("wrapped", { cause: new Error("read ECONNRESET") })),
    true,
  );
  assert.equal(isTransientFetchError(new Error("GraphQL Client: Unauthorized")), false);
  assert.equal(isTransientFetchError(new Response(null, { status: 302 })), false);
});

test("withTransientRetry retries a transient failure and returns the result", async () => {
  let calls = 0;
  const result = await withTransientRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw httpRequestError();
      return "ok";
    },
    { baseDelayMs: 1 },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withTransientRetry gives up after the last attempt", async () => {
  let calls = 0;
  await assert.rejects(
    withTransientRetry(
      async () => {
        calls += 1;
        throw httpRequestError();
      },
      { attempts: 2, baseDelayMs: 1 },
    ),
    /fetch failed/,
  );
  assert.equal(calls, 2);
});

test("withTransientRetry does not retry other errors", async () => {
  let calls = 0;
  await assert.rejects(
    withTransientRetry(async () => {
      calls += 1;
      throw new Error("Access denied");
    }),
    /Access denied/,
  );
  assert.equal(calls, 1);
});
