import { useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { TELEGRAM_URL } from "../content";
import { Timeline, TimelineItem } from "../vendor/origin/Timeline";

const STEPS = [
  {
    title: "Open the bot in Telegram",
    body: (
      <>
        Send <span className="font-medium text-ink">/start</span>. Oh My Days answers accounts on
        its invitation list; ask the person who runs it to add you.
      </>
    ),
  },
  {
    title: "Connect Google Calendar",
    body: "The bot sends a link. Sign in with Google in the browser, review the access, and come back to the chat.",
  },
  {
    title: "Choose your calendars",
    body: "Pick the calendars to include and a default for new events, and confirm your timezone. Task deadlines get their own calendar, Tasks - Oh My Days.",
  },
];

/**
 * Origin UI's timeline: the steps light in turn as the list comes into view.
 * They stay numbered, never ticked: the visitor has not done them yet.
 */
export function Setup() {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.5 });
  const [done, setDone] = useState(0);
  useEffect(() => {
    if (!seen) return;
    const timers = STEPS.map((_, i) => setTimeout(() => setDone(i + 1), 250 + i * 650));
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [seen]);
  return (
    <section aria-labelledby="setup-title" className="border-t border-line">
      <div className="mx-auto grid max-w-[76rem] gap-12 px-4 py-20 sm:px-6 md:grid-cols-12 md:gap-8 md:px-8 md:py-28">
        <div className="md:col-span-5">
          <h2
            id="setup-title"
            className="font-display text-4xl leading-[1.05] font-semibold tracking-[-0.025em] text-ink md:text-5xl"
          >
            Set up in the chat.
          </h2>
          <p className="mt-4 max-w-[36ch] text-lg leading-7 text-muted">
            A few minutes, one choice at a time. Google sign-in is the only step outside Telegram.
          </p>
          <a
            href={TELEGRAM_URL}
            target="_blank"
            rel="noopener"
            className="mt-6 inline-flex min-h-11 items-center font-semibold text-tide underline decoration-tide/40 hover:decoration-tide"
          >
            Open the bot ›
          </a>
        </div>
        <div ref={ref} className="md:col-span-7 md:pt-2">
          <Timeline>
            {STEPS.map((s, i) => (
              <TimelineItem
                key={s.title}
                completed={i < done}
                last={i === STEPS.length - 1}
                indicator={i + 1}
                title={s.title}
              >
                {s.body}
              </TimelineItem>
            ))}
          </Timeline>
        </div>
      </div>
    </section>
  );
}
