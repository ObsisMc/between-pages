import { useId } from 'react';

// The browser caches a small SVG texture resource; the full book has no noise filter.
function PaperGrain({ id }: { id: string }) {
  return (
    <pattern id={id} width="128" height="128" patternUnits="userSpaceOnUse">
      <image href="/home/paper-grain.svg" width="128" height="128" />
    </pattern>
  );
}

/** The entire book is editable vector geometry; no book or paper bitmap is used. */
export function HomeBookSurface() {
  const id = useId();
  const left =
    'M110 68C327 53 662 35 768 78L768 953C676 925 353 949 109 939Q91 938 92 920L97 90Q98 71 110 68Z';
  const right =
    'M768 78C862 38 1180 52 1427 65Q1443 66 1442 85L1452 917Q1453 937 1432 940C1154 938 856 929 768 953Z';
  return (
    <>
      <svg
        className="home-paper-desktop"
        viewBox="0 0 1536 1024"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`${id}-cover`} x2="0" y2="1">
            <stop stopColor="#e9d8b9" />
            <stop offset="0.9" stopColor="#d8bd96" />
            <stop offset="1" stopColor="#b89469" />
          </linearGradient>
          <linearGradient id={`${id}-left`}>
            <stop stopColor="#fffbf1" />
            <stop offset="0.9" stopColor="#fcf7eb" />
            <stop offset="0.98" stopColor="#f0e4ce" />
            <stop offset="1" stopColor="#d6bd97" />
          </linearGradient>
          <linearGradient id={`${id}-right`}>
            <stop stopColor="#d6bd97" />
            <stop offset="0.025" stopColor="#eee0c6" />
            <stop offset="0.055" stopColor="#fcf7eb" />
            <stop offset="0.9" stopColor="#fffaf0" />
            <stop offset="1" stopColor="#f3e8d4" />
          </linearGradient>
          <radialGradient id={`${id}-shadow`}>
            <stop stopColor="#86603d" stopOpacity="0.3" />
            <stop offset="0.65" stopColor="#967147" stopOpacity="0.14" />
            <stop offset="1" stopColor="#ad8d62" stopOpacity="0" />
          </radialGradient>
          <PaperGrain id={`${id}-grain`} />
        </defs>
        <ellipse cx="770" cy="964" rx="750" ry="54" fill={`url(#${id}-shadow)`} />
        <path
          d="M80 73C275 42 648 42 768 68C885 40 1309 44 1453 70Q1480 75 1480 101L1488 936Q1487 960 1464 965C1270 972 1007 954 800 973Q768 984 736 973C548 956 267 972 78 965Q51 963 53 937L65 100Q65 78 80 73Z"
          fill={`url(#${id}-cover)`}
          stroke="#c7a77c"
          strokeWidth="1.5"
        />
        {[0, 1, 2, 3].map((layer) => (
          <g
            key={layer}
            transform={`translate(0 ${13 - layer * 3})`}
            fill={layer % 2 ? '#f8f0df' : '#eee0c8'}
            stroke="#d7c2a0"
            strokeWidth="1"
          >
            <path
              d="M93 66C288 48 653 39 768 78L768 953C668 932 299 950 88 940Q69 939 71 920L79 88Q80 68 93 66Z"
              transform={`translate(${layer * 4} 0)`}
            />
            <path
              d="M768 78C882 40 1237 46 1446 66Q1467 67 1468 88L1475 921Q1476 942 1455 943C1246 945 858 932 768 953Z"
              transform={`translate(${-layer * 4} 0)`}
            />
          </g>
        ))}
        <path d={left} fill={`url(#${id}-left)`} stroke="#e1cbaa" strokeWidth="0.8" />
        <path d={right} fill={`url(#${id}-right)`} stroke="#e1cbaa" strokeWidth="0.8" />
        <g fill={`url(#${id}-grain)`}>
          <path d={left} />
          <path d={right} />
        </g>
        <path
          d="M110 69C327 54 662 36 766 78M770 78C864 39 1180 53 1427 66"
          fill="none"
          stroke="#fffdf5"
          strokeWidth="2"
        />
        <path
          d="M768 80C765 310 772 723 768 952"
          fill="none"
          stroke="#a98555"
          strokeOpacity="0.45"
          strokeWidth="1.2"
        />
        <path
          d="M772 84C769 310 776 723 772 947"
          fill="none"
          stroke="#fffaf0"
          strokeOpacity="0.55"
          strokeWidth="1.7"
        />
      </svg>
      <svg className="home-paper-mobile" aria-hidden="true">
        <defs>
          <PaperGrain id={`${id}-mobile-grain`} />
        </defs>
        <rect width="100%" height="100%" fill="#fcf7eb" />
        <rect width="100%" height="100%" fill={`url(#${id}-mobile-grain)`} />
      </svg>
    </>
  );
}
