import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

export interface ListItem { id: string; primary: ReactNode; secondary?: ReactNode; tone?: 'critical' | 'warning' }

/**
 * A section page: the list on one side, the selected record beside it (like a mail client).
 * On a phone only one shows: the list at /section, the record at /section/:id with a way back.
 */
export async function ListDetail({ title, base, items, selectedId, explicit, detail, empty }:
  { title: string; base: string; items: ListItem[]; selectedId: string | null; explicit: boolean; detail: ReactNode; empty: string }) {
  const t = await getTranslations('ui');
  return (
    <div className="lg:flex lg:min-h-dvh">
      <section aria-label={title} className={cn('border-e lg:w-80 lg:shrink-0', explicit && 'hidden lg:block')}>
        <header className="flex items-baseline justify-between gap-3 border-b px-5 py-4">
          <h1 className="text-lg font-semibold">{title}</h1>
          <span className="text-xs text-muted-foreground tabular">{items.length}</span>
        </header>
        {items.length === 0 ? <p className="px-5 py-4 text-muted-foreground">{empty}</p> : (
          <ul>
            {items.map((i) => (
              <li key={i.id}>
                <Link href={`${base}/${i.id}`} aria-current={i.id === selectedId ? 'true' : undefined}
                  className={cn('block border-b px-5 py-3 hover:bg-muted', i.id === selectedId && 'bg-muted')}>
                  <span className={cn('block', i.id === selectedId ? 'font-semibold' : 'font-medium')}>{i.primary}</span>
                  {i.secondary && <span className={cn('block text-xs text-muted-foreground', i.tone === 'critical' && 'text-critical', i.tone === 'warning' && 'text-warning')}>{i.secondary}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className={cn('min-w-0 flex-1 px-5 py-6 sm:px-8', !explicit && 'hidden lg:block')}>
        {explicit && <Link href={base} className="link mb-4 inline-block lg:hidden">{t('back', { section: title })}</Link>}
        {detail}
      </div>
    </div>
  );
}

/** Record heading: name, one quiet line under it, optional actions at the end. */
export function RecordHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold">{title}</h2>
        {meta && <p className="text-muted-foreground">{meta}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Label / value pairs. */
export function Facts({ rows }: { rows: Array<[ReactNode, ReactNode] | null | false> }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5">
      {rows.filter(Boolean).map((r, i) => {
        const [k, v] = r as [ReactNode, ReactNode];
        return (<div key={i} className="contents"><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>);
      })}
    </dl>
  );
}

export function Block({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0', className)}>
      <h3 className="mb-2 text-lg font-semibold">{title}</h3>
      {children}
    </section>
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
            <tr key={ri} className="border-t">
              {r.map((c, ci) => <td key={ci} className={cn('py-2 pe-4 align-top', numeric.includes(ci) && 'text-end tabular whitespace-nowrap')}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ base, current, tabs }: { base: string; current: string; tabs: Array<{ key: string; label: string }> }) {
  return (
    <nav className="mb-6 flex gap-6 overflow-x-auto border-b" aria-label="tabs">
      {tabs.map((tb) => (
        <Link key={tb.key} href={`${base}?tab=${tb.key}`} aria-current={tb.key === current ? 'page' : undefined}
          className={cn('-mb-px whitespace-nowrap border-b-2 border-transparent py-2', tb.key === current ? 'border-foreground font-semibold' : 'text-muted-foreground hover:text-foreground')}>
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
