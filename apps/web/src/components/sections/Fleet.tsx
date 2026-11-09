import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiGet } from '@/lib/api';
import { fmt } from '@/lib/fmt';
import { label, loose, people, type Rows } from '@/lib/sections';
import { BarRows, Dot, Facts, ListDetail, Panel, RecordHeader, Table, type Tone } from '../ListDetail';
import { SaudiPlate } from '../SaudiPlate';

type Opts = { household: string; locale: string };
type Doc = { expiry: string | null; daysLeft: number | null };
interface Plan { id: string; type: string; intervalKm: number | null; intervalDays: number | null; nextDueDate: string | null; nextDueKm: number | null; daysLeft: number | null; kmLeft: number | null }
interface Vehicle { id: string; make: string; model: string; year: number; plateNumber: string; plateNumberAr: string | null; status: string; odometerKm: number; fuelType: string | null;
  ownership: string | null; registration: Doc & { number?: string | null }; insurance: Doc & { provider?: string | null; policy?: string | null }; inspection: Doc;
  drivers?: Array<{ driverId: string; isPrimary: boolean }>; maintenance?: Plan[] }
interface Reading { id: string; readingKm: number; readAt: string; source: string }
interface Fuel { summary: { fills: number; liters: number; cost: string; avgKmPerL: number | null; flagged: number } }

const daysTone = (d: number | null | undefined): Tone | undefined => (d == null ? undefined : d < 0 ? 'critical' : d <= 30 ? 'warning' : undefined);
const nearest = (v: Vehicle) => Math.min(...[v.registration.daysLeft, v.insurance.daysLeft, v.inspection.daysLeft].filter((x): x is number => x != null));

export async function FleetSection({ opts, id }: { opts: Opts; id: string | null; tab: string | null }) {
  const [t0, tf0, f, names, list] = await Promise.all([getTranslations('ui'), getTranslations('lux.fleet'), fmt(), people(opts), apiGet<Rows<Vehicle>>('/v1/vehicles', opts)]);
  const t = loose(t0), tf = loose(tf0);
  const vehicles = list?.data ?? [];
  const sel0 = id ? vehicles.find((v) => v.id === id) : vehicles[0];
  if (id && !sel0) notFound();
  const full = await Promise.all(vehicles.map((v) => apiGet<Vehicle>(`/v1/vehicles/${v.id}`, opts).then((x) => x ?? v)));
  const docsDue = full.reduce((n, v) => n + [v.registration, v.insurance, v.inspection].filter((d) => d.daysLeft != null && d.daysLeft <= 30).length, 0);
  const serviceDue = full.reduce((n, v) => n + (v.maintenance ?? []).filter((m) => (m.daysLeft != null && m.daysLeft <= 30) || (m.kmLeft != null && m.kmLeft <= 1000)).length, 0);
  const totalKm = full.reduce((n, v) => n + v.odometerKm, 0);
  const items = full.map((v) => {
    const soon = nearest(v);
    return { id: v.id, lead: <Dot tone={daysTone(soon) ?? 'ok'} />, primary: `${v.make} ${v.model}`, secondary: <span dir="ltr">{v.plateNumber}</span>,
      tone: soon <= 30 ? 'warning' as const : undefined, trail: <span className={soon <= 30 ? 'font-semibold text-warning' : 'text-muted-foreground'}>{t('daysCount', { count: soon })}</span> };
  });

  let detail = null;
  const v = sel0 ? full.find((x) => x.id === sel0.id)! : null;
  if (v) {
    const [odo, fuel] = await Promise.all([apiGet<Rows<Reading>>(`/v1/vehicles/${v.id}/odometer`, opts), apiGet<Fuel>(`/v1/vehicles/${v.id}/fuel`, opts)]);
    const docs: Array<[string, Doc, string | null | undefined]> = [
      [tf('doc.REGISTRATION'), v.registration, v.registration.number], [tf('doc.INSURANCE'), v.insurance, [v.insurance.provider, v.insurance.policy].filter(Boolean).join(' · ')],
      [tf('doc.INSPECTION'), v.inspection, null],
    ];
    const plans = v.maintenance ?? [];
    const nextService = [...plans].sort((a, b) => (a.kmLeft ?? 1e9) - (b.kmLeft ?? 1e9))[0];
    detail = (
      <>
        <RecordHeader title={`${v.make} ${v.model}`} meta={`${v.year} · ${label(t0, 'vehicleStatus', v.status)} · ${(v.drivers ?? []).map((d) => names.get(d.driverId) ?? '—').join('، ') || t('home.noDriver')}`}
          actions={<SaudiPlate latin={v.plateNumber} arabic={v.plateNumberAr} />}
          stats={[
            { label: t('fleet.odometer'), value: t('fleet.km', { km: v.odometerKm }) },
            { label: t('sec.nearestDoc'), value: t('daysCount', { count: nearest(v) }), tone: daysTone(nearest(v)) },
            { label: t('sec.nextService'), value: nextService ? (nextService.kmLeft != null ? t('home.inKm', { km: nextService.kmLeft }) : f.date(nextService.nextDueDate)) : '—',
              tone: nextService && nextService.kmLeft != null && nextService.kmLeft <= 1000 ? 'warning' : undefined },
            { label: t('fleet.fuel'), value: fuel ? t('fleet.fuelSummary', { count: fuel.summary.fills, cost: f.money(fuel.summary.cost) }) : '—' },
          ]} />
        <div className="grid gap-6 xl:grid-cols-2">
          <Panel title={t('fleet.documents')}>
            <BarRows rows={docs.map(([n, d, ref]) => ({ label: <span>{n}{ref ? <span className="block text-xs">{ref}</span> : null}</span>, value: d.daysLeft ?? 0, max: 365,
              tone: daysTone(d.daysLeft) ?? 'ok' as Tone, text: d.daysLeft == null ? '—' : <span>{t('daysCount', { count: d.daysLeft })}<span className="block text-xs font-normal text-muted-foreground">{f.date(d.expiry)}</span></span>,
              textTone: daysTone(d.daysLeft) }))} />
          </Panel>
          <Panel title={t('fleet.maintenance')}>
            {plans.length === 0 ? <p className="text-muted-foreground">{t('fleet.noPlans')}</p> : (
              <BarRows rows={plans.map((m) => {
                const used = m.intervalKm && m.kmLeft != null ? m.intervalKm - m.kmLeft : m.intervalDays && m.daysLeft != null ? m.intervalDays - m.daysLeft : 0;
                const max = m.intervalKm && m.kmLeft != null ? m.intervalKm : m.intervalDays ?? 1;
                const warn = (m.kmLeft != null && m.kmLeft <= 1000) || (m.daysLeft != null && m.daysLeft <= 30);
                return { label: label(t0, 'maintenance', m.type), value: used, max, tone: warn ? 'warning' as Tone : 'ok' as Tone, textTone: warn ? 'warning' as Tone : undefined,
                  text: [m.kmLeft != null ? t('fleet.km', { km: m.kmLeft }) : null, m.daysLeft != null ? t('daysCount', { count: m.daysLeft }) : null].filter(Boolean).join(' · ') || '—' };
              })} />
            )}
            {plans.length > 0 && <p className="mt-3 text-xs text-muted-foreground">{t('sec.serviceNote')}</p>}
          </Panel>
          <Panel title={t('fleet.vehicle')}>
            <Facts rows={[
              [t('fleet.drivers'), (v.drivers ?? []).map((d) => `${names.get(d.driverId) ?? '—'}${d.isPrimary ? '' : ` (${t('fleet.secondary')})`}`).join('، ') || '—'],
              [t('fleet.fuelType'), label(t0, 'fuel', v.fuelType)],
              [t('fleet.ownership'), label(t0, 'ownership', v.ownership)],
              fuel?.summary.avgKmPerL ? [t('sec.efficiency'), t('sec.kmPerL', { value: f.num(fuel.summary.avgKmPerL, 1) })] : null,
            ]} />
          </Panel>
          <Panel title={t('fleet.odometer')}>
            <Table head={[t('date'), t('fleet.reading'), t('fleet.source')]} numeric={[1]} empty={t('fleet.noReadings')}
              rows={(odo?.data ?? []).slice(0, 6).map((r) => [f.date(r.readAt), t('fleet.km', { km: r.readingKm }), label(t0, 'readingSource', r.source)])} />
          </Panel>
        </div>
      </>
    );
  }
  return <ListDetail title={t('nav.fleet')} base="/fleet" items={items} selectedId={sel0?.id ?? null} explicit={!!id} detail={detail} empty={t('empty.fleet')}
    summary={t('sec.fleet.summary', { count: vehicles.length, due: docsDue + serviceDue })}
    stats={[
      { label: t('sec.vehicles'), value: f.num(vehicles.length) },
      { label: t('sec.docsDue'), value: f.num(docsDue), tone: docsDue ? 'warning' : undefined },
      { label: t('sec.servicesDue'), value: f.num(serviceDue), tone: serviceDue ? 'warning' : undefined },
      { label: t('sec.totalKm'), value: t('fleet.km', { km: totalKm }) },
    ]} />;
}
