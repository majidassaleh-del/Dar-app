-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "public"."Locale" AS ENUM ('ar', 'en', 'hi', 'tl', 'am', 'bn');

-- CreateEnum
CREATE TYPE "public"."SystemRole" AS ENUM ('HOUSEHOLD_HEAD', 'SPOUSE', 'DEPENDENT', 'STAFF', 'DRIVER', 'ACCOUNTANT', 'GUEST');

-- CreateEnum
CREATE TYPE "public"."MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "public"."SubscriptionPlan" AS ENUM ('FREE', 'FAMILY', 'PREMIUM', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "public"."StaffType" AS ENUM ('HOUSEMAID', 'COOK', 'NANNY', 'DRIVER', 'GARDENER', 'SECURITY', 'NURSE', 'TUTOR', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."EmploymentStatus" AS ENUM ('RECRUITING', 'ON_PROBATION', 'ACTIVE', 'ON_LEAVE', 'ABSCONDED', 'TERMINATED', 'FINAL_EXIT');

-- CreateEnum
CREATE TYPE "public"."IdentityDocumentType" AS ENUM ('PASSPORT', 'NATIONAL_ID', 'IQAMA', 'VISA', 'EXIT_REENTRY_VISA', 'WORK_PERMIT', 'DRIVING_LICENSE', 'MEDICAL_INSURANCE', 'MEDICAL_CERTIFICATE', 'CONTRACT', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."LeaveType" AS ENUM ('ANNUAL', 'SICK', 'EMERGENCY', 'UNPAID', 'HAJJ_UMRAH', 'VACATION_TRAVEL');

-- CreateEnum
CREATE TYPE "public"."PayrollStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."PayrollLineType" AS ENUM ('BASIC_SALARY', 'ALLOWANCE', 'OVERTIME', 'BONUS', 'DEDUCTION', 'ADVANCE_RECOVERY', 'END_OF_SERVICE');

-- CreateEnum
CREATE TYPE "public"."AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'HALF_DAY', 'DAY_OFF', 'ON_LEAVE');

-- CreateEnum
CREATE TYPE "public"."TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."FinancialAccountType" AS ENUM ('BANK_CURRENT', 'BANK_SAVINGS', 'CASH_BOX', 'DIGITAL_WALLET', 'CREDIT_CARD', 'LOAN', 'INVESTMENT_CASH');

-- CreateEnum
CREATE TYPE "public"."CardType" AS ENUM ('DEBIT', 'CREDIT', 'PREPAID', 'VIRTUAL');

-- CreateEnum
CREATE TYPE "public"."CardStatus" AS ENUM ('ACTIVE', 'FROZEN', 'LOST', 'EXPIRED', 'CLOSED');

-- CreateEnum
CREATE TYPE "public"."TransactionType" AS ENUM ('EXPENSE', 'INCOME', 'TRANSFER', 'ALLOWANCE', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "public"."TransactionStatus" AS ENUM ('PENDING', 'POSTED', 'RECONCILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "public"."TransactionSource" AS ENUM ('MANUAL', 'RECEIPT_OCR', 'BANK_FEED', 'CARD_WEBHOOK', 'SMS_PARSE', 'RECURRING', 'SYSTEM');

-- CreateEnum
CREATE TYPE "public"."ReceiptStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'EXTRACTED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."BudgetPeriod" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "public"."RecurrenceFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "public"."RequestType" AS ENUM ('PURCHASE', 'REIMBURSEMENT', 'SALARY_ADVANCE', 'LEAVE', 'ALLOWANCE_TOPUP', 'CARD_LIMIT_CHANGE', 'VEHICLE_USAGE', 'MAINTENANCE', 'GENERAL');

-- CreateEnum
CREATE TYPE "public"."RequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'FULFILLED');

-- CreateEnum
CREATE TYPE "public"."RequestPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "public"."ApprovalDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'DELEGATED');

-- CreateEnum
CREATE TYPE "public"."AssetClass" AS ENUM ('EQUITY', 'ETF', 'MUTUAL_FUND', 'SUKUK', 'BOND', 'REAL_ESTATE', 'GOLD', 'PRECIOUS_METAL', 'CRYPTO', 'PRIVATE_EQUITY', 'DEPOSIT', 'CASH', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."InvestmentTxnType" AS ENUM ('BUY', 'SELL', 'DIVIDEND', 'COUPON', 'RENTAL_INCOME', 'FEE', 'SPLIT', 'TRANSFER_IN', 'TRANSFER_OUT');

-- CreateEnum
CREATE TYPE "public"."ValuationSource" AS ENUM ('MARKET_FEED', 'MANUAL', 'APPRAISAL');

-- CreateEnum
CREATE TYPE "public"."VehicleStatus" AS ENUM ('ACTIVE', 'IN_MAINTENANCE', 'OUT_OF_SERVICE', 'SOLD');

-- CreateEnum
CREATE TYPE "public"."OwnershipType" AS ENUM ('OWNED', 'LEASED', 'FINANCED', 'RENTED');

-- CreateEnum
CREATE TYPE "public"."FuelType" AS ENUM ('PETROL_91', 'PETROL_95', 'DIESEL', 'HYBRID', 'ELECTRIC');

-- CreateEnum
CREATE TYPE "public"."MaintenanceType" AS ENUM ('OIL_CHANGE', 'TIRES', 'BRAKES', 'BATTERY', 'INSPECTION', 'REPAIR', 'BODYWORK', 'CLEANING', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."MaintenanceStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."ViolationStatus" AS ENUM ('UNPAID', 'PAID', 'DISPUTED', 'CHARGED_TO_STAFF');

-- CreateEnum
CREATE TYPE "public"."PropertyType" AS ENUM ('VILLA', 'APARTMENT', 'BUILDING', 'LAND', 'FARM', 'COMMERCIAL');

-- CreateEnum
CREATE TYPE "public"."PropertyUsage" AS ENUM ('PRIMARY_RESIDENCE', 'SECONDARY_RESIDENCE', 'RENTAL', 'VACANT');

-- CreateEnum
CREATE TYPE "public"."LeaseStatus" AS ENUM ('DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "public"."BillType" AS ENUM ('ELECTRICITY', 'WATER', 'GAS', 'INTERNET', 'MOBILE', 'SEWAGE', 'HOA', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."TicketStatus" AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "public"."AttachmentEntity" AS ENUM ('RECEIPT', 'TRANSACTION', 'STAFF_DOCUMENT', 'REQUEST', 'VEHICLE', 'MAINTENANCE', 'PROPERTY', 'LEASE', 'BILL', 'TICKET', 'ASSET', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."NotificationChannel" AS ENUM ('IN_APP', 'PUSH', 'EMAIL', 'SMS', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "public"."ReminderStatus" AS ENUM ('PENDING', 'SENT', 'ACKNOWLEDGED', 'SNOOZED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "public"."AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'APPROVE', 'REJECT', 'LOGIN', 'EXPORT', 'VIEW_SENSITIVE');

-- CreateTable
CREATE TABLE "public"."users" (
    "id" UUID NOT NULL,
    "phone" TEXT,
    "email" CITEXT,
    "fullNameI18n" JSONB NOT NULL DEFAULT '{}',
    "preferredLocale" "public"."Locale" NOT NULL DEFAULT 'ar',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    "avatarUrl" TEXT,
    "nationality" CHAR(2),
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "appVersion" TEXT,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."households" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "nameI18n" JSONB NOT NULL DEFAULT '{}',
    "defaultLocale" "public"."Locale" NOT NULL DEFAULT 'ar',
    "enabledLocales" "public"."Locale"[] DEFAULT ARRAY['ar', 'en']::"public"."Locale"[],
    "baseCurrency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "countryCode" CHAR(2) NOT NULL DEFAULT 'SA',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    "weekStartDay" INTEGER NOT NULL DEFAULT 0,
    "fiscalYearStart" INTEGER NOT NULL DEFAULT 1,
    "plan" "public"."SubscriptionPlan" NOT NULL DEFAULT 'FREE',
    "planRenewsAt" TIMESTAMPTZ(6),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "households_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."memberships" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "status" "public"."MembershipStatus" NOT NULL DEFAULT 'INVITED',
    "displayName" TEXT,
    "relationship" TEXT,
    "dateOfBirth" DATE,
    "guardianId" UUID,
    "invitedById" UUID,
    "expiresAt" TIMESTAMPTZ(6),
    "joinedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."roles" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "systemRole" "public"."SystemRole" NOT NULL,
    "nameI18n" JSONB NOT NULL DEFAULT '{}',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."permissions" (
    "id" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."role_permissions" (
    "roleId" UUID NOT NULL,
    "permissionId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'ALL',

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "public"."membership_permissions" (
    "membershipId" UUID NOT NULL,
    "permissionId" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'ALL',

    CONSTRAINT "membership_permissions_pkey" PRIMARY KEY ("membershipId","permissionId")
);

-- CreateTable
CREATE TABLE "public"."staff_profiles" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "membershipId" UUID,
    "staffType" "public"."StaffType" NOT NULL,
    "status" "public"."EmploymentStatus" NOT NULL DEFAULT 'RECRUITING',
    "fullNameI18n" JSONB NOT NULL DEFAULT '{}',
    "nationality" CHAR(2) NOT NULL,
    "gender" TEXT,
    "dateOfBirth" DATE,
    "religion" TEXT,
    "preferredLocale" "public"."Locale" NOT NULL DEFAULT 'en',
    "phone" TEXT,
    "emergencyContact" JSONB,
    "recruitmentAgency" TEXT,
    "musanedRef" TEXT,
    "borderNumber" TEXT,
    "hireDate" DATE,
    "probationEndsAt" DATE,
    "terminationDate" DATE,
    "weeklyDayOff" INTEGER,
    "livesIn" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."identity_documents" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "type" "public"."IdentityDocumentType" NOT NULL,
    "number" TEXT NOT NULL,
    "issuingCountry" CHAR(2),
    "issueDate" DATE,
    "expiryDate" DATE,
    "heldByEmployer" BOOLEAN NOT NULL DEFAULT false,
    "remindDaysBefore" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "identity_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."employment_contracts" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "basicSalary" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "allowances" JSONB NOT NULL DEFAULT '[]',
    "annualLeaveDays" INTEGER NOT NULL DEFAULT 30,
    "ticketEntitlement" BOOLEAN NOT NULL DEFAULT true,
    "endOfServiceRule" TEXT NOT NULL DEFAULT 'SA_DOMESTIC',
    "workingHoursPerDay" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "signedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employment_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payroll_runs" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "status" "public"."PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "totalAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(6),
    "paidAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payroll_lines" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "type" "public"."PayrollLineType" NOT NULL,
    "descriptionI18n" JSONB NOT NULL DEFAULT '{}',
    "amount" DECIMAL(18,2) NOT NULL,
    "advanceId" UUID,
    "transactionId" UUID,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."salary_advances" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "requestId" UUID,
    "amount" DECIMAL(18,2) NOT NULL,
    "outstanding" DECIMAL(18,2) NOT NULL,
    "monthlyInstallment" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "issuedAt" DATE NOT NULL,
    "settledAt" DATE,

    CONSTRAINT "salary_advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."leave_records" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "requestId" UUID,
    "type" "public"."LeaveType" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "days" DECIMAL(5,1) NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "exitReentryVisaId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."attendance" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" "public"."AttendanceStatus" NOT NULL,
    "checkInAt" TIMESTAMPTZ(6),
    "checkOutAt" TIMESTAMPTZ(6),
    "checkInGeo" JSONB,
    "note" TEXT,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."household_tasks" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "titleI18n" JSONB NOT NULL DEFAULT '{}',
    "description" TEXT,
    "assigneeId" UUID,
    "createdById" UUID NOT NULL,
    "status" "public"."TaskStatus" NOT NULL DEFAULT 'TODO',
    "dueAt" TIMESTAMPTZ(6),
    "recurrence" "public"."RecurrenceFrequency",
    "completedAt" TIMESTAMPTZ(6),
    "proofPhotoUrl" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "household_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."financial_accounts" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "type" "public"."FinancialAccountType" NOT NULL,
    "nameI18n" JSONB NOT NULL DEFAULT '{}',
    "institution" TEXT,
    "ibanLast4" VARCHAR(4),
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "openingBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currentBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "custodianId" UUID,
    "bankFeedRef" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "financial_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."cards" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "holderId" UUID,
    "type" "public"."CardType" NOT NULL,
    "status" "public"."CardStatus" NOT NULL DEFAULT 'ACTIVE',
    "nickname" TEXT,
    "last4" VARCHAR(4) NOT NULL,
    "network" TEXT,
    "expiryMonth" INTEGER NOT NULL,
    "expiryYear" INTEGER NOT NULL,
    "dailyLimit" DECIMAL(18,2),
    "monthlyLimit" DECIMAL(18,2),
    "perTxnLimit" DECIMAL(18,2),
    "allowedCategoryIds" UUID[],
    "issuerToken" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."categories" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "parentId" UUID,
    "kind" "public"."TransactionType" NOT NULL,
    "nameI18n" JSONB NOT NULL DEFAULT '{}',
    "icon" TEXT,
    "color" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."transactions" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "counterAccountId" UUID,
    "cardId" UUID,
    "categoryId" UUID,
    "type" "public"."TransactionType" NOT NULL,
    "status" "public"."TransactionStatus" NOT NULL DEFAULT 'POSTED',
    "source" "public"."TransactionSource" NOT NULL DEFAULT 'MANUAL',
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fxRate" DECIMAL(18,8),
    "baseAmount" DECIMAL(18,2) NOT NULL,
    "vatAmount" DECIMAL(18,2),
    "merchantName" TEXT,
    "merchantMcc" VARCHAR(4),
    "descriptionI18n" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "createdById" UUID NOT NULL,
    "spentById" UUID,
    "requestId" UUID,
    "vehicleId" UUID,
    "propertyId" UUID,
    "reversalOfId" UUID,
    "externalRef" TEXT,
    "tags" TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."receipts" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "uploadedById" UUID NOT NULL,
    "transactionId" UUID,
    "status" "public"."ReceiptStatus" NOT NULL DEFAULT 'UPLOADED',
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "ocrProvider" TEXT,
    "ocrRaw" JSONB,
    "extracted" JSONB,
    "confidence" DOUBLE PRECISION,
    "zatcaQr" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."budgets" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "categoryId" UUID,
    "ownerId" UUID,
    "nameI18n" JSONB NOT NULL DEFAULT '{}',
    "period" "public"."BudgetPeriod" NOT NULL DEFAULT 'MONTHLY',
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "alertAtPct" INTEGER NOT NULL DEFAULT 80,
    "rollover" BOOLEAN NOT NULL DEFAULT false,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."recurring_rules" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "template" JSONB NOT NULL,
    "frequency" "public"."RecurrenceFrequency" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "dayOfPeriod" INTEGER,
    "nextRunAt" TIMESTAMPTZ(6) NOT NULL,
    "endsAt" TIMESTAMPTZ(6),
    "autoPost" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "recurring_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."allowance_plans" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "dependentId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "frequency" "public"."RecurrenceFrequency" NOT NULL DEFAULT 'WEEKLY',
    "targetCardId" UUID,
    "savingsGoal" DECIMAL(18,2),
    "savingsPct" INTEGER NOT NULL DEFAULT 0,
    "nextPayoutAt" TIMESTAMPTZ(6) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "allowance_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."requests" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "type" "public"."RequestType" NOT NULL,
    "status" "public"."RequestStatus" NOT NULL DEFAULT 'SUBMITTED',
    "priority" "public"."RequestPriority" NOT NULL DEFAULT 'NORMAL',
    "titleI18n" JSONB NOT NULL DEFAULT '{}',
    "originalLocale" "public"."Locale" NOT NULL DEFAULT 'ar',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "amount" DECIMAL(18,2),
    "currency" CHAR(3),
    "neededBy" TIMESTAMPTZ(6),
    "currentStep" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."approval_policies" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "requestType" "public"."RequestType" NOT NULL,
    "minAmount" DECIMAL(18,2),
    "maxAmount" DECIMAL(18,2),
    "steps" JSONB NOT NULL,
    "autoApproveBelow" DECIMAL(18,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."approvals" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "step" INTEGER NOT NULL,
    "approverId" UUID NOT NULL,
    "decision" "public"."ApprovalDecision" NOT NULL DEFAULT 'PENDING',
    "comment" TEXT,
    "decidedAt" TIMESTAMPTZ(6),

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."portfolios" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "nameI18n" JSONB NOT NULL DEFAULT '{}',
    "broker" TEXT,
    "baseCurrency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "shariaCompliantOnly" BOOLEAN NOT NULL DEFAULT false,
    "ownerLabel" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."assets" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "assetClass" "public"."AssetClass" NOT NULL,
    "nameI18n" JSONB NOT NULL DEFAULT '{}',
    "symbol" TEXT,
    "exchange" TEXT,
    "isin" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "isShariaCompliant" BOOLEAN,
    "propertyId" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "zakatable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."holdings" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "quantity" DECIMAL(24,8) NOT NULL,
    "avgCost" DECIMAL(24,8) NOT NULL,
    "costBasis" DECIMAL(18,2) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "holdings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."investment_transactions" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "type" "public"."InvestmentTxnType" NOT NULL,
    "quantity" DECIMAL(24,8),
    "price" DECIMAL(24,8),
    "amount" DECIMAL(18,2) NOT NULL,
    "fees" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "fxRate" DECIMAL(18,8),
    "tradeDate" DATE NOT NULL,
    "purificationAmount" DECIMAL(18,2),
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "investment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."asset_valuations" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "asOf" TIMESTAMPTZ(6) NOT NULL,
    "unitValue" DECIMAL(24,8) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "source" "public"."ValuationSource" NOT NULL DEFAULT 'MARKET_FEED',

    CONSTRAINT "asset_valuations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vehicles" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "color" TEXT,
    "plateNumber" TEXT NOT NULL,
    "plateNumberAr" TEXT,
    "vin" TEXT,
    "fuelType" "public"."FuelType" NOT NULL DEFAULT 'PETROL_91',
    "status" "public"."VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
    "ownership" "public"."OwnershipType" NOT NULL DEFAULT 'OWNED',
    "leaseContractRef" TEXT,
    "odometerKm" INTEGER NOT NULL DEFAULT 0,
    "registrationExpiry" DATE,
    "insuranceExpiry" DATE,
    "insurancePolicy" TEXT,
    "inspectionExpiry" DATE,
    "purchasePrice" DECIMAL(18,2),
    "purchaseDate" DATE,
    "telematicsId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vehicle_assignments" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMPTZ(6) NOT NULL,
    "endsAt" TIMESTAMPTZ(6),
    "startOdometer" INTEGER,
    "endOdometer" INTEGER,

    CONSTRAINT "vehicle_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."maintenance_records" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "type" "public"."MaintenanceType" NOT NULL,
    "status" "public"."MaintenanceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "workshop" TEXT,
    "scheduledAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "odometerKm" INTEGER,
    "nextDueKm" INTEGER,
    "nextDueDate" DATE,
    "cost" DECIMAL(18,2),
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "notes" TEXT,
    "transactionId" UUID,

    CONSTRAINT "maintenance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."fuel_logs" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "filledAt" TIMESTAMPTZ(6) NOT NULL,
    "liters" DECIMAL(10,2) NOT NULL,
    "pricePerLiter" DECIMAL(10,3) NOT NULL,
    "totalCost" DECIMAL(18,2) NOT NULL,
    "odometerKm" INTEGER NOT NULL,
    "station" TEXT,
    "transactionId" UUID,

    CONSTRAINT "fuel_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."traffic_violations" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "staffId" UUID,
    "violationNo" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "descriptionI18n" JSONB NOT NULL DEFAULT '{}',
    "location" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" "public"."ViolationStatus" NOT NULL DEFAULT 'UNPAID',
    "dueDate" DATE,

    CONSTRAINT "traffic_violations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."trip_logs" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "purpose" TEXT,
    "passengers" UUID[],
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "endedAt" TIMESTAMPTZ(6),
    "startKm" INTEGER,
    "endKm" INTEGER,
    "route" JSONB,

    CONSTRAINT "trip_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."properties" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "nameI18n" JSONB NOT NULL DEFAULT '{}',
    "type" "public"."PropertyType" NOT NULL,
    "usage" "public"."PropertyUsage" NOT NULL DEFAULT 'PRIMARY_RESIDENCE',
    "addressI18n" JSONB NOT NULL DEFAULT '{}',
    "nationalAddress" TEXT,
    "city" TEXT,
    "geo" JSONB,
    "deedNumber" TEXT,
    "areaSqm" DECIMAL(12,2),
    "purchasePrice" DECIMAL(18,2),
    "purchaseDate" DATE,
    "electricityAccountNo" TEXT,
    "waterAccountNo" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."property_units" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "bedrooms" INTEGER,
    "areaSqm" DECIMAL(12,2),
    "meterNumbers" JSONB NOT NULL DEFAULT '{}',
    "isOccupied" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "property_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."leases" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'LANDLORD',
    "counterpartyName" TEXT NOT NULL,
    "counterpartyPhone" TEXT,
    "counterpartyIdNo" TEXT,
    "ejarContractNo" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "rentAmount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "paymentFrequency" "public"."RecurrenceFrequency" NOT NULL DEFAULT 'QUARTERLY',
    "securityDeposit" DECIMAL(18,2),
    "utilitiesIncluded" BOOLEAN NOT NULL DEFAULT false,
    "status" "public"."LeaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "hijriDated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "leases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."rent_payments" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "leaseId" UUID NOT NULL,
    "dueDate" DATE NOT NULL,
    "hijriDueDate" TEXT,
    "amountDue" DECIMAL(18,2) NOT NULL,
    "amountPaid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMPTZ(6),
    "transactionId" UUID,

    CONSTRAINT "rent_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."utility_bills" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "unitId" UUID,
    "type" "public"."BillType" NOT NULL,
    "provider" TEXT,
    "accountNo" TEXT,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "consumption" DECIMAL(14,3),
    "amount" DECIMAL(18,2) NOT NULL,
    "dueDate" DATE,
    "paidAt" TIMESTAMPTZ(6),
    "allocation" JSONB,
    "transactionId" UUID,

    CONSTRAINT "utility_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."maintenance_tickets" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "unitId" UUID,
    "reporterId" UUID NOT NULL,
    "assigneeId" UUID,
    "titleI18n" JSONB NOT NULL DEFAULT '{}',
    "category" TEXT,
    "priority" "public"."RequestPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "public"."TicketStatus" NOT NULL DEFAULT 'OPEN',
    "vendor" TEXT,
    "estimatedCost" DECIMAL(18,2),
    "actualCost" DECIMAL(18,2),
    "openedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "maintenance_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."attachments" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "entityType" "public"."AttachmentEntity" NOT NULL,
    "entityId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "isSensitive" BOOLEAN NOT NULL DEFAULT false,
    "uploadedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."reminders" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "recipientId" UUID,
    "entityType" "public"."AttachmentEntity" NOT NULL,
    "entityId" UUID NOT NULL,
    "titleI18n" JSONB NOT NULL DEFAULT '{}',
    "dueAt" TIMESTAMPTZ(6) NOT NULL,
    "remindAt" TIMESTAMPTZ(6) NOT NULL,
    "status" "public"."ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "channels" "public"."NotificationChannel"[] DEFAULT ARRAY['IN_APP', 'PUSH']::"public"."NotificationChannel"[],

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."notifications" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "public"."NotificationChannel" NOT NULL,
    "templateKey" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "deepLink" TEXT,
    "readAt" TIMESTAMPTZ(6),
    "sentAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "householdId" UUID,
    "actorUserId" UUID,
    "action" "public"."AuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" INET,
    "userAgent" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "public"."users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "public"."users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_devices_pushToken_key" ON "public"."user_devices"("pushToken");

-- CreateIndex
CREATE INDEX "user_devices_userId_idx" ON "public"."user_devices"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "households_slug_key" ON "public"."households"("slug");

-- CreateIndex
CREATE INDEX "memberships_householdId_status_idx" ON "public"."memberships"("householdId", "status");

-- CreateIndex
CREATE INDEX "memberships_userId_idx" ON "public"."memberships"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_householdId_userId_key" ON "public"."memberships"("householdId", "userId");

-- CreateIndex
CREATE INDEX "roles_householdId_idx" ON "public"."roles"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "roles_householdId_systemRole_isDefault_key" ON "public"."roles"("householdId", "systemRole", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_membershipId_key" ON "public"."staff_profiles"("membershipId");

-- CreateIndex
CREATE INDEX "staff_profiles_householdId_status_idx" ON "public"."staff_profiles"("householdId", "status");

-- CreateIndex
CREATE INDEX "staff_profiles_householdId_staffType_idx" ON "public"."staff_profiles"("householdId", "staffType");

-- CreateIndex
CREATE INDEX "identity_documents_householdId_expiryDate_idx" ON "public"."identity_documents"("householdId", "expiryDate");

-- CreateIndex
CREATE INDEX "identity_documents_staffId_type_idx" ON "public"."identity_documents"("staffId", "type");

-- CreateIndex
CREATE INDEX "employment_contracts_staffId_isActive_idx" ON "public"."employment_contracts"("staffId", "isActive");

-- CreateIndex
CREATE INDEX "employment_contracts_householdId_idx" ON "public"."employment_contracts"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_householdId_periodYear_periodMonth_key" ON "public"."payroll_runs"("householdId", "periodYear", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_transactionId_key" ON "public"."payroll_lines"("transactionId");

-- CreateIndex
CREATE INDEX "payroll_lines_payrollRunId_idx" ON "public"."payroll_lines"("payrollRunId");

-- CreateIndex
CREATE INDEX "payroll_lines_staffId_idx" ON "public"."payroll_lines"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "salary_advances_requestId_key" ON "public"."salary_advances"("requestId");

-- CreateIndex
CREATE INDEX "salary_advances_staffId_settledAt_idx" ON "public"."salary_advances"("staffId", "settledAt");

-- CreateIndex
CREATE UNIQUE INDEX "leave_records_requestId_key" ON "public"."leave_records"("requestId");

-- CreateIndex
CREATE INDEX "leave_records_staffId_startDate_idx" ON "public"."leave_records"("staffId", "startDate");

-- CreateIndex
CREATE INDEX "attendance_householdId_date_idx" ON "public"."attendance"("householdId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_staffId_date_key" ON "public"."attendance"("staffId", "date");

-- CreateIndex
CREATE INDEX "household_tasks_householdId_assigneeId_status_idx" ON "public"."household_tasks"("householdId", "assigneeId", "status");

-- CreateIndex
CREATE INDEX "financial_accounts_householdId_type_idx" ON "public"."financial_accounts"("householdId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "cards_issuerToken_key" ON "public"."cards"("issuerToken");

-- CreateIndex
CREATE INDEX "cards_householdId_holderId_idx" ON "public"."cards"("householdId", "holderId");

-- CreateIndex
CREATE INDEX "categories_householdId_kind_idx" ON "public"."categories"("householdId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_reversalOfId_key" ON "public"."transactions"("reversalOfId");

-- CreateIndex
CREATE INDEX "transactions_householdId_occurredAt_idx" ON "public"."transactions"("householdId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "transactions_householdId_categoryId_occurredAt_idx" ON "public"."transactions"("householdId", "categoryId", "occurredAt");

-- CreateIndex
CREATE INDEX "transactions_householdId_spentById_occurredAt_idx" ON "public"."transactions"("householdId", "spentById", "occurredAt");

-- CreateIndex
CREATE INDEX "transactions_cardId_idx" ON "public"."transactions"("cardId");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_householdId_accountId_externalRef_key" ON "public"."transactions"("householdId", "accountId", "externalRef");

-- CreateIndex
CREATE INDEX "receipts_householdId_status_idx" ON "public"."receipts"("householdId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_householdId_sha256_key" ON "public"."receipts"("householdId", "sha256");

-- CreateIndex
CREATE INDEX "budgets_householdId_period_idx" ON "public"."budgets"("householdId", "period");

-- CreateIndex
CREATE INDEX "recurring_rules_nextRunAt_isActive_idx" ON "public"."recurring_rules"("nextRunAt", "isActive");

-- CreateIndex
CREATE INDEX "allowance_plans_householdId_dependentId_idx" ON "public"."allowance_plans"("householdId", "dependentId");

-- CreateIndex
CREATE INDEX "requests_householdId_status_type_idx" ON "public"."requests"("householdId", "status", "type");

-- CreateIndex
CREATE INDEX "requests_requesterId_createdAt_idx" ON "public"."requests"("requesterId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "approval_policies_householdId_requestType_idx" ON "public"."approval_policies"("householdId", "requestType");

-- CreateIndex
CREATE INDEX "approvals_approverId_decision_idx" ON "public"."approvals"("approverId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_requestId_step_approverId_key" ON "public"."approvals"("requestId", "step", "approverId");

-- CreateIndex
CREATE INDEX "portfolios_householdId_idx" ON "public"."portfolios"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "assets_propertyId_key" ON "public"."assets"("propertyId");

-- CreateIndex
CREATE INDEX "assets_householdId_assetClass_idx" ON "public"."assets"("householdId", "assetClass");

-- CreateIndex
CREATE UNIQUE INDEX "assets_householdId_symbol_exchange_key" ON "public"."assets"("householdId", "symbol", "exchange");

-- CreateIndex
CREATE UNIQUE INDEX "holdings_portfolioId_assetId_key" ON "public"."holdings"("portfolioId", "assetId");

-- CreateIndex
CREATE INDEX "investment_transactions_householdId_tradeDate_idx" ON "public"."investment_transactions"("householdId", "tradeDate");

-- CreateIndex
CREATE INDEX "investment_transactions_portfolioId_assetId_idx" ON "public"."investment_transactions"("portfolioId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_valuations_assetId_asOf_source_key" ON "public"."asset_valuations"("assetId", "asOf", "source");

-- CreateIndex
CREATE INDEX "vehicles_householdId_status_idx" ON "public"."vehicles"("householdId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_householdId_plateNumber_key" ON "public"."vehicles"("householdId", "plateNumber");

-- CreateIndex
CREATE INDEX "vehicle_assignments_vehicleId_startsAt_idx" ON "public"."vehicle_assignments"("vehicleId", "startsAt");

-- CreateIndex
CREATE INDEX "vehicle_assignments_driverId_endsAt_idx" ON "public"."vehicle_assignments"("driverId", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_records_transactionId_key" ON "public"."maintenance_records"("transactionId");

-- CreateIndex
CREATE INDEX "maintenance_records_vehicleId_scheduledAt_idx" ON "public"."maintenance_records"("vehicleId", "scheduledAt");

-- CreateIndex
CREATE INDEX "maintenance_records_householdId_nextDueDate_idx" ON "public"."maintenance_records"("householdId", "nextDueDate");

-- CreateIndex
CREATE UNIQUE INDEX "fuel_logs_transactionId_key" ON "public"."fuel_logs"("transactionId");

-- CreateIndex
CREATE INDEX "fuel_logs_vehicleId_filledAt_idx" ON "public"."fuel_logs"("vehicleId", "filledAt");

-- CreateIndex
CREATE UNIQUE INDEX "traffic_violations_householdId_violationNo_key" ON "public"."traffic_violations"("householdId", "violationNo");

-- CreateIndex
CREATE INDEX "trip_logs_vehicleId_startedAt_idx" ON "public"."trip_logs"("vehicleId", "startedAt");

-- CreateIndex
CREATE INDEX "properties_householdId_usage_idx" ON "public"."properties"("householdId", "usage");

-- CreateIndex
CREATE UNIQUE INDEX "property_units_propertyId_label_key" ON "public"."property_units"("propertyId", "label");

-- CreateIndex
CREATE INDEX "leases_householdId_status_endDate_idx" ON "public"."leases"("householdId", "status", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "rent_payments_transactionId_key" ON "public"."rent_payments"("transactionId");

-- CreateIndex
CREATE INDEX "rent_payments_householdId_dueDate_idx" ON "public"."rent_payments"("householdId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "rent_payments_leaseId_dueDate_key" ON "public"."rent_payments"("leaseId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "utility_bills_transactionId_key" ON "public"."utility_bills"("transactionId");

-- CreateIndex
CREATE INDEX "utility_bills_propertyId_periodStart_idx" ON "public"."utility_bills"("propertyId", "periodStart");

-- CreateIndex
CREATE INDEX "maintenance_tickets_householdId_status_idx" ON "public"."maintenance_tickets"("householdId", "status");

-- CreateIndex
CREATE INDEX "attachments_householdId_entityType_entityId_idx" ON "public"."attachments"("householdId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "reminders_remindAt_status_idx" ON "public"."reminders"("remindAt", "status");

-- CreateIndex
CREATE INDEX "reminders_householdId_dueAt_idx" ON "public"."reminders"("householdId", "dueAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "public"."notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "audit_logs_householdId_createdAt_idx" ON "public"."audit_logs"("householdId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "public"."audit_logs"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "public"."user_devices" ADD CONSTRAINT "user_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."memberships" ADD CONSTRAINT "memberships_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."memberships" ADD CONSTRAINT "memberships_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "public"."roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."memberships" ADD CONSTRAINT "memberships_guardianId_fkey" FOREIGN KEY ("guardianId") REFERENCES "public"."memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."roles" ADD CONSTRAINT "roles_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "public"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "public"."permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."membership_permissions" ADD CONSTRAINT "membership_permissions_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "public"."memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."membership_permissions" ADD CONSTRAINT "membership_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "public"."permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."staff_profiles" ADD CONSTRAINT "staff_profiles_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."staff_profiles" ADD CONSTRAINT "staff_profiles_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "public"."memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."identity_documents" ADD CONSTRAINT "identity_documents_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."identity_documents" ADD CONSTRAINT "identity_documents_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employment_contracts" ADD CONSTRAINT "employment_contracts_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employment_contracts" ADD CONSTRAINT "employment_contracts_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payroll_runs" ADD CONSTRAINT "payroll_runs_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payroll_lines" ADD CONSTRAINT "payroll_lines_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payroll_lines" ADD CONSTRAINT "payroll_lines_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "public"."payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payroll_lines" ADD CONSTRAINT "payroll_lines_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payroll_lines" ADD CONSTRAINT "payroll_lines_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "public"."salary_advances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payroll_lines" ADD CONSTRAINT "payroll_lines_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."salary_advances" ADD CONSTRAINT "salary_advances_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."salary_advances" ADD CONSTRAINT "salary_advances_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."salary_advances" ADD CONSTRAINT "salary_advances_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "public"."requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."leave_records" ADD CONSTRAINT "leave_records_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."leave_records" ADD CONSTRAINT "leave_records_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."leave_records" ADD CONSTRAINT "leave_records_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "public"."requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."attendance" ADD CONSTRAINT "attendance_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."attendance" ADD CONSTRAINT "attendance_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."household_tasks" ADD CONSTRAINT "household_tasks_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."household_tasks" ADD CONSTRAINT "household_tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "public"."memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."household_tasks" ADD CONSTRAINT "household_tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."financial_accounts" ADD CONSTRAINT "financial_accounts_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."financial_accounts" ADD CONSTRAINT "financial_accounts_custodianId_fkey" FOREIGN KEY ("custodianId") REFERENCES "public"."memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cards" ADD CONSTRAINT "cards_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cards" ADD CONSTRAINT "cards_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cards" ADD CONSTRAINT "cards_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "public"."memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."categories" ADD CONSTRAINT "categories_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transactions" ADD CONSTRAINT "transactions_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transactions" ADD CONSTRAINT "transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transactions" ADD CONSTRAINT "transactions_counterAccountId_fkey" FOREIGN KEY ("counterAccountId") REFERENCES "public"."financial_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transactions" ADD CONSTRAINT "transactions_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "public"."cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transactions" ADD CONSTRAINT "transactions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transactions" ADD CONSTRAINT "transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transactions" ADD CONSTRAINT "transactions_spentById_fkey" FOREIGN KEY ("spentById") REFERENCES "public"."memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transactions" ADD CONSTRAINT "transactions_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "public"."requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transactions" ADD CONSTRAINT "transactions_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "public"."vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transactions" ADD CONSTRAINT "transactions_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "public"."properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transactions" ADD CONSTRAINT "transactions_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "public"."transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."receipts" ADD CONSTRAINT "receipts_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."receipts" ADD CONSTRAINT "receipts_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."receipts" ADD CONSTRAINT "receipts_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."budgets" ADD CONSTRAINT "budgets_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."budgets" ADD CONSTRAINT "budgets_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."budgets" ADD CONSTRAINT "budgets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."recurring_rules" ADD CONSTRAINT "recurring_rules_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."allowance_plans" ADD CONSTRAINT "allowance_plans_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."allowance_plans" ADD CONSTRAINT "allowance_plans_dependentId_fkey" FOREIGN KEY ("dependentId") REFERENCES "public"."memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."requests" ADD CONSTRAINT "requests_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."requests" ADD CONSTRAINT "requests_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."approval_policies" ADD CONSTRAINT "approval_policies_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."approvals" ADD CONSTRAINT "approvals_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."approvals" ADD CONSTRAINT "approvals_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "public"."requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."approvals" ADD CONSTRAINT "approvals_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."portfolios" ADD CONSTRAINT "portfolios_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."assets" ADD CONSTRAINT "assets_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."assets" ADD CONSTRAINT "assets_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "public"."properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."holdings" ADD CONSTRAINT "holdings_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."holdings" ADD CONSTRAINT "holdings_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "public"."portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."holdings" ADD CONSTRAINT "holdings_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "public"."assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."investment_transactions" ADD CONSTRAINT "investment_transactions_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."investment_transactions" ADD CONSTRAINT "investment_transactions_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "public"."portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."investment_transactions" ADD CONSTRAINT "investment_transactions_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "public"."assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."asset_valuations" ADD CONSTRAINT "asset_valuations_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."asset_valuations" ADD CONSTRAINT "asset_valuations_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "public"."assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vehicles" ADD CONSTRAINT "vehicles_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "public"."vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."maintenance_records" ADD CONSTRAINT "maintenance_records_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."maintenance_records" ADD CONSTRAINT "maintenance_records_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "public"."vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."maintenance_records" ADD CONSTRAINT "maintenance_records_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."fuel_logs" ADD CONSTRAINT "fuel_logs_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."fuel_logs" ADD CONSTRAINT "fuel_logs_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "public"."vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."fuel_logs" ADD CONSTRAINT "fuel_logs_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."traffic_violations" ADD CONSTRAINT "traffic_violations_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."traffic_violations" ADD CONSTRAINT "traffic_violations_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "public"."vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."traffic_violations" ADD CONSTRAINT "traffic_violations_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."trip_logs" ADD CONSTRAINT "trip_logs_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."trip_logs" ADD CONSTRAINT "trip_logs_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "public"."vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."trip_logs" ADD CONSTRAINT "trip_logs_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."properties" ADD CONSTRAINT "properties_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."property_units" ADD CONSTRAINT "property_units_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."property_units" ADD CONSTRAINT "property_units_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "public"."properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."leases" ADD CONSTRAINT "leases_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."leases" ADD CONSTRAINT "leases_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "public"."property_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."rent_payments" ADD CONSTRAINT "rent_payments_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."rent_payments" ADD CONSTRAINT "rent_payments_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "public"."leases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."rent_payments" ADD CONSTRAINT "rent_payments_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."utility_bills" ADD CONSTRAINT "utility_bills_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."utility_bills" ADD CONSTRAINT "utility_bills_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "public"."properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."utility_bills" ADD CONSTRAINT "utility_bills_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "public"."property_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."utility_bills" ADD CONSTRAINT "utility_bills_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "public"."properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "public"."property_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "public"."memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."attachments" ADD CONSTRAINT "attachments_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."reminders" ADD CONSTRAINT "reminders_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."reminders" ADD CONSTRAINT "reminders_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "public"."memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."notifications" ADD CONSTRAINT "notifications_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."audit_logs" ADD CONSTRAINT "audit_logs_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

