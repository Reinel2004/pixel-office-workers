// Inline SVG icons (stroke style, 20×20 grid).
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 4.5v11l9-5.5z" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconPause = (p: P) => (
  <Svg {...p}>
    <path d="M7 4.5v11M13 4.5v11" strokeWidth={2.4} />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M10 4v12M4 10h12" />
  </Svg>
);
export const IconMinus = (p: P) => (
  <Svg {...p}>
    <path d="M4 10h12" />
  </Svg>
);
export const IconFit = (p: P) => (
  <Svg {...p}>
    <path d="M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4" />
  </Svg>
);
export const IconGear = (p: P) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="2.6" />
    <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
  </Svg>
);
export const IconSound = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 8h3l4-3.5v11L6.5 12h-3z" />
    <path d="M13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5.5a6.5 6.5 0 0 1 0 9" />
  </Svg>
);
export const IconMute = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 8h3l4-3.5v11L6.5 12h-3z" />
    <path d="M13.5 8l4 4M17.5 8l-4 4" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M5 5l10 10M15 5L5 15" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 10.5l3.5 3.5 7.5-8" />
  </Svg>
);
export const IconSend = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 10h11M10 5l5 5-5 5" />
  </Svg>
);
export const IconCamera = (p: P) => (
  <Svg {...p}>
    <path d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5h2l1.2-2h4.6l1.2 2h2A1.5 1.5 0 0 1 17 7.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z" />
    <circle cx="10" cy="11" r="2.8" />
  </Svg>
);
export const IconList = (p: P) => (
  <Svg {...p}>
    <path d="M7 5.5h9M7 10h9M7 14.5h9" />
    <circle cx="4" cy="5.5" r=".8" fill="currentColor" />
    <circle cx="4" cy="10" r=".8" fill="currentColor" />
    <circle cx="4" cy="14.5" r=".8" fill="currentColor" />
  </Svg>
);
export const IconChevron = ({ open, ...p }: P & { open?: boolean }) => (
  <Svg {...p} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }}>
    <path d="M5 7.5l5 5 5-5" />
  </Svg>
);
export const IconDoor = (p: P) => (
  <Svg {...p}>
    <path d="M5 17V3.5h10V17M3 17h14" />
    <path d="M7.5 6v8M12.5 6v8" strokeWidth={1.2} />
    <circle cx="13.6" cy="10.5" r=".7" fill="currentColor" />
  </Svg>
);
export const IconFactory = (p: P) => (
  <Svg {...p}>
    <path d="M3 16.5V9l4 2.5V9l4 2.5V5h3l1 11.5z" />
    <path d="M3 16.5h14" />
  </Svg>
);
export const IconMegaphone = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 8.5v3h2.5l7 3.5v-10l-7 3.5z" />
    <path d="M6 11.5l1 4h2l-.8-3" />
    <path d="M15.5 8.5v3" />
  </Svg>
);
export const IconAlert = (p: P) => (
  <Svg {...p}>
    <path d="M10 3l7.5 13h-15z" />
    <path d="M10 8v3.5M10 13.8v.2" />
  </Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="7" y="7" width="9.5" height="9.5" rx="2" />
    <path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 4 5v6A1.5 1.5 0 0 0 5.5 12.5H7" />
  </Svg>
);
export const IconRetry = (p: P) => (
  <Svg {...p}>
    <path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9" />
    <path d="M15.5 3.5v3.5H12" />
  </Svg>
);
export const IconTarget = (p: P) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="5.5" />
    <circle cx="10" cy="10" r="1.6" fill="currentColor" />
    <path d="M10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18" />
  </Svg>
);
export const IconUsers = (p: P) => (
  <Svg {...p}>
    <circle cx="7.5" cy="7" r="2.7" />
    <path d="M2.5 16c.6-2.8 2.6-4.3 5-4.3s4.4 1.5 5 4.3" />
    <path d="M13 4.6a2.6 2.6 0 0 1 0 5M14.5 11.9c1.6.5 2.6 1.8 3 4.1" />
  </Svg>
);
