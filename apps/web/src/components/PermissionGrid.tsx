import type { ReactNode } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { MODULES, permissionLabel } from '@/lib/permissions';
import { loose } from '@/lib/sections';

export interface GridRow { id: string; module: string; description: string | null; note?: ReactNode; control: ReactNode }

/** Permissions grouped by module: name, an optional note (what the role gives), and one control each. */
export async function PermissionGrid({ rows, noteHead, controlHead }: { rows: GridRow[]; noteHead?: string; controlHead: string }) {
  const [t0, locale] = await Promise.all([getTranslations('ui'), getLocale()]);
  const t = loose(t0);
  const modules = [...MODULES.filter((m) => rows.some((r) => r.module === m)), ...new Set(rows.map((r) => r.module).filter((m) => !MODULES.includes(m)))];
  return (
    <div className="flex flex-col gap-5">
      {modules.map((m) => (
        <section key={m} className="panel min-w-0 overflow-hidden">
          <h3 className="border-b border-hairline bg-muted px-5 py-2.5 font-display text-lg sm:px-6">{t.has(`members.module.${m}`) ? t(`members.module.${m}`) : m}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sr-only"><tr><th>{t('members.permission')}</th>{noteHead && <th>{noteHead}</th>}<th>{controlHead}</th></tr></thead>
              <tbody>
                {rows.filter((r) => r.module === m).map((r) => (
                  <tr key={r.id} className="border-b border-hairline last:border-0">
                    <td className="px-5 py-2.5 sm:px-6">{permissionLabel(r.id, locale, r.description)}</td>
                    {noteHead && <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">{r.note}</td>}
                    <td className="w-[13rem] px-5 py-2 sm:px-6">{r.control}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
