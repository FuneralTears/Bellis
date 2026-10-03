import type { ComponentPropsWithoutRef } from "react";

/**
 * Isotype: the four shaded leaves, served as a single vector asset
 * (public/brand/bellis-mark.svg) so every screen shows the same artwork.
 * public/favicon.svg carries the same drawing on a cream tile.
 */
export function BellisMark({ className = "", ...props }: ComponentPropsWithoutRef<"img">) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/bellis-mark.svg" alt="" aria-hidden="true" width={576} height={530} className={`bellis-mark ${className}`} {...props} />;
}

/** Horizontal logo. `size="sm"` is the compact version for sidebars and tight bars. */
export default function BellisLogo({ className = "", size = "md" }: { className?: string; size?: "md" | "sm" }) {
  return (
    <span className={`bellis-logo ${size === "sm" ? "bellis-logo-sm " : ""}${className}`}>
      <BellisMark className="bellis-logo-mark" />
      <span className="bellis-wordmark">bellis<span className="bellis-wordmark-dot">.</span></span>
    </span>
  );
}
