/**
 * Adapted from beUI "Checkbox" (beui.dev/components/motion/checkbox).
 * Copyright beUI; used under the beUI license, which permits modification and
 * commercial use with this notice kept.
 *
 * Landing page only. Changes: drawn as the Oh My Days check circle (the design
 * system's `check-size`, tide fill, ✓ in `on-tide`) inside a 44px target; no
 * indeterminate state; the label is the task title, which mutes when checked.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId } from "react";
import { cn } from "../../lib/cn";
import { EASE_OUT, SPRING_PRESS } from "../../lib/ease";

const CHECK_PATH = "M6.5 12.5l3.5 3.5 7.5-8";

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  /** Supporting text under the label, such as the deadline. */
  description?: string;
  className?: string;
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  description,
  className,
}: CheckboxProps) {
  const id = useId();
  const reduce = useReducedMotion();
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <label htmlFor={id} className={cn("flex cursor-pointer items-center gap-1", className)}>
      <motion.button
        id={id}
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-describedby={descriptionId}
        onClick={() => onCheckedChange(!checked)}
        whileTap={reduce ? undefined : { scale: 0.88 }}
        transition={SPRING_PRESS}
        className="-m-2.5 grid size-11 shrink-0 place-items-center rounded-full"
      >
        <span
          className={cn(
            "grid size-6 place-items-center rounded-full border-2 transition-colors duration-150",
            checked ? "border-tide bg-tide text-on-tide" : "border-line-strong bg-transparent",
          )}
        >
          <AnimatePresence initial={false}>
            {checked ? (
              <motion.svg
                key="check"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.5, filter: "blur(3px)" }}
                transition={reduce ? { duration: 0 } : { duration: 0.12, ease: EASE_OUT }}
              >
                <motion.path
                  d={CHECK_PATH}
                  initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={
                    reduce ? { duration: 0 } : { duration: 0.24, ease: EASE_OUT, delay: 0.04 }
                  }
                />
              </motion.svg>
            ) : null}
          </AnimatePresence>
        </span>
      </motion.button>
      <span className="ml-3 flex min-w-0 flex-col">
        <span
          className={cn(
            "text-[17px] leading-[22px] font-medium transition-colors duration-200",
            checked ? "text-muted" : "text-ink",
          )}
        >
          {label}
        </span>
        {description ? (
          <span id={descriptionId} className="text-sm text-muted">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}
