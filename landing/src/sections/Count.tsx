import { cn } from "../lib/cn";
import { SlidingNumber } from "../vendor/animate-ui/SlidingNumber";

/** "10 to keep in your head", rolling as thoughts are captured. */
export function CountLine({ value, className }: { value: number; className?: string }) {
  return (
    <p className={cn("flex items-baseline gap-2 text-ink", className)} aria-live="polite">
      {value === 0 ? (
        <span className="font-display text-lg font-semibold">Nothing to keep in your head.</span>
      ) : (
        <>
          <SlidingNumber
            value={value}
            className="font-display text-3xl leading-none font-semibold text-tide"
          />
          <span className="text-[15px] text-muted">to keep in your head</span>
        </>
      )}
    </p>
  );
}
