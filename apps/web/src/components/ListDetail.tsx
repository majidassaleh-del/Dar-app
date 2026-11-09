import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

export type Tone = 'critical' | 'warning' | 'ok' | 'brass' | 'muted';
const TEXT: Record<Tone, string> = { critical: 'text-critical', warning: 'text-warning', ok: 'text-primary', brass: 'text-brass-ink', muted: 'text-muted-foreground' };
const FILL: Record<Tone, string> = { critical: 'bg-critical', warning: 'bg-warning', ok: 'bg-primary', brass: 'bg-brass', muted: 'bg-input' };

export interface ListItem { id: string; primary: ReactNode; secondary?: ReactNode; tone?: 'critical' | 'warning'; lead?: ReactNode; trail?: ReactNode }
export interface Stat { label: string; value: ReactNode; tone?: Tone }

/** Section heading, as on the home page: the title, one summary line, and a strip of figures at the end. */
export function PageHead({ title, summary, stats }: { title: string; summary?: ReactNode; stats?: Stat[] }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-5">
      <div className="min-w-0">
        <h1 className="text-3xl">{title}</h1>
        {summary && <p className="text-muted-foreground">{summary}</p>}
      </div>
      {stats && stats.length > 0 && <StatStrip stats={stats} />}
    </div>
  );
}

export function StatStrip({ stats, className }: { stats: Stat[]; className?: string }) {
  return (
    <dl className={cn('panel flex flex-wrap items-stretch', className)}>
      {stats.map((s, i) => (
        <div key={i} className={cn('px-5 py-2.5', i > 0 && 'border-s border-border')}>
          <dt className="text-xs text-muted-foreground">{s.label}</dt>
          <dd className={cn('text-xl font-bold tabular', s.tone && TEXT[s.tone])}>{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A section page: heading and figures across the top, then the list on one side and the selected
 * record beside it (like a mail client). On a phone only one shows, with a way back.
 */
export async function ListDetail({ title, summary, stats, base, items, selectedId, explicit, detail, empty }:
  { title: string; summary?: ReactNode; stats?: Stat[]; base: string; items: ListItem[]; selectedId: string | null; explicit: boolean; detail: ReactNode; empty: string }) {
  const t = await getTranslations('ui');
  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6 px-4 py-7 sm:px-8">
      <div className={cn(explicit && 'hidden lg:block')}><PageHead title={title} summary={summary} stats={stats} /></div>
      <div className="flex items-start gap-6">
        <section aria-label={title} className={cn('panel w-full overflow-hidden lg:sticky lg:top-4 lg:w-80 lg:shrink-0', explicit && 'hidden lg:block')}>
          <header className="flex items-baseline justify-between gap-3 border-b border-hairline px-5 py-3.5">
            <h2 className="text-lg">{title}</h2>
            <span className="text-xs text-muted-foreground tabular">{items.length}</span>
          </header>
          {items.length === 0 ? <p className="px-5 py-4 text-muted-foreground">{empty}</p> : (
            <ul>
              {items.map((i, n) => (
                <li key={i.id}>
                  <Link href={`${base}/${i.id}`} aria-current={i.id === selectedId ? 'true' : undefined}
                    className={cn('flex items-center gap-3 border-hairline px-5 py-3 hover:bg-muted', n > 0 && 'border-t',
                      i.id === selectedId && 'bg-selected shadow-[inset_3px_0_0_var(--primary)] rtl:shadow-[inset_-3px_0_0_var(--primary)]')}>
                    {i.lead}
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate', i.id === selectedId ? 'font-semibold' : 'font-medium')}>{i.primary}</span>
                      {i.secondary && <span className={cn('block truncate text-xs text-muted-foreground', i.tone === 'critical' && 'text-critical', i.tone === 'warning' && 'text-warning')}>{i.secondary}</span>}
                    </span>
                    {i.trail && <span className="shrink-0 text-xs tabular">{i.trail}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className={cn('min-w-0 flex-1', !explicit && 'hidden lg:block')}>
          {explicit && <Link href={base} className="link mb-4 inline-block lg:hidden">{t('back', { section: title })}</Link>}
          <div className="flex flex-col gap-6">{detail}</div>
        </div>
      </div>
    </div>
  );
}

/** The record's own heading panel: an avatar/plate, the name, a quiet line, actions, and its key figures. */
export function RecordHeader({ title, meta, actions, lead, stats }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; lead?: ReactNode; stats?: Stat[] }) {
  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          {lead}
          <div className="min-w-0">
            <h2 className="text-2xl">{title}</h2>
            {meta && <p className="text-muted-foreground">{meta}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {stats && stats.length > 0 && (
        <dl className="grid grid-cols-2 border-t border-hairline bg-muted sm:grid-cols-4">
          {stats.map((s, i) => (
            <div key={i} className={cn('px-5 py-3 sm:px-6', i > 0 && 'sm:border-s sm:border-hairline', i % 2 === 1 && 'border-s border-hairline', i > 1 && 'border-t border-hairline sm:border-t-0')}>
              <dt className="text-xs text-muted-foreground">{s.label}</dt>
              <dd className={cn('text-lg font-bold tabular', s.tone && TEXT[s.tone])}>{s.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** A white panel with an Amiri title, an optional note at the end of the title row and an optional footer. */
export function Panel({ title, note, children, footer, className, flush }: { title: ReactNode; note?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cn('panel min-w-0', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-5 py-3.5 sm:px-6">
        <h3 className="font-display text-xl">{title}</h3>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      <div className={flush ? undefined : 'px-5 py-4 sm:px-6'}>{children}</div>
      {footer && <div className="rounded-b-lg border-t border-hairline bg-muted px-5 py-3 text-xs text-muted-foreground sm:px-6">{footer}</div>}
    </section>
  );
}

/** Kept for the simple record parts. */
export function Block({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return <Panel title={title} className={className}>{children}</Panel>;
}

/** Label / value pairs. */
export function Facts({ rows }: { rows: Array<[ReactNode, ReactNode] | null | false> }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2">
      {rows.filter(Boolean).map((r, i) => {
        const [k, v] = r as [ReactNode, ReactNode];
        return (<div key={i} className="contents"><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>);
      })}
    </dl>
  );
}

/** A plain table: header row in muted text, hairline rows, numeric columns aligned to the end. */
export function Table({ head, rows, numeric = [], empty }: { head: ReactNode[]; rows: ReactNode[][]; numeric?: number[]; empty?: string }) {
  if (!rows.length && empty) return <p className="text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-xs text-muted-foreground">
            {head.map((h, i) => <th key={i} className={cn('py-1.5 pe-4 font-medium', numeric.includes(i) ? 'text-end' : 'text-start')}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-t border-hairline">
              {r.map((c, ci) => <td key={ci} className={cn('py-2.5 pe-4 align-top', numeric.includes(ci) && 'text-end tabular whitespace-nowrap')}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ base, current, tabs }: { base: string; current: string; tabs: Array<{ key: string; label: string }> }) {
  return (
    <nav className="panel flex gap-1 overflow-x-auto px-3" aria-label="tabs">
      {tabs.map((tb) => (
        <Link key={tb.key} href={`${base}?tab=${tb.key}`} aria-current={tb.key === current ? 'page' : undefined}
          className={cn('whitespace-nowrap border-b-[3px] border-transparent px-3 py-3', tb.key === current ? 'border-brass font-semibold' : 'text-muted-foreground hover:text-foreground')}>
          {tb.label}
        </Link>
      ))}
    </nav>
  );
}

/** Masked secret (identity number, IBAN): only the last four ever reach the browser. */
export function Masked({ last4, none }: { last4: string | null | undefined; none: string }) {
  return last4 ? <span dir="ltr" className="tabular">•••• {last4}</span> : <span className="text-muted-foreground">{none}</span>;
}

/** A thin progress bar; `value` out of `max`, coloured by tone. */
export function Bar({ value, max, tone = 'ok', className }: { value: number; max: number; tone?: Tone; className?: string }) {
  const pct = max > 0 ? Math.max(value > 0 ? 3 : 0, Math.min(100, (value / max) * 100)) : 0;
  return <span className={cn('bar', className)} aria-hidden="true"><span className={FILL[tone]} style={{ width: `${pct}%` }} /></span>;
}

/** Label · bar · value rows (documents left, maintenance used, budget spent). */
export function BarRows({ rows }: { rows: Array<{ label: ReactNode; value: number; max: number; tone?: Tone; text: ReactNode; textTone?: Tone; href?: string }> }) {
  return (
    <div className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5">
      {rows.map((r, i) => (
        <div key={i} className="contents">
          <span className="text-muted-foreground">{r.label}</span>
          <Bar value={r.value} max={r.max} tone={r.tone} />
          <span className={cn('text-end tabular', r.textTone && cn(TEXT[r.textTone], 'font-semibold'))}>{r.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Initial in a circle, coloured by state. */
export function Avatar({ name, tone = 'ok', size = 'md' }: { name: string; tone?: Tone; size?: 'md' | 'lg' }) {
  const cls: Record<Tone, string> = { ok: 'bg-selected text-primary', critical: 'bg-critical-soft text-critical', warning: 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-warning',
    brass: 'bg-[color-mix(in_srgb,var(--brass)_22%,transparent)] text-brass-ink', muted: 'bg-muted text-muted-foreground' };
  return <span aria-hidden="true" className={cn('grid shrink-0 place-items-center rounded-full font-bold', size === 'lg' ? 'size-14 text-xl' : 'size-8 text-xs', cls[tone])}>{Array.from(name.trim())[0] ?? '·'}</span>;
}

export function Dot({ tone }: { tone: Tone }) { return <span className={cn('dot', FILL[tone])} aria-hidden="true" />; }

/** A vertical sequence of steps (approval chain, work-order progress). */
export function Steps({ steps }: { steps: Array<{ label: ReactNode; note?: ReactNode; state: 'done' | 'current' | 'todo' | 'rejected' }> }) {
  const mark: Record<string, string> = { done: 'bg-primary text-white', current: 'bg-brass text-header', todo: 'bg-track text-muted-foreground', rejected: 'bg-critical text-white' };
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => (
        <li key={i} className="relative flex gap-3.5 pb-5 last:pb-0">
          {i < steps.length - 1 && <span aria-hidden="true" className={cn('absolute start-[11px] top-6 h-[calc(100%-1.25rem)] w-0.5', s.state === 'done' ? 'bg-primary' : 'bg-track')} />}
          <span className={cn('z-10 grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold', mark[s.state])}>{s.state === 'done' ? '✓' : s.state === 'rejected' ? '✕' : i + 1}</span>
          <div className="min-w-0 pt-0.5">
            <div className={cn(s.state === 'current' && 'font-semibold', s.state === 'todo' && 'text-muted-foreground')}>{s.label}</div>
            {s.note && <div className="text-xs text-muted-foreground">{s.note}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
