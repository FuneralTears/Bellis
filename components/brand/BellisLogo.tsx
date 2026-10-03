import type { ComponentPropsWithoutRef } from "react";

/** Editable geometric mark: growth and connection, with no floral motif. */
export function BellisMark(props: ComponentPropsWithoutRef<"svg">) {
  return (
    <svg viewBox="0 0 32 36" fill="none" aria-hidden="true" {...props}>
      <path d="M3 4h6a7 7 0 0 1 7 7v10H10a7 7 0 0 1-7-7V4Z" fill="var(--primary)" />
      <path d="M29 2h-6a7 7 0 0 0-7 7v9h6a7 7 0 0 0 7-7V2Z" fill="var(--logo-beige)" />
      <path d="M3 23h6a7 7 0 0 1 7 7v4h-6a7 7 0 0 1-7-7v-4Z" fill="var(--sage)" />
      <path d="M29 20h-6a7 7 0 0 0-7 7v7h6a7 7 0 0 0 7-7v-7Z" fill="#176B70" />
    </svg>
  );
}

export default function BellisLogo({ className = "" }: { className?: string }) {
  return (
    <span className={`bellis-logo ${className}`}>
      <BellisMark className="bellis-logo-mark" />
      <span className="bellis-wordmark">bellis.</span>
    </span>
  );
}
