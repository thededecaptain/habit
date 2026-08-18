/// <reference types="vite/client" />
/// <reference types="@react-router/node" />

interface ImportMetaEnv {
  readonly SENTRY_DSN?: string;
  readonly SUPPORT_EMAIL?: string;
  readonly BILLING_TEST?: string;
}
