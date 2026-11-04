'use client';

import { ThemeProvider as NextThemes } from 'next-themes';
import type { ReactNode } from 'react';

/** Light / Slate Dark via the `.dark` class (shadcn convention); follows the OS until the user picks. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return <NextThemes attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>{children}</NextThemes>;
}
