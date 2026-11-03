import { useId } from 'react';
import { Mascot, type MascotTone } from '../avatar/index.ts';

// The paired windows (digital-paper-interface D4): frame, sill, sky, light and mascot are
// separate SVG layers, so each can change on its own. The frame's color is the person's
// author slot and never changes with the time of day; the sky follows that person's local
// time. Decoration only: the page says in text whose window is whose and what time it is.

export type Sky = 'dawn' | 'day' | 'dusk' | 'night';

export type WindowSide = {
  tone: MascotTone;
  /** That person's local sky; null when it is unknown, drawn as a plain daytime sky. */
  sky: Sky | null;
  /** Nobody at this window yet (no partner): the frame stays, empty and faded. */
  empty?: boolean;
};

const FRAME: Record<'1' | '2' | 'none', { light: string; base: string; dark: string }> = {
  '1': { light: '#f6bb8c', base: '#e9975e', dark: '#c97a44' },
  '2': { light: '#b4d0c6', base: '#8fb4a8', dark: '#6f978b' },
  none: { light: '#e6dccf', base: '#d3c5b4', dark: '#b6a691' },
};

const SKY: Record<Sky, [string, string]> = {
  dawn: ['#f8e4d3', '#cddcf0'],
  day: ['#fde6cd', '#f7c8a0'],
  dusk: ['#f6c2a3', '#c79bb6'],
  night: ['#6a87b4', '#3f5a88'],
};

const OUTER = 'M18 252V104a82 82 0 0 1 164 0v148Z';
const INNER = 'M31 246V104a69 69 0 0 1 138 0v142Z';

function SkyDetails({ sky }: { sky: Sky }) {
  if (sky === 'night')
    return (
      <g fill="#f7e6b4">
        <path d="M128 70a17 17 0 1 0 16 22 13 13 0 1 1-16-22Z" />
        <path d="m78 72 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" />
        <path d="m146 120 1.5 3.5 3.5 1.5-3.5 1.5-1.5 3.5-1.5-3.5-3.5-1.5 3.5-1.5Z" />
        <circle cx="62" cy="128" r="1.6" />
      </g>
    );
  if (sky === 'dusk') return <circle cx="74" cy="150" r="17" fill="#f39a6b" opacity="0.85" />;
  return (
    <g>
      <circle cx="72" cy={sky === 'dawn' ? 140 : 76} r="17" fill="#f7ae55" />
      <path
        d="M112 168c0-8 7-14 15-14 5-7 18-7 22 2 8 0 13 6 13 12Z"
        fill="#fff6ec"
        opacity="0.8"
      />
    </g>
  );
}

function Window({ side }: { side: WindowSide }) {
  const id = useId();
  const frame = FRAME[side.tone === null ? 'none' : (String(side.tone) as '1' | '2')];
  const sky = side.sky ?? 'day';
  const [skyTop, skyBottom] = SKY[sky];
  return (
    <svg viewBox="0 0 200 272" className="h-auto w-full" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={skyTop} />
          <stop offset="1" stopColor={skyBottom} />
        </linearGradient>
        <linearGradient id={`${id}frame`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={frame.light} />
          <stop offset="0.45" stopColor={frame.base} />
          <stop offset="1" stopColor={frame.dark} />
        </linearGradient>
        <linearGradient id={`${id}sill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={frame.light} />
          <stop offset="1" stopColor={frame.base} />
        </linearGradient>
        <clipPath id={`${id}glass`}>
          <path d={INNER} />
        </clipPath>
        {/* A faint matte grain on the wood only, computed once for this small tile. */}
        <filter id={`${id}grain`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="table" tableValues="0 0.16" />
          </feComponentTransfer>
          <feComposite in2="SourceGraphic" operator="in" />
        </filter>
      </defs>
      <g opacity={side.empty ? 0.55 : 1}>
        {/* Contact shadow under the sill. */}
        <ellipse cx="100" cy="266" rx="90" ry="5" fill="#3b2a1e" opacity="0.14" />
        {/* Frame, with a light rim and the grain. */}
        <path d={OUTER} fill={`url(#${id}frame)`} />
        <path d={OUTER} fill={frame.base} filter={`url(#${id}grain)`} />
        <path d={OUTER} fill="none" stroke={frame.light} strokeWidth="2" opacity="0.7" />
        {/* Sky, its sun or moon, and the inner edge's shade. */}
        <path d={INNER} fill={`url(#${id}sky)`} />
        <g clipPath={`url(#${id}glass)`}>
          <SkyDetails sky={sky} />
          <path
            d={INNER}
            fill="none"
            stroke={frame.dark}
            strokeWidth="7"
            opacity="0.35"
            transform="translate(2 3)"
          />
        </g>
        {/* Transom bar across the arch. */}
        <rect x="31" y="100" width="138" height="8" fill={`url(#${id}frame)`} />
        <rect x="31" y="100" width="138" height="2" fill={frame.light} opacity="0.7" />
        {/* Sill, thicker than the frame and lit from above. */}
        <rect x="8" y="244" width="184" height="20" rx="7" fill={`url(#${id}sill)`} />
        <rect
          x="8"
          y="244"
          width="184"
          height="20"
          rx="7"
          fill={frame.base}
          filter={`url(#${id}grain)`}
        />
        <rect x="12" y="245" width="176" height="3" rx="1.5" fill="#fff" opacity="0.35" />
        {/* The mascot sits on the sill, its paws over the front edge. */}
        {!side.empty && (
          <g transform="translate(50 179)">
            <Mascot tone={side.tone} size={100} />
          </g>
        )}
      </g>
    </svg>
  );
}

/** Two windows side by side: the viewer's and the partner's (or an empty one). */
export function PairedWindows({ left, right }: { left: WindowSide; right: WindowSide }) {
  return (
    <div className="grid grid-cols-2 gap-6 sm:gap-8">
      <Window side={left} />
      <Window side={right} />
    </div>
  );
}
