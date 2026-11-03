import type { ReactNode } from 'react';
import { PairedWindows } from './PairedWindows.tsx';

// The frame of the pages before a space exists for the viewer, login and invitation
// (digital-paper-interface D4): the paired windows with the product's line beside the
// page's own card, which comes first on a narrow window. Nobody's time is known here, so
// both skies are the plain day sky.

export function WelcomeLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto grid w-full max-w-5xl items-center gap-10 px-5 pt-10 pb-16 font-sans text-ink wrap-anywhere sm:px-8 md:min-h-[calc(100dvh-var(--site-header))] md:grid-cols-[1fr_minmax(0,26rem)] md:gap-14">
      <section aria-label="Between Pages">
        <p className="text-xs tracking-[0.2em] text-ink-soft">BETWEEN PAGES</p>
        <p className="mt-4 font-serif text-4xl leading-tight font-medium sm:text-5xl">
          给彼此，留一页。
        </p>
        <p className="mt-5 font-serif text-lg leading-relaxed text-ink-soft">
          把今天的小事，
          <br />
          慢慢写成我们的故事。
        </p>
        <div className="mt-8 max-w-xs">
          <PairedWindows left={{ tone: 1, sky: null }} right={{ tone: 2, sky: null }} />
        </div>
      </section>
      <div className="order-first rounded-2xl border border-line bg-paper p-6 shadow-sm sm:p-8 md:order-last">
        {children}
      </div>
    </main>
  );
}
