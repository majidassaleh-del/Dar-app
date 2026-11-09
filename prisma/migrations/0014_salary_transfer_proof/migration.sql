-- A Musaned or bank transfer is proven by its reference OR by a screenshot of the transfer
-- (banks now route domestic-worker transfers through Musaned, so the bank's confirmation is the evidence).
-- proofFileId keeps its same-household reference check (rls.sql).
ALTER TABLE "salary_payments" DROP CONSTRAINT "salary_ref_required";
ALTER TABLE "salary_payments" ADD CONSTRAINT "salary_ref_required"
  CHECK ("channel" NOT IN ('MUSANED', 'BANK_TRANSFER') OR length(trim(coalesce("externalRef", ''))) > 0 OR "proofFileId" IS NOT NULL);
