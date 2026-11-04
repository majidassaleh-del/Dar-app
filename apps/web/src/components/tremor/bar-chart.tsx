'use client';

import * as React from 'react';
import { Bar, BarChart as RBarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cn } from '@/lib/utils';

/**
 * Tremor Raw BarChart (tremor.so/docs/visualizations/bar-chart) on Recharts.
 * In RTL the category axis runs right-to-left and the value axis sits on the right.
 */
export function BarChart<T extends Record<string, string | number>>({ data, index, categories, colors = ['var(--chart-1)', 'var(--chart-3)'],
  numberLocale = 'en', dir = 'ltr', className, layout = 'horizontal' }:
  { data: T[]; index: keyof T & string; categories: Array<{ key: keyof T & string; label: string }>; colors?: string[];
    /** Intl tag used to format values (serialisable, so server pages can pass it). */
    numberLocale?: string; dir?: 'ltr' | 'rtl'; className?: string; layout?: 'horizontal' | 'vertical' }) {
  const rtl = dir === 'rtl';
  const nf = React.useMemo(() => new Intl.NumberFormat(numberLocale, { maximumFractionDigits: 0 }), [numberLocale]);
  const valueFormatter = (v: number) => nf.format(v);
  const vertical = layout === 'vertical';
  return (
    <div className={cn('h-64 w-full', className)} dir="ltr">
      <ResponsiveContainer>
        <RBarChart data={data} layout={vertical ? 'vertical' : 'horizontal'} margin={{ top: 4, right: 8, left: 8, bottom: 0 }} barGap={4}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="0" vertical={vertical} horizontal={!vertical} />
          {/* Recharts finds axes by direct child type: no fragments here. */}
          {vertical
            ? <XAxis type="number" reversed={rtl} tickFormatter={valueFormatter} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} axisLine={false} tickLine={false} />
            : <XAxis dataKey={index} reversed={rtl} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} axisLine={false} tickLine={false} />}
          {vertical
            ? <YAxis type="category" dataKey={index} orientation={rtl ? 'right' : 'left'} width={110} tick={{ fill: 'var(--foreground)', fontSize: 12 }} axisLine={false} tickLine={false} />
            : <YAxis orientation={rtl ? 'right' : 'left'} tickFormatter={valueFormatter} width={56} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} axisLine={false} tickLine={false} />}
          <Tooltip cursor={{ fill: 'var(--muted)' }} formatter={(v: number) => valueFormatter(v)}
            contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--popover-foreground)', fontSize: 12 }} />
          <Legend align={rtl ? 'right' : 'left'} verticalAlign="top" height={28} iconType="circle" iconSize={8}
            formatter={(value) => <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>{value}</span>} />
          {categories.map((c, i) => <Bar key={c.key} dataKey={c.key} name={c.label} fill={colors[i % colors.length]} radius={[3, 3, 0, 0]} maxBarSize={28} />)}
        </RBarChart>
      </ResponsiveContainer>
    </div>
  );
}
