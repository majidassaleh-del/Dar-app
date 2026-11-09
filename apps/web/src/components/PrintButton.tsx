'use client';

/** Opens the browser's print dialog, where "Save as PDF" produces the PDF. */
export function PrintButton({ label }: { label: string }) {
  return <button type="button" onClick={() => window.print()} className="btn btn-primary print:hidden">{label}</button>;
}
