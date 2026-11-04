import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { resolveI18n, type I18nText } from '@herp/i18n';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { isoDate } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { BudgetsController } from '../banking/budgets.controller';
import { todayIn } from '../staff/staff.dto';

type Attention = { severity: 'critical' | 'warning' | 'info'; key: string; count: number; deepLink: string };

/**
 * EFA Daily Pulse: one call for the operations office (Head / EFA Office Admin).
 * Every figure is read under the caller's RLS context, from the same tables and
 * rules as the module endpoints, so the pulse cannot disagree with them.
 * `attention` lists what needs a decision today, most severe first; the app
 * renders the labels from `key` in the viewer's language.
 */
@Controller('dashboard')
export class PulseController {
  constructor(private readonly db: PrismaService, private readonly budgets: BudgetsController) {}

  @Get('pulse')
  pulse(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      const [admin] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT app.is_household_admin() AS ok`;
      if (!admin?.ok) throw new ForbiddenException('the Daily Pulse is for the Household Head and the EFA office');
      const h = await tx.household.findFirstOrThrow({ where: { id: ctx.householdId }, select: { timezone: true } });
      const today = todayIn(h.timezone);
      const y = today.getUTCFullYear(), m = today.getUTCMonth() + 1;
      const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
      const monthEnd = new Date(Date.UTC(y, m, 0));

      const [payroll, documents, medical, workOrders, approvals, petty, budgets, funding, handovers, disputes, remindersToday, fleet] = await Promise.all([
        this.payroll(tx, y, m, prev, monthEnd, today), this.documents(tx, ctx), this.medical(tx, ctx, today), this.workOrders(tx),
        this.approvals(tx, ctx), this.pettyCash(tx), this.budgetAlerts(tx, ctx, today), this.funding(tx), this.handovers(tx),
        tx.salaryPayment.count({ where: { status: 'DISPUTED' } }),
        tx.reminder.count({ where: { status: 'PENDING', remindAt: { lte: new Date() } } }),
        this.fleet(tx, today),
      ]);

      const attention: Attention[] = [];
      const add = (cond: number, severity: Attention['severity'], key: string, deepLink: string) => { if (cond > 0) attention.push({ severity, key, count: cond, deepLink }); };
      add(documents.byTier.EXPIRED ?? 0, 'critical', 'pulse.documentsExpired', 'herp://staff/documents/expiring');
      add(medical.overdue + medical.missing, 'critical', 'pulse.medicalOverdue', 'herp://compliance/staff');
      add(disputes, 'critical', 'pulse.salaryDisputes', 'herp://salary-payments?status=DISPUTED');
      add(payroll.previousMonth.unpaidWorkers, 'critical', 'pulse.salaryUnpaidLastMonth', 'herp://salary-payments');
      add(handovers.overdue, 'warning', 'pulse.itemsOverdue', 'herp://compliance/staff');
      add(documents.byTier['15'] ?? 0, 'warning', 'pulse.documentsDue15', 'herp://staff/documents/expiring');
      add(workOrders.overdue, 'warning', 'pulse.workOrdersOverdue', 'herp://work-orders?overdue=true');
      add(approvals.awaitingMe, 'warning', 'pulse.approvalsWaiting', 'herp://requests?awaitingMe=true');
      add(budgets.filter((b) => b.overBudget).length, 'warning', 'pulse.budgetsOver', 'herp://budgets');
      add(petty.pendingReview.count, 'info', 'pulse.pettyCashToReview', 'herp://petty-cash');
      add(petty.lowBalance.length, 'info', 'pulse.floatsLow', 'herp://petty-cash');
      add(funding.openItems, 'info', 'pulse.fundingToMatch', 'herp://funding-clearing');
      add(medical.dueSoon, 'info', 'pulse.medicalDueSoon', 'herp://compliance/staff');
      add(fleet.documentsDue, 'warning', 'pulse.vehicleDocsDue', 'herp://fleet/overview');
      add(fleet.servicesOverdue, 'warning', 'pulse.vehicleServiceOverdue', 'herp://fleet/overview');
      add(fleet.fuelFlagged, 'warning', 'pulse.fuelFlagged', 'herp://fleet/overview');
      if (payroll.currentMonth.status === 'NONE' && payroll.currentMonth.daysUntilDue <= 5) attention.push({ severity: 'warning', key: 'pulse.payrollNotStarted', count: 1, deepLink: 'herp://payroll-runs' });
      const rank = { critical: 0, warning: 1, info: 2 } as const;
      attention.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);

      return { generatedAt: new Date().toISOString(), today: isoDate(today), attention, payroll, documents, medical, workOrders, approvals, pettyCash: petty,
               budgets: { alerts: budgets.filter((b) => b.alert).length, over: budgets.filter((b) => b.overBudget).length, items: budgets.filter((b) => b.alert) },
               fundingClearing: funding, handovers, salaryDisputes: disputes, remindersDueNow: remindersToday, fleet };
    });
  }

  private async fleet(tx: Tx, today: Date) {
    const soon = new Date(today.getTime() + 15 * 86_400_000);
    const vehicles = await tx.vehicle.findMany({ where: { deletedAt: null, status: { notIn: ['SOLD', 'OUT_OF_SERVICE'] } },
      select: { odometerKm: true, registrationExpiry: true, insuranceExpiry: true, inspectionExpiry: true,
                plans: { where: { isActive: true }, select: { nextDueKm: true, nextDueDate: true } } } });
    const documentsDue = vehicles.flatMap((v) => [v.registrationExpiry, v.insuranceExpiry, v.inspectionExpiry]).filter((x) => x && x <= soon).length;
    const servicesOverdue = vehicles.flatMap((v) => v.plans.filter((p) => (p.nextDueDate && p.nextDueDate < today) || (p.nextDueKm != null && v.odometerKm > p.nextDueKm))).length;
    const fuelFlagged = await tx.fuelLog.count({ where: { flagged: true, filledAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } });
    return { vehicles: vehicles.length, documentsDue, servicesOverdue, fuelFlagged };
  }

  private async payroll(tx: Tx, y: number, m: number, prev: { y: number; m: number }, monthEnd: Date, today: Date) {
    const cur = await tx.payrollRun.findFirst({ where: { periodYear: y, periodMonth: m } });
    const last = await tx.payrollRun.findFirst({ where: { periodYear: prev.y, periodMonth: prev.m } });
    // Workers employed last month with an active contract and no (non-reversed) salary payment for it.
    const prevStart = new Date(Date.UTC(prev.y, prev.m - 1, 1)), prevEnd = new Date(Date.UTC(prev.y, prev.m, 0));
    const unpaid = await tx.staffProfile.count({ where: {
      deletedAt: null, status: { in: ['ACTIVE', 'ON_PROBATION', 'ON_LEAVE'] },
      contracts: { some: { startDate: { lte: prevEnd }, OR: [{ endDate: null }, { endDate: { gte: prevStart } }] } },
      salaryPayments: { none: { periodYear: prev.y, periodMonth: prev.m, status: { not: 'REVERSED' } } } } });
    return {
      currentMonth: { period: `${y}-${String(m).padStart(2, '0')}`, status: cur?.status ?? 'NONE', dueDate: isoDate(monthEnd),
                      daysUntilDue: Math.round((monthEnd.getTime() - today.getTime()) / 86_400_000), total: cur ? Number(cur.totalAmount).toFixed(2) : null },
      previousMonth: { period: `${prev.y}-${String(prev.m).padStart(2, '0')}`, status: last?.status ?? 'NONE', unpaidWorkers: unpaid },
    };
  }

  private async documents(tx: Tx, ctx: RequestContext) {
    const rows = await tx.$queryRaw<Array<{ id: string; type: string; staff: I18nText; expiry: Date; days: number; tier: string | null }>>`
      SELECT d.id::text, d.type::text, s."fullNameI18n" AS staff, d."expiryDate" AS expiry,
             (d."expiryDate" - (now() AT TIME ZONE h.timezone)::date) AS days,
             app.document_alert_tier(d."expiryDate" - (now() AT TIME ZONE h.timezone)::date, d."alertDays") AS tier
      FROM identity_documents d JOIN staff_profiles s ON s.id = d."staffId" AND s."deletedAt" IS NULL AND s.status NOT IN ('TERMINATED', 'FINAL_EXIT')
      JOIN households h ON h.id = d."householdId"
      WHERE d."expiryDate" IS NOT NULL AND app.document_alert_tier(d."expiryDate" - (now() AT TIME ZONE h.timezone)::date, d."alertDays") IS NOT NULL
      ORDER BY d."expiryDate"`;
    const byTier: Record<string, number> = {};
    for (const r of rows) byTier[r.tier!] = (byTier[r.tier!] ?? 0) + 1;
    return { byTier, soonest: rows.slice(0, 5).map((r) => ({ id: r.id, type: r.type, staff: resolveI18n(r.staff, { locale: ctx.locale }).text, expiryDate: isoDate(r.expiry), daysLeft: r.days })) };
  }

  private async medical(tx: Tx, ctx: RequestContext, today: Date) {
    const staff = await tx.staffProfile.findMany({ where: { deletedAt: null, status: { notIn: ['TERMINATED', 'FINAL_EXIT'] } },
      select: { id: true, fullNameI18n: true, hireDate: true, createdAt: true, medicalCheckups: { where: { result: { in: ['FIT', 'FIT_WITH_RESTRICTIONS'] } }, select: { validUntil: true } } } });
    let overdue = 0, missing = 0, dueSoon = 0; const list: Array<{ staffId: string; name: string; status: string; dueDate: string | null }> = [];
    for (const s of staff) {
      const until = s.medicalCheckups.map((c) => c.validUntil.getTime()).sort((a, b) => b - a)[0];
      const due = until ?? (s.hireDate ?? s.createdAt).getTime() + 30 * 86_400_000;
      const days = Math.round((due - today.getTime()) / 86_400_000);
      const status = days < 0 ? (until ? 'OVERDUE' : 'MISSING') : days <= 30 ? 'DUE_SOON' : 'VALID';
      if (status === 'OVERDUE') overdue++; else if (status === 'MISSING') missing++; else if (status === 'DUE_SOON') dueSoon++;
      if (status !== 'VALID') list.push({ staffId: s.id, name: resolveI18n(s.fullNameI18n as I18nText, { locale: ctx.locale }).text, status, dueDate: isoDate(new Date(due)) });
    }
    return { overdue, missing, dueSoon, workers: staff.length, needsAction: list.slice(0, 10) };
  }

  private async workOrders(tx: Tx) {
    const open = await tx.workOrder.groupBy({ by: ['status'], where: { deletedAt: null, status: { in: ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED'] } }, _count: true });
    const overdue = await tx.workOrder.count({ where: { deletedAt: null, status: { in: ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'] }, dueAt: { lt: new Date() } } });
    const by = Object.fromEntries(open.map((o) => [o.status, o._count]));
    return { byStatus: by, open: open.filter((o) => o.status !== 'COMPLETED').reduce((n, o) => n + o._count, 0), awaitingVerification: by.COMPLETED ?? 0, overdue };
  }

  private async approvals(tx: Tx, ctx: RequestContext) {
    const inReview = await tx.request.findMany({ where: { status: 'IN_REVIEW' }, select: { currentStep: true, approvals: { select: { approverId: true, step: true, decision: true } } } });
    return { inReview: inReview.length,
             awaitingMe: inReview.filter((r) => r.approvals.some((a) => a.approverId === ctx.membershipId && a.step === r.currentStep && a.decision === 'PENDING')).length };
  }

  private async pettyCash(tx: Tx) {
    const pending = await tx.pettyCashLog.aggregate({ where: { status: 'PENDING_REVIEW' }, _count: true, _sum: { amount: true } });
    const floats = await tx.pettyCashAccount.findMany({ where: { isActive: true, lowBalanceAlert: { not: null } } });
    return { pendingReview: { count: pending._count, amount: Number(pending._sum.amount ?? 0).toFixed(2) },
             lowBalance: floats.filter((f) => Number(f.currentBalance) <= Number(f.lowBalanceAlert)).map((f) => ({ id: f.id, balance: Number(f.currentBalance).toFixed(2) })) };
  }

  private async budgetAlerts(tx: Tx, ctx: RequestContext, today: Date) {
    const rows = await tx.budget.findMany({ where: { OR: [{ endsOn: null }, { endsOn: { gte: today } }] } });
    return Promise.all(rows.map((b) => this.budgets.withSpend(tx, ctx, b, today)));
  }

  private async funding(tx: Tx) {
    const [r] = await tx.$queryRaw<Array<{ balance: string | null; open: number }>>`
      WITH c AS (SELECT e.id, sum(l.credit - l.debit) AS credit FROM journal_entries e JOIN journal_lines l ON l."entryId" = e.id
                 JOIN ledger_accounts a ON a.id = l."ledgerAccountId" WHERE a."systemKey" = 'funding_clearing' AND e.status = 'POSTED' GROUP BY e.id)
      SELECT (SELECT (sum(l.debit) - sum(l.credit))::text FROM journal_lines l JOIN ledger_accounts a ON a.id = l."ledgerAccountId" WHERE a."systemKey" = 'funding_clearing') AS balance,
             (SELECT count(*)::int FROM c WHERE c.credit > COALESCE((SELECT sum(amount) FROM funding_matches m WHERE m."journalEntryId" = c.id), 0)) AS open`;
    return { balance: Number(r?.balance ?? 0).toFixed(2), openItems: r?.open ?? 0 };
  }

  private async handovers(tx: Tx) {
    const out = await tx.assetHandover.findMany({ where: { status: { in: ['PENDING_ACK', 'ISSUED'] } }, select: { status: true, expectedReturnAt: true } });
    return { out: out.length, awaitingSignature: out.filter((h) => h.status === 'PENDING_ACK').length,
             overdue: out.filter((h) => h.expectedReturnAt && h.expectedReturnAt < new Date()).length };
  }
}
