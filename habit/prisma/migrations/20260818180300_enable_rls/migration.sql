-- The Shopify app only talks to Postgres through Prisma as the postgres role.
-- Enable RLS with no policies so the Data API (anon / authenticated) is denied
-- by default. postgres and service_role bypass RLS, so Prisma is unaffected.

ALTER TABLE "Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PointTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReferralCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VipTier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "Session" FROM anon, authenticated;
REVOKE ALL ON TABLE "Customer" FROM anon, authenticated;
REVOKE ALL ON TABLE "ShopSettings" FROM anon, authenticated;
REVOKE ALL ON TABLE "PointTransaction" FROM anon, authenticated;
REVOKE ALL ON TABLE "ReferralCode" FROM anon, authenticated;
REVOKE ALL ON TABLE "VipTier" FROM anon, authenticated;
REVOKE ALL ON TABLE "_prisma_migrations" FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
