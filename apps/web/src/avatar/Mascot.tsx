import { useId } from 'react';

/** Which of the two the mascot stands for: author slot 1 or 2, or neither (no space yet). */
export type MascotTone = 1 | 2 | null;

/**
 * The face it pulls (window-mascots D1, D6). `idle` blinks now and then, `poked` squeezes its
 * eyes shut, `happy` smiles with closed eyes (it was poked by the partner), `asleep` has
 * closed eyes and a small open mouth.
 */
export type MascotMood = 'idle' | 'poked' | 'happy' | 'asleep';

const INK = '#2b2420';

function Face({ mood }: { mood: MascotMood }) {
  const line = { fill: 'none', stroke: INK, strokeWidth: 2.6, strokeLinecap: 'round' } as const;
  switch (mood) {
    case 'poked':
      return (
        <g>
          <path d="M41 41l8 5-8 5" {...line} />
          <path d="M79 41l-8 5 8 5" {...line} />
          <ellipse cx="60" cy="59" rx="4" ry="4.6" fill={INK} />
        </g>
      );
    case 'happy':
      return (
        <g>
          <path d="M40 48q6-8 12 0" {...line} />
          <path d="M68 48q6-8 12 0" {...line} />
          <path d="M50 55q10 11 20 0" {...line} />
        </g>
      );
    case 'asleep':
      return (
        <g>
          <path d="M40 46q6 5 12 0" {...line} />
          <path d="M68 46q6 5 12 0" {...line} />
          <ellipse cx="60" cy="59" rx="2.6" ry="2.2" fill={INK} opacity="0.75" />
        </g>
      );
    default:
      return (
        <g>
          <g className="mascot-blink">
            <ellipse cx="46" cy="46" rx="3.4" ry="4.4" fill={INK} />
            <ellipse cx="74" cy="46" rx="3.4" ry="4.4" fill={INK} />
          </g>
          <path d="M52 56q8 7 16 0" {...line} strokeWidth={2.4} />
        </g>
      );
  }
}

const BODY: Record<'1' | '2' | 'none', { light: string; base: string; edge: string }> = {
  '1': { light: '#fcd2b2', base: '#f3a676', edge: '#df8a58' },
  '2': { light: '#c6e3fb', base: '#8fc3ee', edge: '#6aa5d8' },
  none: { light: '#ece3d8', base: '#d6c8b8', edge: '#bfae9b' },
};

type Color = (typeof BODY)['1'];
const colorOf = (tone: MascotTone): Color =>
  BODY[tone === null ? 'none' : (String(tone) as '1' | '2')];

// The mascot is drawn in three layers on a 120 × 92 grid whose line y = 78 is the surface it
// sits on: a shadow on that surface, the body with its face, and the paws resting over the
// surface's front edge. A window moves only the body; the shadow and the paws stay on the sill.

/** A soft shadow on the surface, mostly hidden behind the body. */
export function MascotShadow() {
  const id = useId();
  return (
    <g>
      <defs>
        <filter id={`${id}s`} x="-20%" y="-200%" width="140%" height="500%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
      </defs>
      <ellipse
        cx="60"
        cy="79"
        rx="47"
        ry="3.6"
        fill="#3b2a1e"
        opacity="0.22"
        filter={`url(#${id}s)`}
      />
    </g>
  );
}

/** The plump body, cheeks and face; its bottom rests on the surface line. */
export function MascotBody({ tone, mood = 'idle' }: { tone: MascotTone; mood?: MascotMood }) {
  const id = useId();
  const color = colorOf(tone);
  return (
    <g>
      <defs>
        <radialGradient id={`${id}b`} cx="38%" cy="30%" r="75%">
          <stop offset="0" stopColor={color.light} />
          <stop offset="0.55" stopColor={color.base} />
          <stop offset="1" stopColor={color.edge} />
        </radialGradient>
      </defs>
      <path
        d="M11 58C9 28 32 9 60 9s51 19 49 49c-1 14-18 21-49 21S12 72 11 58Z"
        fill={`url(#${id}b)`}
      />
      <ellipse cx="38" cy="56" rx="7.5" ry="4.5" fill="#f08a8a" opacity="0.38" />
      <ellipse cx="82" cy="56" rx="7.5" ry="4.5" fill="#f08a8a" opacity="0.38" />
      <g transform="translate(0 -2)">
        <Face mood={mood} />
      </g>
    </g>
  );
}

/** Two small mitts over the surface's front edge, lit from above like the body. */
export function MascotPaws({ tone }: { tone: MascotTone }) {
  const id = useId();
  const color = colorOf(tone);
  const paw = (x: number) => (
    <g key={x}>
      {/* Its own small shadow on the front face below. */}
      <ellipse cx={x} cy="86.5" rx="8" ry="1.8" fill="#3b2a1e" opacity="0.14" />
      <path
        d={`M${x - 9} 79.5c0-4 4-6.5 9-6.5s9 2.5 9 6.5c0 3.6-4 6-9 6s-9-2.4-9-6Z`}
        fill={`url(#${id}p)`}
      />
      <path
        d={`M${x - 2.6} 81.2v2.6M${x + 2.6} 81.2v2.6`}
        stroke={color.edge}
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity="0.6"
      />
    </g>
  );
  return (
    <g>
      <defs>
        <linearGradient id={`${id}p`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color.light} />
          <stop offset="0.6" stopColor={color.base} />
          <stop offset="1" stopColor={color.edge} />
        </linearGradient>
      </defs>
      {paw(40)}
      {paw(80)}
    </g>
  );
}

/**
 * The round mascot (digital-paper-interface D4): a plump, slightly squashed body with small
 * paws, eyes, a smile and cheeks, in the slot's color. Decoration only: hidden from
 * assistive technology, so whoever it stands for is always named in text beside it.
 */
export function Mascot({
  tone,
  size = 32,
  mood = 'idle',
}: {
  tone: MascotTone;
  size?: number;
  mood?: MascotMood;
}) {
  return (
    <svg
      viewBox="0 0 120 92"
      width={size}
      height={(size * 92) / 120}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <MascotShadow />
      <MascotBody tone={tone} mood={mood} />
      <MascotPaws tone={tone} />
    </svg>
  );
}
