-- AlterTable
ALTER TABLE "public"."employment_contracts" ALTER COLUMN "annualLeaveDays" SET DEFAULT 15;


-- Domestic Workers Regulation Art. 10: never below 30 days per 2 years (15 a year).
-- Existing contracts keep their value (30 a year was the old default and is above the minimum).
ALTER TABLE "public"."employment_contracts" ADD CONSTRAINT "employment_contracts_art10_min_leave" CHECK ("annualLeaveDays" >= 15);
