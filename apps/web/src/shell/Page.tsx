import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../ui/index.ts';

// The container of a page under the site header (digital-paper-interface 落地顺序 2): one
// width and margin for every redrawn page, and its heading with the page's own actions.

export function Page({ className, ...props }: ComponentProps<'main'>) {
  return (
    <main
      className={cn(
        'mx-auto w-full max-w-5xl px-5 pt-8 pb-16 font-sans text-ink wrap-anywhere sm:px-8 sm:pt-12',
        className,
      )}
      {...props}
    />
  );
}

/** The page's title, a line under it, and its main actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  above,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A link back or a kicker over the title. */
  above?: ReactNode;
}) {
  return (
    <header className="mb-8">
      {above}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-serif text-3xl leading-tight font-medium sm:text-4xl">{title}</h1>
        {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
      </div>
      {description && (
        <div className="mt-3 text-sm leading-relaxed text-ink-soft">{description}</div>
      )}
    </header>
  );
}

/** A section's title inside a page. */
export function SectionTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('mb-4 font-serif text-xl font-medium', className)} {...props} />;
}
