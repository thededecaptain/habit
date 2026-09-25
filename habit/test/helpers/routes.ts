import { vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteFn = (args: any) => unknown;

/**
 * Calls a loader or action like React Router does. A thrown Response
 * (redirects, 4xx) comes back as `thrown` instead of failing the test.
 */
export async function call(fn: RouteFn | undefined, request: Request, params: Record<string, string> = {}) {
  if (!fn) throw new Error("Route has no such export");
  // Route results are whatever each loader returns; tests assert on them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Result = { value: any; thrown: Response | undefined };
  try {
    return { value: await fn({ request, params, context: {} }), thrown: undefined } as Result;
  } catch (error) {
    if (error instanceof Response) return { value: undefined, thrown: error } as Result;
    throw error;
  }
}

export function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://habit.test${path}`, { headers });
}

export function post(path: string, fields: Record<string, string | number | null | undefined>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return new Request(`https://habit.test${path}`, { method: "POST", body });
}

export function postJson(path: string, json: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://habit.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(json),
  });
}

/** Silences the app's own console output for the rest of the test. */
export function quiet() {
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
}
