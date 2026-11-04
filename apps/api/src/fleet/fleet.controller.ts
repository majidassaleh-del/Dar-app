import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { FuelLog, MaintenancePlan, Prisma, Vehicle } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { assertWritten, isoDate, money } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { checkFuel, type Anomaly, type FuelType } from './fuel-anomalies';

const FUEL = ['PETROL_91', 'PETROL_95', 'DIESEL', 'HYBRID', 'ELECTRIC'] as const;
const MTYPES = ['OIL_CHANGE', 'TIRES', 'BRAKES', 'BATTERY', 'INSPECTION', 'REPAIR', 'BODYWORK', 'CLEANING', 'OTHER'] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ts = z.string().datetime({ offset: true });
const VehicleBody = z.object({
  make: z.string().trim().min(1).max(60), model: z.string().trim().min(1).max(60), year: z.number().int().min(1950).max(2100),
  color: z.string().max(40).optional(), plateNumber: z.string().trim().min(2).max(20), plateNumberAr: z.string().max(20).optional(),
  vin: z.string().max(40).optional(), fuelType: z.enum(FUEL).default('PETROL_91'), ownership: z.enum(['OWNED', 'LEASED', 'FINANCED', 'RENTED']).default('OWNED'),
  odometerKm: z.number().int().min(0).max(2_000_000).default(0),
  registrationNumber: z.string().max(40).optional(), registrationExpiry: date.optional(),
  insuranceProvider: z.string().max(80).optional(), insurancePolicy: z.string().max(60).optional(), insuranceExpiry: date.optional(),
  inspectionExpiry: date.optional(), lastInspectionAt: date.optional(), inspectionCenter: z.string().max(80).optional(),
  tankCapacityL: z.number().positive().max(300).optional(), expectedKmPerL: z.number().positive().max(60).optional(),
}).strict();
const VehicleUpdate = VehicleBody.omit({ odometerKm: true }).partial().extend({ status: z.enum(['ACTIVE', 'IN_MAINTENANCE', 'OUT_OF_SERVICE', 'SOLD']).optional() }).strict();
const Assign = z.object({ driverId: z.guid(), startsAt: ts.optional(), isPrimary: z.boolean().default(true) }).strict();
const Plan = z.object({ type: z.enum(MTYPES), title: z.string().trim().max(120).optional(), intervalKm: z.number().int().positive().max(200_000).optional(),
  intervalDays: z.number().int().positive().max(3650).optional(), lastDoneAt: date.optional(), lastDoneKm: z.number().int().min(0).optional() }).strict()
  .refine((p) => p.intervalKm || p.intervalDays, 'give intervalKm, intervalDays or both');
const PlanUpdate = z.object({ intervalKm: z.number().int().positive().max(200_000).nullable().optional(), intervalDays: z.number().int().positive().max(3650).nullable().optional(),
  isActive: z.boolean().optional(), title: z.string().trim().max(120).optional() }).strict();
const Service = z.object({ type: z.enum(MTYPES), planId: z.guid().optional(), status: z.enum(['SCHEDULED', 'COMPLETED']).default('COMPLETED'),
  scheduledAt: ts.optional(), completedAt: ts.optional(), odometerKm: z.number().int().min(0).optional(), workshop: z.string().max(120).optional(),
  cost: z.number().min(0).max(1_000_000).optional(), notes: z.string().max(1000).optional() }).strict();
const Odometer = z.object({ readingKm: z.number().int().min(0).max(2_000_000), readAt: ts.optional(), note: z.string().max(200).optional() }).strict();
const Fuel = z.object({
  liters: z.number().positive().max(500), totalCost: z.number().positive().max(100_000), pricePerLiter: z.number().positive().max(50).optional(),
  odometerKm: z.number().int().min(0).max(2_000_000), fuelType: z.enum(FUEL).optional(), station: z.string().max(120).optional(),
  filledAt: ts.optional(), receiptId: z.guid().optional(), pettyCashAccountId: z.guid().optional(),
}).strict();
const FuelQuery = z.object({ flagged: z.enum(['true', 'false']).optional() });

const d = (s?: string) => (s ? new Date(`${s}T00:00:00Z`) : undefined);
const daysUntil = (x: Date | null, today: Date) => (x ? Math.round((x.getTime() - today.getTime()) / 86_400_000) : null);
const today = () => new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date())}T00:00:00Z`);

const vehicleDto = (v: Vehicle) => {
  const t = today();
  const doc = (expiry: Date | null) => expiry ? { expiry: isoDate(expiry), daysLeft: daysUntil(expiry, t) } : null;
  return { id: v.id, make: v.make, model: v.model, year: v.year, color: v.color, plateNumber: v.plateNumber, plateNumberAr: v.plateNumberAr, vin: v.vin,
    fuelType: v.fuelType, status: v.status, ownership: v.ownership, odometerKm: v.odometerKm,
    registration: { number: v.registrationNumber, ...doc(v.registrationExpiry) },
    insurance: { provider: v.insuranceProvider, policy: v.insurancePolicy, ...doc(v.insuranceExpiry) },
    inspection: { center: v.inspectionCenter, lastAt: v.lastInspectionAt ? isoDate(v.lastInspectionAt) : null, ...doc(v.inspectionExpiry) },
    tankCapacityL: v.tankCapacityL ? Number(v.tankCapacityL) : null, expectedKmPerL: v.expectedKmPerL ? Number(v.expectedKmPerL) : null };
};
const planDto = (p: MaintenancePlan, odometerKm: number, locale: RequestContext['locale']) => {
  const dl = daysUntil(p.nextDueDate, today());
  const kmLeft = p.nextDueKm != null ? p.nextDueKm - odometerKm : null;
  const status = (dl != null && dl < 0) || (kmLeft != null && kmLeft < 0) ? 'OVERDUE' : (dl != null && dl <= 15) || (kmLeft != null && kmLeft <= 1000) ? 'DUE_SOON' : 'OK';
  return { id: p.id, vehicleId: p.vehicleId, type: p.type, title: resolveI18n(p.titleI18n as I18nText, { locale }).text || p.type,
    intervalKm: p.intervalKm, intervalDays: p.intervalDays, lastDoneAt: p.lastDoneAt ? isoDate(p.lastDoneAt) : null, lastDoneKm: p.lastDoneKm,
    nextDueDate: p.nextDueDate ? isoDate(p.nextDueDate) : null, nextDueKm: p.nextDueKm, daysLeft: dl, kmLeft, status: p.isActive ? status : 'INACTIVE', isActive: p.isActive };
};
const fuelDto = (f: FuelLog) => ({ id: f.id, vehicleId: f.vehicleId, driverId: f.driverId, filledAt: f.filledAt, liters: Number(f.liters),
  pricePerLiter: Number(f.pricePerLiter), totalCost: money(f.totalCost), odometerKm: f.odometerKm, station: f.station, fuelType: f.fuelType,
  kmSinceLast: f.kmSinceLast, kmPerL: f.kmPerL != null ? Number(f.kmPerL) : null, receiptId: f.receiptId, pettyCashLogId: f.pettyCashLogId,
  flagged: f.flagged, anomalies: f.anomalies as unknown as Anomaly[] });

/**
 * Fleet: vehicle profiles (plate, Istimara, insurance, Fahas), driver
 * assignment, preventive maintenance plans (km and/or day intervals, fed into
 * the 60/30/15 reminder sweep), odometer history, and fuel fill-ups paid from
 * the driver's petty-cash float with anomaly checks.
 */
@Controller()
export class FleetController {
  constructor(private readonly db: PrismaService) {}

  @Get('vehicles')
  list(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => ({ data: (await tx.vehicle.findMany({ where: { deletedAt: null }, orderBy: { plateNumber: 'asc' } })).map(vehicleDto) }));
  }

  @Post('vehicles')
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(VehicleBody)) b: z.infer<typeof VehicleBody>) {
    return this.db.withRls(ctx, async (tx) => {
      const v = await tx.vehicle.create({ data: { ...b, householdId: ctx.householdId!, registrationExpiry: d(b.registrationExpiry), insuranceExpiry: d(b.insuranceExpiry),
        inspectionExpiry: d(b.inspectionExpiry), lastInspectionAt: d(b.lastInspectionAt) } });
      if (b.odometerKm > 0) await tx.odometerReading.create({ data: { householdId: ctx.householdId!, vehicleId: v.id, readingKm: b.odometerKm, source: 'MANUAL', recordedById: ctx.membershipId!, note: 'initial' } });
      return vehicleDto(v);
    });
  }

  @Get('vehicles/:id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const v = await this.vehicle(tx, id);
      const [plans, drivers, lastFuel] = await Promise.all([
        tx.maintenancePlan.findMany({ where: { vehicleId: id }, orderBy: { type: 'asc' } }),
        tx.vehicleAssignment.findMany({ where: { vehicleId: id, OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] } }),
        tx.fuelLog.findMany({ where: { vehicleId: id }, orderBy: { filledAt: 'desc' }, take: 5 }),
      ]);
      return { ...vehicleDto(v), drivers: drivers.map((a) => ({ assignmentId: a.id, driverId: a.driverId, isPrimary: a.isPrimary, since: a.startsAt })),
        maintenance: plans.map((p) => planDto(p, v.odometerKm, ctx.locale)), recentFuel: lastFuel.map(fuelDto) };
    });
  }

  @Patch('vehicles/:id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(VehicleUpdate)) b: z.infer<typeof VehicleUpdate>) {
    return this.db.withRls(ctx, async (tx) => {
      const v = await this.vehicle(tx, id);
      const { registrationExpiry, insuranceExpiry, inspectionExpiry, lastInspectionAt, ...rest } = b;
      const { count } = await tx.vehicle.updateMany({ where: { id }, data: { ...rest,
        ...(registrationExpiry ? { registrationExpiry: d(registrationExpiry) } : {}), ...(insuranceExpiry ? { insuranceExpiry: d(insuranceExpiry) } : {}),
        ...(inspectionExpiry ? { inspectionExpiry: d(inspectionExpiry) } : {}), ...(lastInspectionAt ? { lastInspectionAt: d(lastInspectionAt) } : {}) } });
      await assertWritten(count, async () => v, 'vehicle');
      return vehicleDto(await this.vehicle(tx, id));
    });
  }

  @Post('vehicles/:id/assignments')
  assign(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Assign)) b: z.infer<typeof Assign>) {
    return this.db.withRls(ctx, async (tx) => {
      const v = await this.vehicle(tx, id);
      const startsAt = b.startsAt ? new Date(b.startsAt) : new Date();
      if (b.isPrimary) await tx.vehicleAssignment.updateMany({ where: { vehicleId: id, isPrimary: true, endsAt: null }, data: { endsAt: startsAt, endOdometer: v.odometerKm } });
      const a = await tx.vehicleAssignment.create({ data: { householdId: ctx.householdId!, vehicleId: id, driverId: b.driverId, isPrimary: b.isPrimary, startsAt, startOdometer: v.odometerKm } });
      return { assignmentId: a.id, vehicleId: id, driverId: a.driverId, isPrimary: a.isPrimary, since: a.startsAt, startOdometer: a.startOdometer };
    });
  }

  @Get('vehicles/:id/maintenance-plans')
  plans(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const v = await this.vehicle(tx, id);
      return { data: (await tx.maintenancePlan.findMany({ where: { vehicleId: id }, orderBy: { type: 'asc' } })).map((p) => planDto(p, v.odometerKm, ctx.locale)) };
    });
  }

  @Post('vehicles/:id/maintenance-plans')
  addPlan(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Plan)) b: z.infer<typeof Plan>) {
    return this.db.withRls(ctx, async (tx) => {
      const v = await this.vehicle(tx, id);
      const p = await tx.maintenancePlan.create({ data: { householdId: ctx.householdId!, vehicleId: id, type: b.type, intervalKm: b.intervalKm, intervalDays: b.intervalDays,
        lastDoneAt: d(b.lastDoneAt), lastDoneKm: b.lastDoneKm, titleI18n: b.title ? { [ctx.locale]: b.title } : {} } });
      return planDto(p, v.odometerKm, ctx.locale);
    });
  }

  @Patch('maintenance-plans/:id')
  updatePlan(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(PlanUpdate)) b: z.infer<typeof PlanUpdate>) {
    return this.db.withRls(ctx, async (tx) => {
      const p = await tx.maintenancePlan.findFirst({ where: { id } });
      if (!p) throw new NotFoundException('maintenance plan not found');
      const { title, ...rest } = b;
      const { count } = await tx.maintenancePlan.updateMany({ where: { id }, data: { ...rest, ...(title ? { titleI18n: { [ctx.locale]: title } } : {}) } });
      await assertWritten(count, async () => p, 'maintenance plan');
      const v = await this.vehicle(tx, p.vehicleId);
      return planDto((await tx.maintenancePlan.findFirst({ where: { id } }))!, v.odometerKm, ctx.locale);
    });
  }

  /** Record a service (oil change, tyre rotation, Fahas, repair). A COMPLETED service linked to a plan resets it. */
  @Post('vehicles/:id/maintenance')
  service(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Service)) b: z.infer<typeof Service>) {
    return this.db.withRls(ctx, async (tx) => {
      await this.vehicle(tx, id);
      const planId = b.planId ?? (b.status === 'COMPLETED' ? (await tx.maintenancePlan.findFirst({ where: { vehicleId: id, type: b.type, isActive: true } }))?.id : undefined);
      const r = await tx.maintenanceRecord.create({ data: { householdId: ctx.householdId!, vehicleId: id, type: b.type, status: b.status, planId,
        scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : undefined, completedAt: b.completedAt ? new Date(b.completedAt) : undefined,
        odometerKm: b.odometerKm, workshop: b.workshop, cost: b.cost, notes: b.notes } });
      const v = await this.vehicle(tx, id);
      const plan = r.planId ? await tx.maintenancePlan.findFirst({ where: { id: r.planId } }) : null;
      return { id: r.id, vehicleId: id, type: r.type, status: r.status, completedAt: r.completedAt, odometerKm: r.odometerKm, cost: money(r.cost),
        nextDueKm: r.nextDueKm, nextDueDate: r.nextDueDate ? isoDate(r.nextDueDate) : null, plan: plan ? planDto(plan, v.odometerKm, ctx.locale) : null };
    });
  }

  @Get('vehicles/:id/odometer')
  readings(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      await this.vehicle(tx, id);
      return { data: (await tx.odometerReading.findMany({ where: { vehicleId: id }, orderBy: { readAt: 'desc' }, take: 200 }))
        .map((r) => ({ id: r.id, readingKm: r.readingKm, readAt: r.readAt, source: r.source, recordedById: r.recordedById, note: r.note })) };
    });
  }

  @Post('vehicles/:id/odometer')
  addReading(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Odometer)) b: z.infer<typeof Odometer>) {
    return this.db.withRls(ctx, async (tx) => {
      await this.vehicle(tx, id);
      const r = await tx.odometerReading.create({ data: { householdId: ctx.householdId!, vehicleId: id, readingKm: b.readingKm,
        readAt: b.readAt ? new Date(b.readAt) : undefined, source: 'MANUAL', recordedById: ctx.membershipId!, note: b.note } });
      return { id: r.id, readingKm: r.readingKm, readAt: r.readAt, vehicle: vehicleDto(await this.vehicle(tx, id)) };
    });
  }

  @Get('vehicles/:id/fuel')
  fuel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodQuery(FuelQuery)) q: z.infer<typeof FuelQuery>) {
    return this.db.withRls(ctx, async (tx) => {
      await this.vehicle(tx, id);
      const rows = await tx.fuelLog.findMany({ where: { vehicleId: id, ...(q.flagged ? { flagged: q.flagged === 'true' } : {}) }, orderBy: { filledAt: 'desc' }, take: 200 });
      const eff = rows.map((r) => (r.kmPerL != null ? Number(r.kmPerL) : null)).filter((x): x is number => x != null);
      return { data: rows.map(fuelDto), summary: { fills: rows.length, liters: rows.reduce((s, r) => s + Number(r.liters), 0),
        cost: rows.reduce((s, r) => s + Number(r.totalCost), 0).toFixed(2), avgKmPerL: eff.length ? Math.round((eff.reduce((a, b) => a + b, 0) / eff.length) * 100) / 100 : null,
        flagged: rows.filter((r) => r.flagged).length } };
    });
  }

  /**
   * Driver logs a fill-up: odometer reading + fuel log (+ petty-cash expense when paid
   * from their float), one transaction. Anomalies flag the entry for review.
   */
  @Post('vehicles/:id/fuel')
  addFuel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Fuel)) b: z.infer<typeof Fuel>) {
    return this.db.withRls(ctx, async (tx) => {
      const v = await this.vehicle(tx, id);
      const filledAt = b.filledAt ? new Date(b.filledAt) : new Date();
      const pricePerLiter = b.pricePerLiter ?? Math.round((b.totalCost / b.liters) * 1000) / 1000;
      const receipt = b.receiptId ? await tx.receipt.findFirst({ where: { id: b.receiptId } }) : null;
      if (b.receiptId && !receipt) throw new NotFoundException('receipt not found');
      const receiptTotal = (receipt?.extracted as { total?: string } | null)?.total;
      const previous = await tx.fuelLog.findFirst({ where: { vehicleId: id, filledAt: { lt: filledAt } }, orderBy: { filledAt: 'desc' } });
      const history = (await tx.fuelLog.findMany({ where: { vehicleId: id, kmPerL: { not: null }, filledAt: { lt: filledAt } }, orderBy: { filledAt: 'desc' }, take: 5 }))
        .map((f) => Number(f.kmPerL));
      const check = checkFuel({ liters: b.liters, pricePerLiter, totalCost: b.totalCost, fuelType: b.fuelType, filledAt, odometerKm: b.odometerKm,
        vehicle: { fuelType: v.fuelType as FuelType, tankCapacityL: v.tankCapacityL ? Number(v.tankCapacityL) : null, expectedKmPerL: v.expectedKmPerL ? Number(v.expectedKmPerL) : null },
        previous: previous ? { filledAt: previous.filledAt, odometerKm: previous.odometerKm } : null, history, receiptTotal: receiptTotal ? Number(receiptTotal) : null });

      await tx.odometerReading.create({ data: { householdId: ctx.householdId!, vehicleId: id, readingKm: b.odometerKm, readAt: filledAt, source: 'FUEL', recordedById: ctx.membershipId! } });
      let petty = null;
      if (b.pettyCashAccountId) {
        if (!(await tx.pettyCashAccount.findFirst({ where: { id: b.pettyCashAccountId } }))) throw new NotFoundException('petty cash float not found');
        const text = `Fuel ${b.liters} L @ ${pricePerLiter.toFixed(2)} SAR/L, ${b.odometerKm} km${check.anomalies.length ? ` (flagged: ${check.anomalies.map((a) => a.code).join(', ')})` : ''}`;
        petty = await tx.pettyCashLog.create({ data: { householdId: ctx.householdId!, accountId: b.pettyCashAccountId, type: 'EXPENSE', amount: b.totalCost,
          descriptionI18n: { en: text }, originalLocale: 'en', merchantName: b.station, receiptId: b.receiptId, vehicleId: id, occurredAt: filledAt, recordedById: ctx.membershipId! } });
      }
      const f = await tx.fuelLog.create({ data: { householdId: ctx.householdId!, vehicleId: id, filledAt, liters: b.liters, pricePerLiter, totalCost: b.totalCost,
        odometerKm: b.odometerKm, station: b.station, fuelType: b.fuelType ?? v.fuelType, receiptId: petty ? undefined : b.receiptId, pettyCashLogId: petty?.id,
        anomalies: check.anomalies as unknown as Prisma.InputJsonValue, flagged: check.anomalies.some((a) => a.severity !== 'low') } });
      return { fuel: { ...fuelDto(f), receiptId: b.receiptId ?? null }, baselineKmPerL: check.baselineKmPerL,
        pettyCash: petty ? { id: petty.id, status: petty.status, amount: money(petty.amount) } : null, vehicle: vehicleDto(await this.vehicle(tx, id)) };
    });
  }

  /** Fleet manager's view: documents and services due, flagged fuel. */
  @Get('fleet/overview')
  overview(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      const vehicles = await tx.vehicle.findMany({ where: { deletedAt: null, status: { notIn: ['SOLD'] } }, include: { plans: { where: { isActive: true } } } });
      const t = today();
      const documents = vehicles.flatMap((v) => ([['REGISTRATION', v.registrationExpiry], ['INSURANCE', v.insuranceExpiry], ['INSPECTION', v.inspectionExpiry]] as const)
        .filter(([, e]) => e && (daysUntil(e, t) ?? 99) <= 60).map(([doc, e]) => ({ vehicleId: v.id, plateNumber: v.plateNumber, doc, expiry: isoDate(e!), daysLeft: daysUntil(e, t) })))
        .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
      const maintenance = vehicles.flatMap((v) => v.plans.map((p) => ({ plateNumber: v.plateNumber, ...planDto(p, v.odometerKm, ctx.locale) })))
        .filter((p) => p.status !== 'OK');
      const flaggedFuel = (await tx.fuelLog.findMany({ where: { flagged: true, filledAt: { gte: new Date(Date.now() - 90 * 86_400_000) } }, orderBy: { filledAt: 'desc' }, take: 50 })).map(fuelDto);
      return { vehicles: vehicles.length, documents, maintenance, flaggedFuel };
    });
  }

  private async vehicle(tx: Tx, id: string) {
    const v = await tx.vehicle.findFirst({ where: { id, deletedAt: null } });
    if (!v) throw new NotFoundException('vehicle not found');
    return v;
  }
}
