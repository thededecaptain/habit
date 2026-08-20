import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { runExpirePointsJob, runOutboxJob } from "../lib/jobs.server";

function secretsEqual(provided: string, expected: string) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorize(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    throw new Response("Cron is not configured", { status: 503 });
  }

  const header = request.headers.get("Authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const querySecret = new URL(request.url).searchParams.get("secret") ?? "";

  if ((bearer && secretsEqual(bearer, expected)) || (querySecret && secretsEqual(querySecret, expected))) {
    return;
  }

  throw new Response("Unauthorized", { status: 401 });
}

async function resolveJob(request: Request): Promise<"outbox" | "expire-points"> {
  const fromQuery = new URL(request.url).searchParams.get("job");
  let job = fromQuery;
  if (!job && request.method !== "GET") {
    try {
      const body = (await request.json()) as { job?: string };
      job = body?.job ?? null;
    } catch {
      job = null;
    }
  }
  if (job === "outbox" || job === "expire-points") return job;
  throw new Response('Unknown job. Use {"job":"outbox"} or {"job":"expire-points"}.', {
    status: 400,
  });
}

async function handleJobs(request: Request) {
  authorize(request);
  const job = await resolveJob(request);
  if (job === "outbox") {
    const result = await runOutboxJob();
    return Response.json({ ok: true, job, ...result });
  }
  const result = await runExpirePointsJob();
  return Response.json({ ok: true, job, ...result });
}

export const loader = async ({ request }: LoaderFunctionArgs) => handleJobs(request);
export const action = async ({ request }: ActionFunctionArgs) => handleJobs(request);
