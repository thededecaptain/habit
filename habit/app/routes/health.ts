import type { LoaderFunctionArgs } from "react-router";
import { getHealth } from "../lib/health.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const health = await getHealth();
  return Response.json(health, { status: health.ok ? 200 : 503 });
};
