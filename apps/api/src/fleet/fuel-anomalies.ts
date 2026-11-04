/**
 * Soft checks on a fuel fill-up. Hard rules (cost = litres × price, odometer
 * never backwards) are enforced by the database; these flags send the
 * petty-cash entry to a human with a reason instead of rejecting it.
 */
export type FuelType = 'PETROL_91' | 'PETROL_95' | 'DIESEL' | 'HYBRID' | 'ELECTRIC';
export interface Anomaly { code: string; severity: 'high' | 'medium' | 'low'; message: string }

/**
 * Reference pump prices in SAR/L (Saudi Aramco's regulated prices; reviewed
 * periodically). Only a ±25 % deviation is flagged, so a price revision does
 * not trip the check. Override with FUEL_PRICES_SAR (JSON) when prices change.
 */
export const REFERENCE_PRICES: Partial<Record<FuelType, number>> = { PETROL_91: 2.18, PETROL_95: 2.33, DIESEL: 1.66 };

export interface FuelCheckInput {
  liters: number; pricePerLiter: number; totalCost: number; fuelType?: FuelType;
  filledAt: Date; odometerKm: number;
  vehicle: { fuelType: FuelType; tankCapacityL?: number | null; expectedKmPerL?: number | null };
  previous?: { filledAt: Date; odometerKm: number } | null;
  /** km/L of earlier full-to-full fills of this vehicle (most recent first). */
  history: number[];
  receiptTotal?: number | null;
  prices?: Partial<Record<FuelType, number>>;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export function checkFuel(i: FuelCheckInput): { anomalies: Anomaly[]; kmSinceLast: number | null; kmPerL: number | null; baselineKmPerL: number | null } {
  const out: Anomaly[] = [];
  const tank = i.vehicle.tankCapacityL ?? null;
  const fuel = i.fuelType ?? i.vehicle.fuelType;

  if (i.vehicle.fuelType === 'ELECTRIC') out.push({ code: 'FUEL_ON_ELECTRIC', severity: 'high', message: 'fuel logged for an electric vehicle' });
  else if (i.fuelType && i.fuelType !== i.vehicle.fuelType && !(i.vehicle.fuelType === 'HYBRID' && i.fuelType.startsWith('PETROL'))
           && !(i.vehicle.fuelType === 'PETROL_91' && i.fuelType === 'PETROL_95')) {
    out.push({ code: 'FUEL_TYPE_MISMATCH', severity: 'medium', message: `${i.fuelType} filled into a ${i.vehicle.fuelType} vehicle` });
  }
  if (tank && i.liters > tank * 1.05) out.push({ code: 'OVER_TANK', severity: 'high', message: `${i.liters} L exceeds the ${tank} L tank` });

  const ref = (i.prices ?? REFERENCE_PRICES)[fuel === 'HYBRID' ? 'PETROL_91' : fuel];
  if (ref && Math.abs(i.pricePerLiter - ref) / ref > 0.25) {
    out.push({ code: 'PRICE_OUT_OF_RANGE', severity: 'low', message: `${i.pricePerLiter.toFixed(2)} SAR/L is far from the ${ref.toFixed(2)} SAR/L pump price` });
  }
  if (i.receiptTotal != null && Math.abs(i.receiptTotal - i.totalCost) > 1) {
    out.push({ code: 'RECEIPT_MISMATCH', severity: 'high', message: `entered ${i.totalCost.toFixed(2)} SAR but the receipt says ${i.receiptTotal.toFixed(2)} SAR` });
  }

  let kmSinceLast: number | null = null, kmPerL: number | null = null;
  const baseline = i.vehicle.expectedKmPerL ?? (i.history.length >= 3 ? median(i.history.slice(0, 5)) : null);
  if (i.previous) {
    kmSinceLast = i.odometerKm - i.previous.odometerKm;
    const hours = (i.filledAt.getTime() - i.previous.filledAt.getTime()) / 3_600_000;
    if (kmSinceLast < 50 && (hours < 6 || (tank && i.liters > tank * 0.2))) {
      out.push({ code: 'REFILL_TOO_SOON', severity: 'medium', message: `${i.liters} L only ${kmSinceLast} km${hours < 6 ? ` / ${hours.toFixed(1)} h` : ''} after the previous fill` });
    }
    if (kmSinceLast > 0) {
      kmPerL = Math.round((kmSinceLast / i.liters) * 100) / 100;
      if (baseline && kmSinceLast >= 50) {
        if (kmPerL < baseline * 0.6) out.push({ code: 'EFFICIENCY_LOW', severity: 'high',
          message: `${kmPerL} km/L against a usual ${baseline.toFixed(1)} km/L: more fuel than the distance explains` });
        else if (kmPerL > baseline * 1.6) out.push({ code: 'EFFICIENCY_HIGH', severity: 'medium',
          message: `${kmPerL} km/L against a usual ${baseline.toFixed(1)} km/L: a missed fill-up or a wrong odometer reading` });
      }
      if (tank && baseline && kmSinceLast > tank * baseline * 1.3) {
        out.push({ code: 'ODOMETER_JUMP', severity: 'medium', message: `${kmSinceLast} km since the last fill is more than a full tank's range` });
      }
    }
  }
  return { anomalies: out, kmSinceLast, kmPerL, baselineKmPerL: baseline };
}
