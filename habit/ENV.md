# Environment variables

## Required (production)

| Variable | Description |
| --- | --- |
| `SHOPIFY_API_KEY` | Partner app client ID |
| `SHOPIFY_API_SECRET` | Partner app secret |
| `SCOPES` | OAuth scopes (see `shopify.app.toml`) |
| `SHOPIFY_APP_URL` | Public app URL, e.g. `https://habit-production-9257.up.railway.app` |
| `DATABASE_URL` | Postgres connection string |
| `CRON_SECRET` | Bearer token for `/internal/jobs` (Railway cron) |

## Billing

| Variable | Description |
| --- | --- |
| `SHOPIFY_APP_PRICING` | Set to `true` when App Pricing is enabled in Partner Dashboard |
| `SHOPIFY_APP_HANDLE` | App handle for plan URLs (default: `habit-loyalty`) |

## Observability (optional)

| Variable | Description |
| --- | --- |
| `SENTRY_DSN` | Sentry project DSN — enables server error capture when set |
| `RAILWAY_ENVIRONMENT_NAME` | Used as Sentry `environment` on Railway |
| `RAILWAY_GIT_COMMIT_SHA` | Attached as Sentry `release` when deployed |

Create a free Sentry project (Node.js), copy the DSN, and add it to Railway → habit service → Variables.

## Smoke tests

```bash
HABIT_URL=https://habit-production-9257.up.railway.app npm run smoke
```

Checks `/health` (DB ping) and the public landing page.
