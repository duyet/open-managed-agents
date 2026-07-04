/**
 * Brand mark — `[•]` logo. Inlined as React SVG (no `<img>` round-trip and
 * no width/height-attr-vs-CSS-class mismatch that previously caused an 8-px
 * collapse on first paint when CSS resized 32×32 → 24×24).
 *
 * Artwork copied verbatim from `public/logo.svg`: square brackets (the
 * harness) wrapping a dot (the agent it runs). Brackets are drawn as vector
 * paths, so the mark is font-independent and renders identically everywhere.
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
      viewBox="0 0 64 64"
      role="img"
      aria-label="oma"
      className={`shrink-0 ${className}`.trim()}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g
        fill="none"
        stroke="#FF6B50"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M24 15 H15 V49 H24" />
        <path d="M40 15 H49 V49 H40" />
      </g>
      <circle cx="32" cy="32" r="8" fill="#FF6B50" />
    </svg>
  );
}
