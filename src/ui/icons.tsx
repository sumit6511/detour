import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Svg(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export const IconStep = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="14" r="5" />
    <path d="M12 2v5M9 4.5 12 2l3 2.5" />
  </Svg>
);

export const IconBarricade = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="7" width="19" height="7" rx="1.5" />
    <path d="M7 7l-3.5 7M12.5 7 9 14M18 7l-3.5 7M5 14v6M19 14v6" />
  </Svg>
);

export const IconRotate = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </Svg>
);

export const IconUndo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);

export const IconFlag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
  </Svg>
);

export const IconRoute = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="5" r="2" />
    <path d="M8 19h6.5a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H16" strokeDasharray="2 3" />
  </Svg>
);

export const IconBack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 18 9 12l6-6" />
  </Svg>
);

export const IconShuffle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
  </Svg>
);

export const IconRestart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </Svg>
);

/** The bent arrow from a detour sign, drawn solid for the wordmark. */
export const DetourArrow = (p: IconProps) => (
  <svg viewBox="0 0 48 40" aria-hidden="true" {...p}>
    <path
      d="M4 34V20a8 8 0 0 1 8-8h20V4l14 13-14 13v-8H16a2 2 0 0 0-2 2v10z"
      fill="currentColor"
    />
  </svg>
);
