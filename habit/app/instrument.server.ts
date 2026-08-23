import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.RAILWAY_ENVIRONMENT_NAME ||
      process.env.NODE_ENV ||
      "development",
    release: process.env.RAILWAY_GIT_COMMIT_SHA,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
  });
}

export { Sentry };

export function captureServerException(
  error: unknown,
  context?: Record<string, unknown>,
) {
  if (!dsn) {
    console.error(error, context);
    return;
  }
  Sentry.withScope((scope) => {
    if (context) scope.setContext("extra", context);
    Sentry.captureException(error);
  });
}

if (dsn) {
  process.on("unhandledRejection", (reason) => {
    captureServerException(reason, { phase: "unhandledRejection" });
  });
  process.on("uncaughtException", (error) => {
    captureServerException(error, { phase: "uncaughtException" });
  });
}
