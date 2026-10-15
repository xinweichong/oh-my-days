import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { SPRING_LAND } from "../lib/ease";

// A Telegram conversation drawn in the Oh My Days palette: the bot's messages
// on the left with their buttons beneath, yours on the right. Text is the bot's
// real wording; times and dates are synthetic.

export function ChatFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-[22px] border border-line bg-chat shadow-lift",
        className,
      )}
    >
      <div className="flex items-center gap-3 border-b border-line bg-raised px-4 py-3">
        <span className="grid size-9 place-items-center rounded-full bg-tide-soft">
          <svg viewBox="0 0 64 64" className="h-6 w-6" aria-hidden="true">
            <path d="M17 34a15 15 0 0 1 30 0z" fill="#f2a32c" />
            <path
              d="M10 43H54"
              fill="none"
              strokeWidth="6"
              strokeLinecap="round"
              className="stroke-tide"
            />
          </svg>
        </span>
        <span className="flex flex-col leading-tight">
          <span className="text-[15px] font-semibold text-ink">Oh My Days</span>
          <span className="text-[13px] text-muted">bot</span>
        </span>
      </div>
      {children}
    </div>
  );
}

export function DayLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center py-1">
      <span className="rounded-full bg-raised/80 px-2.5 py-0.5 text-[12px] font-medium text-muted">
        {children}
      </span>
    </div>
  );
}

export function Bubble({
  from,
  time,
  children,
  buttons,
  pressed,
  className,
}: {
  from: "me" | "bot";
  time: string;
  children: ReactNode;
  /** Inline keyboard rows under a bot message. */
  buttons?: readonly (readonly string[])[];
  /** The button shown as just pressed. */
  pressed?: string | null;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const mine = from === "me";
  return (
    <motion.div
      layout={reduce ? false : "position"}
      initial={reduce ? false : { opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={SPRING_LAND}
      style={{ originX: mine ? 1 : 0, originY: 1 }}
      className={cn(
        "flex max-w-[88%] flex-col gap-1",
        mine ? "self-end items-end" : "self-start",
        className,
      )}
    >
      <div
        className={cn(
          "whitespace-pre-line rounded-2xl px-3 pt-2 pb-1.5 text-[15px] leading-[21px] text-ink shadow-[0_1px_1px_rgb(0_0_0/0.06)]",
          mine ? "rounded-br-md bg-bubble-out" : "rounded-bl-md bg-raised",
        )}
      >
        {children}
        <span className="ml-2 inline-block translate-y-0.5 text-[11px] text-muted">{time}</span>
      </div>
      {buttons?.map((row) => (
        <div key={row.join("|")} className="flex w-full gap-1">
          {row.map((label) => (
            <span
              key={label}
              className={cn(
                "flex min-h-9 flex-1 items-center justify-center rounded-lg px-3 text-center text-[14px] font-medium transition-colors duration-200",
                pressed === label ? "bg-tide text-on-tide" : "bg-raised/70 text-tide",
              )}
            >
              {label}
            </span>
          ))}
        </div>
      ))}
    </motion.div>
  );
}

export function TypingDots() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.1 } }}
      className="omd-typing flex w-fit items-center gap-1 self-start rounded-2xl rounded-bl-md bg-raised px-3.5 py-3"
      aria-hidden="true"
    >
      <span className="size-1.5 rounded-full bg-muted" />
      <span className="size-1.5 rounded-full bg-muted" />
      <span className="size-1.5 rounded-full bg-muted" />
    </motion.div>
  );
}

/** The message box, showing what is being typed with a Kokonut-style caret. */
export function Composer({ text, busy }: { text: string; busy: boolean }) {
  return (
    <div className="flex items-center gap-2 border-t border-line bg-raised px-3 py-2.5">
      <div className="flex min-h-10 flex-1 items-center rounded-full bg-sunk px-4 text-[15px]">
        {text ? (
          <span className="text-ink">
            {text}
            <span className="relative inline-block w-0">
              <span
                className="omd-caret absolute -bottom-0.5 left-px h-[1.1em] w-[2px] bg-tide"
                data-idle={busy ? "false" : "true"}
              />
            </span>
          </span>
        ) : (
          <span className="text-muted">Message</span>
        )}
      </div>
      <span
        className={cn(
          "grid size-10 place-items-center rounded-full transition-colors duration-200",
          text ? "bg-tide text-on-tide" : "bg-sunk text-muted",
        )}
        aria-hidden="true"
      >
        <svg
          viewBox="0 0 20 20"
          className="h-[18px] w-[18px]"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M3.4 16.6 17.5 10 3.4 3.4l.1 5.1L13 10l-9.5 1.5z" />
        </svg>
      </span>
    </div>
  );
}
