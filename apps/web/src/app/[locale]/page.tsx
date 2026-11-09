import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@herp/i18n';
import { Link } from '@/i18n/navigation';
import { Shell } from '@/components/Shell';
import { SaudiPlate } from '@/components/SaudiPlate';
import { decideRequest } from '@/lib/actions';
import { fmt } from '@/lib/fmt';
import { loadHome, type Decision, type Upcoming } from '@/lib/home';
import { label, loose, today } from '@/lib/sections';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const TONE: Record<Upcoming['tone'], string> = { critical: 'bg-critical', warning: 'bg-warning', task: 'bg-primary' };
const TEXT: Record<Upcoming['tone'], string> = { critical: 'text-critical', warning: 'text-warning', task: 'text-muted-foreground' };

/** Home: what needs a decision, the next 30 days, the vehicles, and the household's state at a glance. */
export default async function Home({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t0, tl0, tp0, f, h] = await Promise.all([getTranslations('ui'), getTranslations('lux'), getTranslations('pulse'), fmt(), loadHome(locale)]);
  const t = loose(t0), tl = loose(tl0), tp = loose(tp0);
  const s = h.session;
  const now = today();
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Riyadh' }).format(new Date()));
  const urgent = h.decisions.filter((d) => d.kind !== 'request').length;
  const approvals = h.decisions.filter((d) => d.kind === 'request').length;
  const plus = (n: number) => { const d = new Date(`${now}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const when = (u: Upcoming) => (u.km != null ? t('home.inKm', { km: u.km }) : u.days === 0 ? t('home.todayLabel') : u.days === 1 ? t('home.tomorrow') : t('home.inDays', { count: u.days }));
  const what = (u: Upcoming) =>
    u.kind === 'task' ? (u.who ? t('home.taskWho', { title: u.label, name: u.who }) : u.label)
    : u.kind === 'staffDoc' ? t('home.staffDoc', { doc: label(t0, 'doc', u.doc), name: u.label })
    : u.kind === 'vehicleDoc' ? t('home.vehicleDoc', { doc: tl(`fleet.doc.${u.doc}`), name: u.label })
    : t('home.service', { item: label(t0, 'maintenance', u.doc), name: u.label });
  const decisionRow = (d: Decision, i: number) => {
    const last = i === h.decisions.length - 1;
    const row = cn('flex flex-wrap items-center gap-4 px-5 py-4 sm:px-6', !last && 'border-b border-hairline');
    if (d.kind === 'unpaid') return (
      <div key="unpaid" className={row}>
        <span className="dot bg-critical" aria-hidden="true" />
        <div className="min-w-0 flex-[1_1_320px]">
          <div className="font-semibold">{t('home.unpaidTitle', { month: f.monthName(d.period), count: d.names.length })}</div>
          <div className="text-xs text-muted-foreground">{t('home.unpaidDetail', { names: d.names.join('، '), paid: d.paid, total: d.total })}</div>
        </div>
        <Link href="/staff?tab=pay" className="btn btn-primary">{t('home.reviewPay')}</Link>
      </div>
    );
    if (d.kind === 'medical') return (
      <div key={`m-${d.staffId}`} className={row}>
        <span className="dot bg-critical" aria-hidden="true" />
        <div className="min-w-0 flex-[1_1_320px]">
          <div className="font-semibold">{t('home.medicalTitle', { name: d.name })}</div>
          <div className="text-xs text-muted-foreground">{[label(tl0, 'staffType', d.staffType), label(tl0, 'status', d.status), d.since ? t('home.since', { date: f.dayMonth(d.since) }) : null].filter(Boolean).join(' · ')}</div>
        </div>
        <Link href={`/staff/${d.staffId}`} className="btn">{t('home.openFile')}</Link>
      </div>
    );
    const detail = [d.from && d.to ? t('home.dates', { from: f.dayMonth(d.from), to: f.dayMonth(d.to) }) : null, d.leaveType ? label(t0, 'leaveType', d.leaveType) : null,
      d.installments ? t('home.installments', { count: d.installments }) : null, d.reason ? t('home.reason', { reason: d.reason }) : null,
      t('home.requested', { date: f.dayMonth(d.createdAt) })].filter(Boolean).join(' · ');
    return (
      <div key={d.id} className={row}>
        <span className="dot bg-brass" aria-hidden="true" />
        <div className="min-w-0 flex-[1_1_320px]">
          <Link href={`/requests/${d.id}`} className="font-semibold hover:underline">
            {d.amount ? t('home.requestAmount', { type: label(t0, 'requestType', d.type), amount: f.money(d.amount, d.currency), name: d.name }) : t('home.request', { type: label(t0, 'requestType', d.type), name: d.name })}
          </Link>
          <div className="text-xs text-muted-foreground">{detail}</div>
        </div>
        {s.mode === 'live' && (
          <form action={decideRequest} className="flex gap-2">
            <input type="hidden" name="id" value={d.id} /><input type="hidden" name="locale" value={locale} />
            <button type="submit" name="decision" value="approve" className="btn btn-primary">{t('requests.approve')}</button>
            <button type="submit" name="decision" value="reject" className="btn">{t('requests.reject')}</button>
          </form>
        )}
      </div>
    );
  };
  const w = h.workforce;

  return (
    <Shell current="brief" households={s.households} household={s.current} mode={s.mode} back={`/${locale}`} pendingRequests={s.pendingRequests}>
      <div className="mx-auto flex max-w-[1280px] flex-col gap-6 px-4 py-7 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <h1 className="text-3xl">{t(hour < 12 ? 'home.morning' : 'home.evening')}</h1>
            <p className="text-muted-foreground">{t('home.summary', { decisions: h.decisions.length, upcoming: h.upcoming.length })}</p>
          </div>
          <dl className="panel flex items-stretch">
            {([['home.stripUrgent', urgent, urgent ? 'text-critical' : ''], ['home.stripApprovals', approvals, ''], ['home.stripUpcoming', h.upcoming.length, h.upcoming.length ? 'text-warning' : '']] as const).map(([k, n, c], i) => (
              <div key={k} className={cn('px-5 py-2.5', i > 0 && 'border-s border-border')}>
                <dt className="text-xs text-muted-foreground">{t(k)}</dt>
                <dd className={cn('text-xl font-bold tabular', c)}>{f.num(n)}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex flex-wrap items-start gap-6">
          <div className="flex min-w-0 flex-[999_1_620px] flex-col gap-6">
            <section aria-labelledby="h-decide" className="panel">
              <div className="flex items-center justify-between border-b border-hairline px-5 py-4 sm:px-6">
                <h2 id="h-decide" className="text-xl">{t('home.decideTitle')}</h2>
                <span className="text-xs text-muted-foreground">{t('home.byImportance')}</span>
              </div>
              {h.decisions.length ? h.decisions.map(decisionRow) : <p className="px-6 py-5 text-muted-foreground">{t('home.nothing')}</p>}
              {h.info.length > 0 && (
                <div className="rounded-b-lg border-t border-hairline bg-muted px-5 py-3 text-xs text-muted-foreground sm:px-6">
                  {t('home.info')}{' '}
                  {h.info.map((a, i) => (
                    <span key={a.key}>{i > 0 && ' · '}{a.section ? <Link href={`/${a.section}`} className="link">{tp(a.key, { count: a.count })}</Link> : tp(a.key, { count: a.count })}</span>
                  ))}
                </div>
              )}
            </section>

            <section aria-labelledby="h-soon" className="panel px-5 pb-4 pt-4 sm:px-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 id="h-soon" className="text-xl">{t('home.upcomingTitle')}</h2>
                <span className="text-xs text-muted-foreground">{t('home.dates', { from: f.dayMonth(now), to: f.dayMonth(plus(30)) })}</span>
              </div>
              {h.upcoming.length > 0 && (
                <div className="relative mx-3 h-14" aria-hidden="true">
                  <div className="absolute inset-x-0 top-[22px] h-1 rounded bg-track" />
                  <div className="absolute start-0 top-3.5 h-5 w-0.5 bg-foreground" />
                  <div className="absolute start-0 top-[38px] text-xs font-semibold">{t('home.todayLabel')}</div>
                  {[7, 14, 21].map((n) => (
                    <div key={n} className="absolute top-[38px] -translate-x-1/2 text-xs text-muted-foreground rtl:translate-x-1/2" style={{ insetInlineStart: `${(n / 30) * 100}%` }}>{f.dayMonth(plus(n))}</div>
                  ))}
                  <div className="absolute end-0 top-[38px] text-xs text-muted-foreground">{f.dayMonth(plus(30))}</div>
                  {h.upcoming.map((u, i) => (
                    <span key={i} className={cn('absolute top-[13px] grid size-[22px] place-items-center rounded-full text-xs font-bold text-white tabular', TONE[u.tone])}
                      style={{ insetInlineStart: `calc(${(u.days / 30) * 100}% - 11px + ${(h.upcoming.slice(0, i).filter((x) => x.days === u.days).length) * 14}px)` }}>{f.num(i + 1)}</span>
                  ))}
                </div>
              )}
              {h.upcoming.length + h.offAxis.length === 0 ? <p className="text-muted-foreground">{t('home.nothingUpcoming')}</p> : (
                <ol className="mt-3 grid list-none gap-x-7 sm:grid-cols-2">
                  {[...h.upcoming, ...h.offAxis].map((u, i) => (
                    <li key={i} className="flex items-baseline gap-2.5 border-t border-hairline py-2">
                      <b className={cn('w-5 shrink-0 tabular', u.km != null ? 'text-muted-foreground' : TEXT[u.tone] === 'text-muted-foreground' ? 'text-primary' : TEXT[u.tone])}>{u.km != null ? '◦' : f.num(i + 1)}</b>
                      <Link href={u.href} className="min-w-0 flex-1 hover:underline">{what(u)}{u.km != null && <span className="text-muted-foreground"> · {t('home.byOdometer')}</span>}</Link>
                      <span className={cn('shrink-0 text-xs tabular', u.km != null ? 'text-warning' : TEXT[u.tone])}>{when(u)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {h.cars.length > 0 && (
              <section aria-label={t('nav.fleet')} className="grid gap-6 md:grid-cols-2">
                {h.cars.map((c) => (
                  <Link key={c.id} href={`/fleet/${c.id}`} className="panel flex flex-col gap-3 px-5 py-4 hover:border-input">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-lg font-bold">{c.name}</div>
                        <div className="text-xs text-muted-foreground">{[String(c.year), c.driver ?? t('home.noDriver'), t('fleet.km', { km: c.km })].join(' · ')}</div>
                      </div>
                      <SaudiPlate latin={c.plate} arabic={c.plateAr} />
                    </div>
                    <div className="grid grid-cols-[6rem_minmax(0,1fr)_4.5rem] items-center gap-x-2.5 gap-y-1.5 text-xs">
                      {c.docs.map((d) => (
                        <div key={d.doc} className="contents">
                          <span className="text-muted-foreground">{tl(`fleet.doc.${d.doc}`)}</span>
                          <span className="bar"><span className={d.days != null && d.days <= 30 ? 'bg-warning' : 'bg-primary'} style={{ width: `${Math.max(3, Math.min(100, ((d.days ?? 0) / 365) * 100))}%` }} /></span>
                          <span className={cn('tabular', d.days != null && d.days <= 30 && 'font-semibold text-warning')}>{d.days == null ? '—' : t('daysCount', { count: d.days })}</span>
                        </div>
                      ))}
                    </div>
                  </Link>
                ))}
              </section>
            )}
          </div>

          <aside aria-label={t('home.stateOf')} className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
            <section className="panel flex flex-col gap-3.5 px-5 py-4">
              <h2 className="text-xl">{t('home.workforce')}</h2>
              <div className="flex items-baseline gap-2"><span className="text-2xl font-bold tabular">{f.num(w.total)}</span><span className="text-muted-foreground">{t('home.workersWord', { count: w.total })}</span></div>
              {w.total > 0 && (
                <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
                  <span className="bg-primary" style={{ flex: w.active }} /><span className="bg-brass" style={{ flex: w.probation }} /><span className="bg-input" style={{ flex: w.onLeave }} />
                </div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {([['ACTIVE', w.active, 'bg-primary'], ['ON_PROBATION', w.probation, 'bg-brass'], ['ON_LEAVE', w.onLeave, 'bg-input']] as const).map(([k, n, c]) => (
                  <span key={k} className="flex items-center gap-1.5"><span className={cn('size-2 rounded-sm', c)} />{f.num(n)} {label(tl0, 'status', k)}</span>
                ))}
              </div>
              <dl className="grid grid-cols-[1fr_auto] gap-y-2 border-t border-hairline pt-3">
                <dt className="text-muted-foreground">{t('home.medicalValid')}</dt><dd className={cn('tabular', w.medicalValid < w.total && 'font-semibold text-critical')}>{t('home.ofTotal', { count: w.medicalValid, total: w.total })}</dd>
                {h.decisions.find((d) => d.kind === 'unpaid') && (() => { const u = h.decisions.find((d) => d.kind === 'unpaid') as Extract<Decision, { kind: 'unpaid' }>; return (<>
                  <dt className="text-muted-foreground">{t('home.paidLastMonth', { month: f.monthName(u.period) })}</dt><dd className="font-semibold text-critical tabular">{t('home.ofTotal', { count: u.paid, total: u.total })}</dd></>); })()}
                <dt className="text-muted-foreground">{t('home.docsDue')}</dt><dd className="tabular">{f.num(w.docsDue)}</dd>
              </dl>
            </section>

            <section className="panel flex flex-col gap-3.5 px-5 py-4">
              <h2 className="text-xl">{t('home.money')}</h2>
              {h.money.account ? (
                <div>
                  <div className="text-xs text-muted-foreground">{h.money.account.name}</div>
                  <div className="text-2xl font-bold tabular">{f.money(h.money.account.balance)}</div>
                  <div className="text-xs text-muted-foreground">{t('home.weekSpend', { amount: f.money(h.money.week.amount), count: h.money.week.count })}</div>
                </div>
              ) : <p className="text-muted-foreground">{t('home.noAccount')}</p>}
              {h.money.float && (
                <div className="border-t border-hairline pt-3">
                  <div className="flex justify-between gap-3"><span className="text-muted-foreground">{t('home.floatLabel', { name: h.money.float.holder })}</span>
                    <span className="tabular">{t('home.ofTotalMoney', { amount: f.num(h.money.float.balance), total: f.num(h.money.float.limit) })}</span></div>
                  <span className="bar mt-1.5"><span className="bg-primary" style={{ width: `${Math.min(100, (Number(h.money.float.balance) / Math.max(1, Number(h.money.float.limit))) * 100)}%` }} /></span>
                </div>
              )}
              <dl className="grid grid-cols-[1fr_auto] gap-y-2 border-t border-hairline pt-3">
                <dt className="text-muted-foreground">{t('home.esbProvision')}</dt><dd className="tabular">{f.money(h.money.esb.provision)}</dd>
                <dt className="text-muted-foreground">{t('home.esbVested')}</dt><dd className="tabular">{f.money(h.money.esb.vested)}</dd>
              </dl>
              {h.team[0] && s.mode === 'live' && <Link href={`/staff/${h.team[0].id}?tab=settlement`} className="link text-sm">{t('home.calculator')}</Link>}
            </section>

            <section className="panel px-5 py-4">
              <h2 className="mb-2 text-xl">{t('home.team')}</h2>
              <ul>
                {h.team.map((m) => (
                  <li key={m.id}>
                    <Link href={s.mode === 'live' ? `/staff/${m.id}` : '/staff'} className="flex items-center gap-3 border-t border-hairline py-2 hover:bg-muted">
                      <span className={cn('grid size-8 shrink-0 place-items-center rounded-full text-xs font-bold',
                        m.alert ? 'bg-critical-soft text-critical' : m.status === 'ON_LEAVE' ? 'bg-muted text-muted-foreground' : 'bg-selected text-primary')}>{Array.from(m.name)[0]}</span>
                      <span className="min-w-0 flex-1 truncate">{m.name} <span className="text-xs text-muted-foreground">· {label(tl0, 'staffType', m.staffType)}</span></span>
                      <span className={cn('shrink-0 text-xs', m.alert ? 'text-critical' : m.status === 'ACTIVE' ? 'text-primary' : 'text-muted-foreground')}>
                        {m.alert ? t('home.noMedicalShort') : label(tl0, 'status', m.status)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </Shell>
  );
}
