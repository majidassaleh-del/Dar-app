import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiGet } from '@/lib/api';
import { fmt } from '@/lib/fmt';
import { label, people, type Rows } from '@/lib/sections';
import { Block, Facts, ListDetail, RecordHeader, Table } from '../ListDetail';
import { SaudiPlate } from '../SaudiPlate';

type Opts = { household: string; locale: string };
type Doc = { expiry: string | null; daysLeft: number | null };
interface Vehicle { id: string; make: string; model: string; year: number; plateNumber: string; plateNumberAr: string | null; status: string; odometerKm: number; fuelType: string | null;
  ownership: string | null; registration: Doc & { number?: string | null }; insurance: Doc & { provider?: string | null; policy?: string | null }; inspection: Doc;
  drivers?: Array<{ driverId: string; isPrimary: boolean }>; maintenance?: Array<{ id: string; type: string; nextDueDate: string | null; nextDueKm: number | null; daysLeft: number | null; kmLeft: number | null; status?: string }> }
interface Reading { id: string; readingKm: number; readAt: string; source: string }
interface Fuel { summary: { fills: number; liters: number; cost: string; avgKmPerL: number | null; flagged: number } }

const tone = (d: number | null | undefined) => (d == null ? undefined : d < 0 ? 'text-critical' : d <= 30 ? 'text-warning' : undefined);

export async function FleetSection({ opts, id }: { opts: Opts; id: string | null; tab: string | null }) {
  const [t, tf, f, names, list] = await Promise.all([getTranslations('ui'), getTranslations('lux.fleet'), fmt(), people(opts), apiGet<Rows<Vehicle>>('/v1/vehicles', opts)]);
  const vehicles = list?.data ?? [];
  const sel0 = id ? vehicles.find((v) => v.id === id) : vehicles[0];
  if (id && !sel0) notFound();
  const items = vehicles.map((v) => {
    const soon = Math.min(...[v.registration.daysLeft, v.insurance.daysLeft, v.inspection.daysLeft].filter((x): x is number => x != null));
    return { id: v.id, primary: `${v.make} ${v.model} ${v.year}`, secondary: <span dir="ltr">{v.plateNumber}</span>, tone: soon <= 30 ? 'warning' as const : undefined };
  });

  let detail = null;
  if (sel0) {
    const [sel, odo, fuel] = await Promise.all([
      apiGet<Vehicle>(`/v1/vehicles/${sel0.id}`, opts), apiGet<Rows<Reading>>(`/v1/vehicles/${sel0.id}/odometer`, opts), apiGet<Fuel>(`/v1/vehicles/${sel0.id}/fuel`, opts),
    ]);
    const v = sel ?? sel0;
    const docs: Array<[string, Doc, string | null | undefined]> = [
      [tf('doc.REGISTRATION'), v.registration, v.registration.number], [tf('doc.INSURANCE'), v.insurance, [v.insurance.provider, v.insurance.policy].filter(Boolean).join(' · ')],
      [tf('doc.INSPECTION'), v.inspection, null],
    ];
    detail = (
      <>
        <RecordHeader title={`${v.make} ${v.model} ${v.year}`} meta={`${label(t, 'vehicleStatus', v.status)} · ${t('fleet.km', { km: v.odometerKm })}`}
          actions={<SaudiPlate latin={v.plateNumber} arabic={v.plateNumberAr} />} />
        <div className="grid gap-10">
          <Block title={t('fleet.documents')}>
            <Table head={[t('fleet.document'), t('fleet.reference'), t('staff.expires'), t('staff.daysLeft')]} numeric={[3]}
              rows={docs.map(([n, d, ref]) => [n, ref || '—', f.date(d.expiry), <span key="d" className={tone(d.daysLeft)}>{d.daysLeft == null ? '—' : f.num(d.daysLeft)}</span>])} />
          </Block>
          <Block title={t('fleet.maintenance')}>
            <Table head={[t('fleet.service'), t('fleet.nextDate'), t('fleet.nextKm'), t('fleet.remaining')]} empty={t('fleet.noPlans')}
              rows={(v.maintenance ?? []).map((m) => [label(t, 'maintenance', m.type), f.date(m.nextDueDate), m.nextDueKm != null ? t('fleet.km', { km: m.nextDueKm }) : '—',
                <span key="r" className={m.kmLeft != null && m.kmLeft <= 1000 ? 'text-warning' : tone(m.daysLeft)}>
                  {[m.kmLeft != null ? t('fleet.km', { km: m.kmLeft }) : null, m.daysLeft != null ? t('daysCount', { count: m.daysLeft }) : null].filter(Boolean).join(' · ') || '—'}
                </span>])} />
          </Block>
          <div className="grid gap-10 xl:grid-cols-2">
            <Block title={t('fleet.vehicle')}>
              <Facts rows={[
                [t('fleet.drivers'), (v.drivers ?? []).map((d) => `${names.get(d.driverId) ?? '—'}${d.isPrimary ? '' : ` (${t('fleet.secondary')})`}`).join('، ') || '—'],
                [t('fleet.fuelType'), label(t, 'fuel', v.fuelType)],
                [t('fleet.ownership'), label(t, 'ownership', v.ownership)],
                fuel ? [t('fleet.fuel'), t('fleet.fuelSummary', { count: fuel.summary.fills, cost: f.money(fuel.summary.cost) })] : null,
              ]} />
            </Block>
            <Block title={t('fleet.odometer')}>
              <Table head={[t('date'), t('fleet.reading'), t('fleet.source')]} numeric={[1]} empty={t('fleet.noReadings')}
                rows={(odo?.data ?? []).slice(0, 6).map((r) => [f.date(r.readAt), t('fleet.km', { km: r.readingKm }), label(t, 'readingSource', r.source)])} />
            </Block>
          </div>
        </div>
      </>
    );
  }
  return <ListDetail title={t('nav.fleet')} base="/fleet" items={items} selectedId={sel0?.id ?? null} explicit={!!id} detail={detail} empty={t('empty.fleet')} />;
}
