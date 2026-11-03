import { useId } from 'react';

/** Which of the two the mascot stands for: author slot 1 or 2, or neither (no space yet). */
export type MascotTone = 1 | 2 | null;

const BODY: Record<'1' | '2' | 'none', { light: string; base: string; edge: string }> = {
  '1': { light: '#fcd2b2', base: '#f3a676', edge: '#df8a58' },
  '2': { light: '#c6e3fb', base: '#8fc3ee', edge: '#6aa5d8' },
  none: { light: '#ece3d8', base: '#d6c8b8', edge: '#bfae9b' },
};

/**
 * The round mascot (digital-paper-interface D4): a plump, slightly squashed body with small
 * paws, eyes, a smile and cheeks, in the slot's color. Decoration only: hidden from
 * assistive technology, so whoever it stands for is always named in text beside it.
 */
export function Mascot({ tone, size = 32 }: { tone: MascotTone; size?: number }) {
  const id = useId();
  const color = BODY[tone === null ? 'none' : (String(tone) as '1' | '2')];
  return (
    <svg
      viewBox="0 0 120 92"
      width={size}
      height={(size * 92) / 120}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <defs>
        <radialGradient id={`${id}b`} cx="38%" cy="30%" r="75%">
          <stop offset="0" stopColor={color.light} />
          <stop offset="0.55" stopColor={color.base} />
          <stop offset="1" stopColor={color.edge} />
        </radialGradient>
      </defs>
      <ellipse cx="60" cy="86" rx="46" ry="5" fill="#3b2a1e" opacity="0.12" />
      <path
        d="M11 60C9 30 32 11 60 11s51 19 49 49c-1 16-18 23-49 23S12 76 11 60Z"
        fill={`url(#${id}b)`}
      />
      <ellipse cx="38" cy="58" rx="7.5" ry="4.5" fill="#f08a8a" opacity="0.38" />
      <ellipse cx="82" cy="58" rx="7.5" ry="4.5" fill="#f08a8a" opacity="0.38" />
      <ellipse cx="46" cy="46" rx="3.4" ry="4.4" fill="#2b2420" />
      <ellipse cx="74" cy="46" rx="3.4" ry="4.4" fill="#2b2420" />
      <path
        d="M52 56q8 7 16 0"
        fill="none"
        stroke="#2b2420"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <ellipse
        cx="40"
        cy="81"
        rx="10"
        ry="6.5"
        fill={color.base}
        stroke={color.edge}
        strokeWidth="1.2"
      />
      <ellipse
        cx="80"
        cy="81"
        rx="10"
        ry="6.5"
        fill={color.base}
        stroke={color.edge}
        strokeWidth="1.2"
      />
    </svg>
  );
}
