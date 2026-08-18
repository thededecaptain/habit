import * as Sentry from "@sentry/node";

type LogLevel = "info" | "warn" | "error";

let sentryStarted = false;

export function initSentry() {
  if (sentryStarted || !process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0,
  });
  sentryStarted = true;
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...serializeFields(fields),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  if (level === "error" && process.env.SENTRY_DSN) {
    initSentry();
    const err =
      fields.error instanceof Error ? fields.error : new Error(String(fields.error ?? event));
    Sentry.captureException(err, { extra: { event, ...serializeFields(fields) } });
  }
}

function serializeFields(fields: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      out[key] = value.message;
      out[`${key}Name`] = value.name;
    } else {
      out[key] = value;
    }
  }
  return out;
}
