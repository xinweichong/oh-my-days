import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "../lib/cn";
import { SPRING_LAND } from "../lib/ease";

// A week in Google Calendar, drawn simply: where captured events and task
// deadlines end up. Synthetic week of Mon 19 to Sun 25 Oct 2026.

const DAYS = [
  { name: "Mon", date: 19 },
  { name: "Tue", date: 20 },
  { name: "Wed", date: 21 },
  { name: "Thu", date: 22 },
  { name: "Fri", date: 23 },
  { name: "Sat", date: 24 },
  { name: "Sun", date: 25 },
];
const FIRST_HOUR = 8;
const HOURS = 12;
const HOUR_INDEXES = Array.from({ length: HOURS }, (_, h) => h);

interface Block {
  id: string;
  day: number;
  start: number;
  end: number;
  title: string;
  kind: "existing" | "new" | "deadline";
}

const EXISTING: Block[] = [
  ...[0, 1, 2, 3, 4].map((day) => ({
    id: `standup-${day}`,
    day,
    start: 9.5,
    end: 10,
    title: "Standup",
    kind: "existing" as const,
  })),
  { id: "lunch", day: 1, start: 12.5, end: 13.5, title: "Lunch", kind: "existing" },
  { id: "gym-mon", day: 0, start: 18, end: 19, title: "Gym", kind: "existing" },
  { id: "gym-wed", day: 2, start: 18, end: 19, title: "Gym", kind: "existing" },
];

const DENTIST: Block = { id: "dentist", day: 3, start: 10, end: 11, title: "Dentist", kind: "new" };
const INVOICE: Block = {
  id: "invoice",
  day: 4,
  start: 15,
  end: 15.5,
  title: "Send invoice",
  kind: "deadline",
};

export interface CalendarState {
  dentist: boolean;
  invoice: boolean;
  /** The 8am agenda: today (Friday) is lit and its items are pointed out. */
  today: boolean;
  /** The reminder for Send invoice has been snoozed to Sat 8am. */
  snoozed: boolean;
}

export function CalendarWeek({ state, className }: { state: CalendarState; className?: string }) {
  const reduce = useReducedMotion();
  const blocks = [
    ...EXISTING,
    ...(state.dentist ? [DENTIST] : []),
    ...(state.invoice ? [INVOICE] : []),
  ];
  return (
    <figure
      className={cn(
        "flex flex-col overflow-hidden rounded-[22px] border border-line bg-raised shadow-lift",
        className,
      )}
    >
      <figcaption className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
        <span className="text-[15px] font-semibold text-ink">Google Calendar</span>
        <span className="text-[13px] text-muted">19–25 Oct 2026</span>
      </figcaption>
      <div className="grid grid-cols-[2.25rem_repeat(7,minmax(0,1fr))] border-b border-line text-center">
        <span />
        {DAYS.map((d, i) => (
          <span key={d.name} className="flex flex-col items-center py-2">
            <span className="text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">
              {d.name}
            </span>
            <span
              className={cn(
                "mt-0.5 grid size-7 place-items-center rounded-full text-[14px] tabular-nums transition-colors duration-300",
                state.today && i === 4 ? "bg-tide font-semibold text-on-tide" : "text-ink",
              )}
            >
              {d.date}
            </span>
          </span>
        ))}
      </div>
      <div className="relative grid min-h-0 flex-1 grid-cols-[2.25rem_repeat(7,minmax(0,1fr))]">
        <div className="relative">
          {HOUR_INDEXES.map((h) => (
            <span
              key={h}
              className="absolute right-1.5 -translate-y-1/2 text-[10px] text-muted tabular-nums"
              style={{ top: `${(h / HOURS) * 100}%` }}
            >
              {h === 0 ? "" : hourLabel(FIRST_HOUR + h)}
            </span>
          ))}
        </div>
        {DAYS.map((d, i) => (
          <div
            key={d.name}
            className={cn(
              "relative border-l border-line transition-colors duration-500",
              state.today && i === 4 && "bg-tide-soft/60",
            )}
          >
            {HOUR_INDEXES.slice(1).map((h) => (
              <span
                key={h}
                aria-hidden="true"
                className="absolute inset-x-0 border-t border-line/60"
                style={{ top: `${(h / HOURS) * 100}%` }}
              />
            ))}
          </div>
        ))}
        <div className="pointer-events-none absolute inset-y-0 right-0 left-[2.25rem]">
          <AnimatePresence initial={false}>
            {blocks.map((b) => (
              <motion.div
                key={b.id}
                initial={
                  b.kind === "existing" || reduce ? false : { opacity: 0, y: -18, scale: 0.9 }
                }
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
                transition={{ ...SPRING_LAND, delay: 0.05 }}
                className={cn(
                  "absolute overflow-hidden rounded-md px-1 py-0.5 text-left text-[10.5px] leading-[13px] font-medium text-ellipsis whitespace-nowrap",
                  b.kind === "existing" && "bg-sunk text-muted",
                  b.kind === "new" && "bg-tide text-on-tide shadow-soft",
                  b.kind === "deadline" && "border border-dashed border-tide bg-raised text-tide",
                  state.today && b.day === 4 && b.kind !== "new" && "ring-2 ring-tide/50",
                )}
                style={{
                  left: `calc(${(b.day / 7) * 100}% + 2px)`,
                  width: `calc(${100 / 7}% - 4px)`,
                  top: `${((b.start - FIRST_HOUR) / HOURS) * 100}%`,
                  height: `${((b.end - b.start) / HOURS) * 100}%`,
                  minHeight: "17px",
                }}
              >
                {b.title}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-tide" aria-hidden="true" /> Personal
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-sm border border-dashed border-tide"
            aria-hidden="true"
          />{" "}
          Tasks - Oh My Days
        </span>
        <AnimatePresence>
          {state.invoice ? (
            <motion.span
              key="reminder"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="ml-auto inline-flex items-center gap-1.5 text-ink"
            >
              Next reminder:
              <span className="relative inline-grid">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={state.snoozed ? "sat" : "fri"}
                    initial={reduce ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
                    transition={SPRING_LAND}
                    className={cn("font-semibold", state.snoozed && "text-tide")}
                  >
                    {state.snoozed ? "Sat 8am" : "Fri 2pm"}
                  </motion.span>
                </AnimatePresence>
              </span>
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>
    </figure>
  );
}

function hourLabel(hour: number): string {
  if (hour === 12) return "12pm";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}
