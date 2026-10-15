import type { ReactNode } from "react";
import { cn } from "../lib/cn";

// Links styled as the design system's buttons: one tide primary per view,
// and quiet secondary actions.

export function PrimaryLink({
  href,
  children,
  className,
  inverse = false,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  /** On a tide ground: a white button with a tide label. */
  inverse?: boolean;
}) {
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener" } : {})}
      className={cn(
        "group inline-flex min-h-12 items-center whitespace-nowrap justify-center gap-2 rounded-lg px-6 text-base font-semibold transition-[transform,background-color,box-shadow] duration-200 ease-out-expo active:scale-[0.98]",
        inverse
          ? "bg-white text-[#0b6b62] hover:bg-white/90 focus-visible:outline-white"
          : "bg-tide text-on-tide shadow-soft hover:shadow-lift hover:brightness-110",
        className,
      )}
    >
      {children}
      <span
        aria-hidden="true"
        className="transition-transform duration-200 ease-out-expo group-hover:translate-x-0.5"
      >
        ›
      </span>
    </a>
  );
}

export function SecondaryLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      className={cn(
        "inline-flex min-h-12 items-center justify-center whitespace-nowrap rounded-lg border border-line-strong/60 px-6 text-base font-medium text-ink transition-colors duration-200 hover:border-tide hover:text-tide",
        className,
      )}
    >
      {children}
    </a>
  );
}
