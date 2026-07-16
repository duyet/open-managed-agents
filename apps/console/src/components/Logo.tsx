/**
 * oma brand mark — 2026 redesign.
 *
 * Retires the old bracket-dot "[•]" motif for a sharper, single geometric
 * glyph (ported from the marketing site's Logo.astro): a rounded-square
 * *frame* (the environment / sandbox) with an edge running in from the
 * top-left corner into a solid *node* at the center (the managed agent a
 * request lands on). It reads as "a request wired into an agent inside its
 * durable frame" — the whole product in one mark.
 *
 * Drawn with `currentColor` so it's theme-aware: the default `text-brand`
 * paints it iris in both light and dark; pass a `className` with a different
 * text color to override (e.g. on a colored surface). Stroke geometry stays
 * crisp at any size.
 */
const SIZE_PX = {
  sm: 24,
  md: 28,
  lg: 32,
} as const;

interface LogoProps {
  size?: keyof typeof SIZE_PX;
  className?: string;
}

export function Logo({ size = "sm", className = "" }: LogoProps) {
  const px = SIZE_PX[size];
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label="oma"
      className={`shrink-0 text-brand ${className}`.trim()}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="3.25"
        y="3.25"
        width="17.5"
        height="17.5"
        rx="5"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M7 7 11 11"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="2.75" fill="currentColor" />
    </svg>
  );
}
