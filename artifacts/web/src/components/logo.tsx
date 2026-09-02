/**
 * The Email Watcher mark, inlined as SVG.
 *
 * Inlined rather than an <img src="/logo.svg"> so it renders in the same paint as
 * the surrounding chrome (no second request, no flash of missing icon) and can
 * inherit sizing from props. Kept in sync with public/logo.svg, which feeds the
 * favicon and PWA icons.
 */
export function Logo({
  className = "h-8 w-8",
  title = "Email Watcher",
}: {
  className?: string;
  /** Set to null for a purely decorative mark next to a visible wordmark. */
  title?: string | null;
}) {
  return (
    <svg
      viewBox="0 0 180 180"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? "img" : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        {/*
          userSpaceOnUse so the gap circle samples the same gradient coordinates
          as the background and the seam stays invisible.
        */}
        <linearGradient
          id="ew-logo-bg"
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="180"
          y2="180"
        >
          <stop offset="0" stopColor="#FF4356" />
          <stop offset="0.55" stopColor="#F12230" />
          <stop offset="1" stopColor="#B00F1C" />
        </linearGradient>
      </defs>

      <rect width="180" height="180" rx="40" fill="url(#ew-logo-bg)" />
      <rect x="30" y="54" width="112" height="76" rx="14" fill="#FFFFFF" />
      <path
        d="M42 68 L86 103 L130 68"
        stroke="#B00F1C"
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="146" cy="42" r="22" fill="url(#ew-logo-bg)" />
      <circle cx="146" cy="42" r="14" fill="#FFFFFF" />
    </svg>
  );
}
