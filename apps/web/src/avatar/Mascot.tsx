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
  const line = { fill: 'none', stroke: INK, strokeWidth: 2.4, strokeLinecap: 'round' } as const;
  switch (mood) {
    case 'poked':
      return (
        <g>
          <path d="M44 37l7 4.5-7 4.5" {...line} />
          <path d="M76 37l-7 4.5 7 4.5" {...line} />
          <ellipse cx="60" cy="53" rx="3.4" ry="4" fill={INK} />
        </g>
      );
    case 'happy':
      return (
        <g>
          <path d="M43 43q5-7 10 0" {...line} />
          <path d="M67 43q5-7 10 0" {...line} />
          <path d="M52 50q8 9 16 0" {...line} />
        </g>
      );
    case 'asleep':
      return (
        <g>
          <path d="M43 41q5 4.5 10 0" {...line} />
          <path d="M67 41q5 4.5 10 0" {...line} />
          <ellipse cx="60" cy="53" rx="2.3" ry="2" fill={INK} opacity="0.75" />
        </g>
      );
    default:
      return (
        <g>
          <g className="mascot-blink">
            <circle cx="47" cy="41" r="3.3" fill={INK} />
            <circle cx="73" cy="41" r="3.3" fill={INK} />
          </g>
          <path d="M53 50q7 7.4 14 0" {...line} />
        </g>
      );
  }
}

const BODY: Record<
  '1' | '2' | 'none',
  { base: string; pale: string; deep: string; cheek: string; blush: number }
> = {
  '1': { base: '#f79a70', pale: '#fbb492', deep: '#f4835a', cheek: '#f26f44', blush: 0.5 },
  '2': { base: '#7ab3e4', pale: '#a1cbef', deep: '#639fd8', cheek: '#a89bd8', blush: 0.42 },
  none: { base: '#d6c8b8', pale: '#ece3d8', deep: '#c4b4a2', cheek: '#c9a79a', blush: 0.4 },
};

const colorOf = (tone: MascotTone) => BODY[tone === null ? 'none' : (String(tone) as '1' | '2')];

// The mascot is drawn on a 120 × 92 grid whose line y = 78 is the surface it sits on: a shadow
// on that surface, then the body with its face. A window moves only the body.

const SILHOUETTE =
  'M60 5C76 5 91 12 98.5 28.5 105 43 106.5 58 97 68.5 87 79 73 79 60 79S32 79 22.5 68.5C13 58 14.5 43 21.5 28.5 29 12 44 5 60 5Z';

// The washes that mottle the body. Gradients fading to nothing rather than blur filters: the
// date index shows dozens of mascots, and that many blurred layers would slow every repaint.
const PALE_WASHES = [
  { cx: 44, cy: 20, rx: 30, ry: 18, opacity: 0.85 },
  { cx: 86, cy: 30, rx: 20, ry: 18, opacity: 0.95 },
  { cx: 33, cy: 68, rx: 28, ry: 14, opacity: 0.6 },
  { cx: 78, cy: 66, rx: 26, ry: 13, opacity: 0.55 },
];
const DEEP_WASHES = [
  { cx: 60, cy: 33, rx: 26, ry: 14, opacity: 0.55 },
  { cx: 60, cy: 62, rx: 36, ry: 12, opacity: 0.35 },
];

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
        rx="42"
        ry="3.6"
        fill="#3b2a1e"
        opacity="0.22"
        filter={`url(#${id}s)`}
      />
    </g>
  );
}

/** The soft body, cheeks and face; its bottom rests on the surface line. */
export function MascotBody({ tone, mood = 'idle' }: { tone: MascotTone; mood?: MascotMood }) {
  const id = useId();
  const color = colorOf(tone);
  const wash = (name: string, stop: string) => (
    <radialGradient id={`${id}${name}`}>
      <stop offset="0" stopColor={stop} />
      <stop offset="1" stopColor={stop} stopOpacity="0" />
    </radialGradient>
  );
  return (
    <g>
      <defs>
        {wash('pale', color.pale)}
        {wash('deep', color.deep)}
        {wash('cheek', color.cheek)}
        <clipPath id={`${id}clip`}>
          <path d={SILHOUETTE} />
        </clipPath>
      </defs>
      {/* Faint strokes under the fill feather the edge, as ink does on damp paper. */}
      <path d={SILHOUETTE} fill="none" stroke={color.base} strokeWidth="3" opacity="0.18" />
      <path d={SILHOUETTE} fill="none" stroke={color.base} strokeWidth="1.5" opacity="0.32" />
      <path d={SILHOUETTE} fill={color.base} />
      <g clipPath={`url(#${id}clip)`}>
        {PALE_WASHES.map((w) => (
          <ellipse key={`${w.cx}-${w.cy}`} {...w} fill={`url(#${id}pale)`} />
        ))}
        {DEEP_WASHES.map((w) => (
          <ellipse key={`${w.cx}-${w.cy}`} {...w} fill={`url(#${id}deep)`} />
        ))}
      </g>
      <ellipse cx="33" cy="52" rx="15" ry="12" fill={`url(#${id}cheek)`} opacity={color.blush} />
      <ellipse cx="87" cy="52" rx="15" ry="12" fill={`url(#${id}cheek)`} opacity={color.blush} />
      <Face mood={mood} />
    </g>
  );
}

/**
 * The mascot: a soft, slightly lopsided round body with eyes, a smile and cheeks, in the
 * slot's color. Decoration only: hidden from assistive technology, so whoever it stands for
 * is always named in text beside it.
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
      viewBox="8 0 104 84"
      width={size}
      height={(size * 84) / 104}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <MascotShadow />
      <MascotBody tone={tone} mood={mood} />
    </svg>
  );
}
