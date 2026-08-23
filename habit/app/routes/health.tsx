import prisma from "../db.server";

/**
 * Lightweight readiness probe for Railway, smoke scripts, and uptime checks.
 * Does not require Shopify auth.
 */
export async function loader() {
  const started = Date.now();
  let db: "ok" | "error" = "ok";

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    db = "error";
    console.error("Health check: database unreachable", error);
  }

  const body = {
    ok: db === "ok",
    service: "habit",
    db,
    uptimeSeconds: Math.floor(process.uptime()),
    latencyMs: Date.now() - started,
    version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  };

  return Response.json(body, { status: body.ok ? 200 : 503 });
}
