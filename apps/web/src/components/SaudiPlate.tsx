import { cn } from '@/lib/utils';

/**
 * Saudi-style number plate: digits on the left half, letters on the right, Arabic
 * above Latin, with the KSA band. "ABC 1234" + "أ ب ح ١٢٣٤". Always laid out LTR,
 * as the physical plate is.
 */
function split(s: string) {
  return { digits: (s.match(/[0-9٠-٩]+/g) ?? []).join(''), letters: s.replace(/[0-9٠-٩]/g, '').trim() };
}

export function SaudiPlate({ latin, arabic, className }: { latin: string; arabic: string | null; className?: string }) {
  const l = split(latin), a = split(arabic ?? '');
  const cell = 'grid grid-rows-2 place-items-center px-2 text-[13px] font-semibold leading-[1.25]';
  return (
    <span dir="ltr" aria-label={latin}
      className={cn('inline-flex items-stretch overflow-hidden rounded-md border-2 border-foreground bg-background text-foreground', className)}>
      <span className={cell}><span>{a.digits || l.digits}</span><span className="tracking-[0.18em]">{l.digits}</span></span>
      <span className="w-px bg-foreground/60" />
      <span className={cell}><span>{a.letters}</span><span className="tracking-[0.18em]">{l.letters}</span></span>
      <span className="flex w-4 flex-col items-center justify-center border-s border-foreground/60 text-[7px] font-semibold leading-tight">
        <span>K</span><span>S</span><span>A</span>
      </span>
    </span>
  );
}
