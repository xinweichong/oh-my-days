import lockup from "../../../docs/identity/logo/oh-my-days-lockup.svg";
import mark from "../../../docs/identity/logo/oh-my-days-mark.svg";
import { cn } from "../lib/cn";

// The approved logo files, inlined so they take the page's colour versions:
// the default lockup on light grounds, the reversed one (white horizon and
// wordmark) on dark or tide grounds. The sun is always marigold and never moves.

export function Lockup({
  className,
  reversed = false,
}: {
  className?: string;
  reversed?: boolean;
}) {
  return (
    <span
      role="img"
      aria-label="Oh My Days"
      data-tone={reversed ? "reversed" : undefined}
      className={cn("omd-logo inline-block [&>svg]:block [&>svg]:h-full [&>svg]:w-auto", className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time logo file from docs/identity/logo.
      dangerouslySetInnerHTML={{ __html: lockup }}
    />
  );
}

export function Mark({ className, reversed = false }: { className?: string; reversed?: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-tone={reversed ? "reversed" : undefined}
      className={cn("omd-logo inline-block [&>svg]:block [&>svg]:h-full [&>svg]:w-auto", className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time logo file from docs/identity/logo.
      dangerouslySetInnerHTML={{ __html: mark }}
    />
  );
}
