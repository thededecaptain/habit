ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "onboardingCompletedSteps" TEXT NOT NULL DEFAULT '[]';
