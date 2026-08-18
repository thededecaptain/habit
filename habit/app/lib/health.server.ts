import prisma from "../db.server";
import { log } from "./logger.server";

export type HealthStatus = {
  ok: boolean;
  db: "up" | "down";
  time: string;
};

export async function getHealth(): Promise<HealthStatus> {
  const time = new Date().toISOString();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, db: "up", time };
  } catch (error) {
    log("error", "health.db_down", { error });
    return { ok: false, db: "down", time };
  }
}
