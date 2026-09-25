// Tests never talk to Shopify or production: every value here is a fake.
process.env.SHOPIFY_API_KEY ??= "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.SCOPES ??= "read_orders,read_customers,write_customers,write_discounts";
process.env.SHOPIFY_APP_URL ??= "https://habit.test";
process.env.CRON_SECRET = "test-cron-secret";
delete process.env.SENTRY_DSN;
delete process.env.SHOPIFY_APP_PRICING;
delete process.env.SHOPIFY_PARTNER_ORG_ID;
delete process.env.SHOPIFY_PARTNER_API_TOKEN;
delete process.env.SHOPIFY_BILLING_TEST;
