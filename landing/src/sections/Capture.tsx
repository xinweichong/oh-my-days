import {
  AnimatePresence,
  motion,
  useInView,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
} from "motion/react";
import { type ReactNode, useRef, useState } from "react";
import { STEPS, THOUGHTS, thought } from "../content";
import { cn } from "../lib/cn";
import { EASE_OUT, SPRING_LAND } from "../lib/ease";
import { Checkbox } from "../vendor/beui/Checkbox";
import { CalendarWeek } from "./CalendarWeek";
import { ChatFrame, Composer } from "./Chat";
import { CountLine } from "./Count";
import { FINAL_PHASE, type Status, useStep } from "./script";

export function Capture() {
  return (
    <section
      id="how"
      aria-labelledby="how-title"
      className="scroll-mt-16 border-t border-line bg-sunk"
    >
      <div className="mx-auto max-w-[76rem] px-4 pt-20 sm:px-6 md:px-8 md:pt-28">
        <h2
          id="how-title"
          className="max-w-[18ch] font-display text-4xl leading-[1.05] font-semibold tracking-[-0.025em] text-ink md:text-6xl"
        >
          One message for each thing.
        </h2>
        <p className="mt-4 max-w-[46ch] text-lg leading-7 text-muted md:text-xl md:leading-8">
          Two of the ten, from your head to Google Calendar. The wording in the replies is what the
          bot actually sends.
        </p>
      </div>
      <Stage />
      <Stack />
    </section>
  );
}

const statusOf = (i: number, step: number): Status =>
  i < step ? "done" : i === step ? "active" : "idle";

/**
 * Tablet and desktop: the stage pins while the page scrolls past it, and each
 * stretch of scrolling plays one step. Scrolling back shows earlier steps
 * finished and later ones not yet started.
 */
function Stage() {
  const track = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(-1);
  const { scrollYProgress } = useScroll({ target: track, offset: ["start 64px", "end end"] });
  useMotionValueEvent(scrollYProgress, "change", (p) => {
    setStep(p <= 0 ? -1 : Math.min(STEPS.length - 1, Math.floor(p * STEPS.length)));
  });

  const views = [
    useStep(0, statusOf(0, step), true),
    useStep(1, statusOf(1, step), true),
    useStep(2, statusOf(2, step), true),
    useStep(3, statusOf(3, step), true),
  ] as const;
  const [event, task, agenda, snooze] = views;
  const landed = {
    dentist: event.phase >= (FINAL_PHASE[0] ?? 0),
    invoice: task.phase >= (FINAL_PHASE[1] ?? 0),
  };
  const shown = Math.max(step, 0);
  const caption = STEPS[shown] ?? STEPS[0];
  const composer = step === 1 ? task.composer : event.composer;

  const jump = (i: number) => {
    const el = track.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 64;
    const span = el.offsetHeight - window.innerHeight;
    window.scrollTo({ top: top + span * ((i + 0.15) / STEPS.length) });
  };

  return (
    <div
      ref={track}
      className="relative hidden md:block"
      style={{ height: `${STEPS.length * 95 + 30}svh` }}
    >
      <div className="sticky top-16 flex h-[calc(100svh-4rem)] max-h-[60rem] flex-col">
        <div className="mx-auto flex min-h-0 w-full max-w-[76rem] flex-1 flex-col gap-6 px-6 py-8 md:px-8 lg:py-10">
          <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
            <div className="min-h-[7.5rem] max-w-[40rem]">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={caption?.id}
                  initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
                  transition={{ duration: 0.3, ease: EASE_OUT }}
                >
                  <h3 className="font-display text-2xl font-semibold tracking-[-0.015em] text-ink lg:text-[2rem]">
                    {caption?.title}
                  </h3>
                  <p className="mt-2 max-w-[56ch] text-base leading-6 text-muted lg:text-lg lg:leading-7">
                    {caption?.body}
                  </p>
                </motion.div>
              </AnimatePresence>
            </div>
            <StepNav step={shown} onJump={jump} />
          </div>
          <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-5 md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:grid-cols-[16rem_minmax(0,22rem)_minmax(0,1fr)] lg:gap-6">
            <HeadPane
              dentist={stateOf(0, step, landed.dentist)}
              invoice={stateOf(1, step, landed.invoice)}
            />
            <ChatFrame className="min-h-0">
              <div className="flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-hidden px-3 py-3 [mask-image:linear-gradient(to_bottom,transparent,#000_3.5rem)]">
                <AnimatePresence initial={false} mode="popLayout">
                  {[...event.messages, ...task.messages, ...agenda.messages, ...snooze.messages]}
                </AnimatePresence>
              </div>
              <Composer text={composer.text} busy={composer.busy} />
            </ChatFrame>
            <CalendarWeek
              className="min-h-0"
              state={{
                dentist: landed.dentist,
                invoice: landed.invoice,
                today: agenda.phase >= (FINAL_PHASE[2] ?? 0),
                snoozed: snooze.phase >= (FINAL_PHASE[3] ?? 0),
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

type ChipState = "waiting" | "active" | "captured";

function stateOf(i: number, step: number, landed: boolean): ChipState {
  if (landed) return "captured";
  return i === step ? "active" : "waiting";
}

/** Large screens: the things in your head, two of them being captured. */
function HeadPane({ dentist, invoice }: { dentist: ChipState; invoice: ChipState }) {
  const count =
    THOUGHTS.length - (dentist === "captured" ? 1 : 0) - (invoice === "captured" ? 1 : 0);
  const states: Record<string, ChipState> = { dentist, invoice };
  return (
    <div className="hidden min-h-0 flex-col gap-4 lg:flex">
      <CountLine value={count} />
      <ul className="flex min-h-0 flex-col gap-2 overflow-hidden [mask-image:linear-gradient(to_bottom,#000_70%,transparent)]">
        {THOUGHTS.map((t) => {
          const s = states[t.id] ?? "waiting";
          return (
            <li key={t.id}>
              <span className="flex items-center gap-2">
                <motion.span
                  layout
                  transition={SPRING_LAND}
                  className={cn(
                    "inline-flex min-h-9 items-center rounded-full border px-3.5 text-[14px] whitespace-nowrap transition-colors duration-300",
                    s === "waiting" && "border-line bg-raised text-ink",
                    s === "active" && "border-tide bg-raised text-ink ring-4 ring-tide/15",
                    s === "captured" &&
                      "border-transparent bg-transparent px-0 text-muted line-through decoration-tide/60",
                  )}
                >
                  {t.text}
                </motion.span>
                {s === "captured" ? (
                  <motion.span
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="text-[12px] font-semibold whitespace-nowrap text-tide"
                  >
                    ✓ {t.kind === "event" ? "Event" : "Task"}
                  </motion.span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StepNav({ step, onJump }: { step: number; onJump: (i: number) => void }) {
  const reduce = useReducedMotion();
  return (
    <nav
      aria-label="Walkthrough steps"
      className="flex gap-1 rounded-full bg-raised p-1 shadow-soft"
    >
      {STEPS.map((s, i) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onJump(i)}
          aria-current={i === step ? "step" : undefined}
          className={cn(
            "relative min-h-10 rounded-full px-4 text-sm font-medium transition-colors duration-200",
            i === step ? "text-on-tide" : "text-muted hover:text-ink",
          )}
        >
          {i === step ? (
            <motion.span
              layoutId="step-pill"
              transition={
                reduce
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 245, damping: 36, mass: 1.2 }
              }
              className="absolute inset-0 rounded-full bg-tide"
              aria-hidden="true"
            />
          ) : null}
          <span className="relative">{s.label}</span>
        </button>
      ))}
    </nav>
  );
}

/**
 * Phones: no pinning. Each step is a short self-contained scene that plays
 * once as it comes into view, with its result underneath.
 */
function Stack() {
  return (
    <ol className="mx-auto flex max-w-[34rem] flex-col gap-16 px-4 pt-12 pb-20 sm:px-6 md:hidden">
      {STEPS.map((s, i) => (
        <PhoneStep key={s.id} index={i} />
      ))}
    </ol>
  );
}

function PhoneStep({ index }: { index: number }) {
  const ref = useRef<HTMLLIElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.45 });
  const view = useStep(index, seen ? "active" : "idle", false);
  const step = STEPS[index];
  const done = view.phase >= (FINAL_PHASE[index] ?? 0);
  const t = index < 2 ? thought(index === 0 ? "dentist" : "invoice") : null;
  return (
    <li ref={ref} className="flex flex-col gap-4">
      <h3 className="font-display text-[1.65rem] leading-tight font-semibold tracking-[-0.015em] text-ink">
        {step?.title}
      </h3>
      <p className="text-base leading-6 text-muted">{step?.body}</p>
      {t ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          In your head:
          <span
            className={cn(
              "rounded-full border border-line bg-raised px-3 py-1 text-ink transition-all duration-500",
              view.phase >= 2 && "border-transparent bg-transparent text-muted line-through",
            )}
          >
            {t.text}
          </span>
        </p>
      ) : null}
      <ChatFrame className="min-h-[15rem]">
        <div className="flex flex-1 flex-col justify-end gap-2 px-3 py-3">
          <AnimatePresence initial={false} mode="popLayout">
            {view.messages}
          </AnimatePresence>
        </div>
        {index < 2 ? <Composer text={view.composer.text} busy={view.composer.busy} /> : null}
      </ChatFrame>
      <PhoneResult index={index} shown={done} />
    </li>
  );
}

function PhoneResult({ index, shown }: { index: number; shown: boolean }) {
  const reduce = useReducedMotion();
  const [checked, setChecked] = useState(false);
  let body: ReactNode = null;
  if (index === 0) {
    body = (
      <div className="flex items-center gap-3">
        <span className="h-10 w-1.5 rounded-full bg-tide" aria-hidden="true" />
        <span className="flex flex-col">
          <span className="text-[17px] font-medium text-ink">Dentist</span>
          <span className="text-sm text-muted">Thu 22 Oct, 10–11am · Personal</span>
        </span>
      </div>
    );
  } else if (index === 1) {
    body = (
      <Checkbox
        checked={checked}
        onCheckedChange={setChecked}
        label="Send invoice"
        description={checked ? "Completed" : "Due Fri 23 Oct, 3pm · Inbox"}
      />
    );
  } else if (index === 2) {
    // The agenda message is the result.
    return null;
  } else {
    body = (
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[15px]">
        <dt className="text-muted">Next reminder</dt>
        <dd className="text-ink">
          <s className="text-muted">Fri 2pm</s>{" "}
          <span className="font-semibold text-tide">Sat 8am</span>
        </dd>
        <dt className="text-muted">Deadline</dt>
        <dd className="text-ink">Fri 23 Oct, 3pm · unchanged</dd>
      </dl>
    );
  }
  const label = ["In Google Calendar", "In your Inbox list", "", "After snoozing"][index];
  return (
    <motion.div
      initial={false}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: reduce ? 1 : 0.35, y: reduce ? 0 : 6 }}
      transition={SPRING_LAND}
      className="rounded-xl border border-line bg-raised px-4 py-3"
    >
      <p className="mb-2 text-[12px] font-semibold tracking-[0.04em] text-muted uppercase">
        {label}
      </p>
      {body}
    </motion.div>
  );
}
