import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { TAGLINE, TELEGRAM_URL, THOUGHTS, type Thought } from "../content";
import { cn } from "../lib/cn";
import { TopoBackground } from "../vendor/kokonut/TopoBackground";
import { CountLine } from "./Count";
import { PrimaryLink, SecondaryLink } from "./Links";

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden">
      <div className="mx-auto grid max-w-[76rem] grid-cols-[minmax(0,1fr)] gap-10 px-4 pt-10 pb-14 sm:px-6 md:gap-12 md:px-8 md:pt-16 md:pb-20 lg:min-h-[min(calc(100svh-4rem),56rem)] lg:grid-cols-12 lg:items-center lg:gap-6 lg:py-16">
        <div className="relative z-10 lg:col-span-5">
          <h1
            id="hero-title"
            className="font-display text-[2.6rem] leading-[1.02] font-semibold tracking-[-0.03em] text-ink xs:text-5xl md:max-w-[14ch] md:text-[4.25rem] lg:text-[4.5rem]"
          >
            {TAGLINE}
          </h1>
          <p className="mt-5 max-w-[34ch] text-lg leading-7 text-muted md:mt-6 md:text-xl md:leading-8">
            Oh My Days turns Telegram messages into events, tasks and reminders, and keeps them in
            your Google Calendar.
          </p>
          <div className="mt-7 flex flex-col gap-3 xs:flex-row xs:items-center md:mt-9">
            <PrimaryLink href={TELEGRAM_URL}>Open in Telegram</PrimaryLink>
            <SecondaryLink href="#how">See how it works</SecondaryLink>
          </div>
          <p className="mt-5 text-sm text-muted">
            By invitation only. No ads, and data is never sold.
          </p>
        </div>
        <div className="relative min-w-0 lg:col-span-7">
          <FieldDesktop />
          <FieldPhone />
        </div>
      </div>
    </section>
  );
}

/** Desktop: the thoughts drift in an open field over tide lines. */
function FieldDesktop() {
  return (
    <div className="relative hidden aspect-[7/6] max-h-[40rem] w-full lg:block">
      <div className="absolute -inset-x-16 -inset-y-10 text-tide">
        <TopoBackground />
      </div>
      <ul aria-label="Things in your head, for example" className="absolute inset-0">
        {THOUGHTS.map((t, i) => (
          <li key={t.id} className="absolute" style={{ left: `${t.x}%`, top: `${t.y}%` }}>
            <Drift index={i}>
              <ThoughtChip thought={t} />
            </Drift>
          </li>
        ))}
      </ul>
      <CountLine value={THOUGHTS.length} className="absolute bottom-0 left-0" />
    </div>
  );
}

/** Phones and tablets: two slow rows of thoughts under the headline, then the count. */
function FieldPhone() {
  const reduce = useReducedMotion();
  const rows = [THOUGHTS.slice(0, 5), THOUGHTS.slice(5)];
  return (
    <div className="relative -mx-4 sm:-mx-6 md:-mx-8 lg:hidden">
      <ul aria-label="Things in your head, for example" className="sr-only">
        {THOUGHTS.map((t) => (
          <li key={t.id}>{t.text}</li>
        ))}
      </ul>
      <div
        aria-hidden="true"
        className="flex flex-col gap-3 overflow-hidden py-2 [mask-image:linear-gradient(to_right,transparent,#000_8%,#000_92%,transparent)]"
      >
        {rows.map((row, r) => (
          <motion.div
            key={row[0]?.id}
            className="flex w-max gap-3 pl-4 sm:pl-6 md:pl-8"
            animate={reduce ? undefined : { x: r === 0 ? ["0%", "-50%"] : ["-50%", "0%"] }}
            transition={{ duration: 38 + r * 8, ease: "linear", repeat: Number.POSITIVE_INFINITY }}
          >
            {/* Two copies, so the loop never shows a gap. */}
            {row.map((t) => (
              <ThoughtChip key={t.id} thought={t} />
            ))}
            {row.map((t) => (
              <ThoughtChip key={`${t.id}-again`} thought={t} />
            ))}
          </motion.div>
        ))}
      </div>
      <CountLine value={THOUGHTS.length} className="mt-4 px-4 sm:px-6 md:px-8" />
    </div>
  );
}

/** Each thought bobs on its own slow loop, so the field never moves in step. */
function Drift({ index, children }: { index: number; children: ReactNode }) {
  const reduce = useReducedMotion();
  const dx = index % 2 === 0 ? 6 : -5;
  const dy = index % 3 === 0 ? -9 : 7;
  return (
    <motion.div
      // No entrance fade: the field is visible before the script runs.
      animate={reduce ? undefined : { x: [0, dx, 0], y: [0, dy, 0] }}
      transition={{
        x: { duration: 7 + (index % 4), repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" },
        y: { duration: 6 + (index % 5) * 0.8, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" },
      }}
    >
      {children}
    </motion.div>
  );
}

export function ThoughtChip({ thought, className }: { thought: Thought; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-10 items-center rounded-full border border-line bg-raised/95 px-4 text-[15px] whitespace-nowrap text-ink shadow-soft transition-[transform,box-shadow] duration-300 ease-out-expo hover:-translate-y-0.5 hover:shadow-lift",
        className,
      )}
      style={{ rotate: `${thought.tilt}deg` }}
    >
      {thought.text}
    </span>
  );
}
