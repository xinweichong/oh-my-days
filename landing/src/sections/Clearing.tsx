import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { THOUGHTS, WALKTHROUGH_IDS } from "../content";
import { cn } from "../lib/cn";
import { SPRING_LAND } from "../lib/ease";
import { CountLine } from "./Count";

const REST = THOUGHTS.filter((t) => !(WALKTHROUGH_IDS as readonly string[]).includes(t.id));
const STEP_MS = 520;

/**
 * The other eight, captured one after another once the list is in view:
 * each half-thought becomes the message that adds it and the bot's reply,
 * and the count runs down to nothing.
 */
export function Clearing() {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.35 });
  const reduce = useReducedMotion();
  const [done, setDone] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (reduce) {
      setDone(REST.length);
      return;
    }
    const timers = REST.map((_, i) => setTimeout(() => setDone(i + 1), 500 + i * STEP_MS));
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [seen, reduce]);

  return (
    <section aria-labelledby="clearing-title" className="border-t border-line">
      <div
        ref={ref}
        className="mx-auto grid max-w-[76rem] gap-10 px-4 py-20 sm:px-6 md:grid-cols-12 md:gap-8 md:px-8 md:py-28"
      >
        <div className="md:col-span-5 md:self-start md:pt-2 lg:sticky lg:top-28">
          <h2
            id="clearing-title"
            className="font-display text-4xl leading-[1.05] font-semibold tracking-[-0.025em] text-ink md:text-5xl"
          >
            And the other eight.
          </h2>
          <p className="mt-4 max-w-[38ch] text-lg leading-7 text-muted">
            Plain messages, one instruction each. If a detail is missing, I ask for that and nothing
            else.
          </p>
          <CountLine value={THOUGHTS.length - WALKTHROUGH_IDS.length - done} className="mt-8" />
        </div>
        <ul className="flex flex-col md:col-span-7">
          {REST.map((t, i) => {
            const captured = i < done;
            return (
              <li
                key={t.id}
                className="flex min-h-[4.75rem] items-center border-b border-line py-3 last:border-0"
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  {captured ? (
                    <motion.div
                      key="captured"
                      initial={reduce ? false : { opacity: 0, y: 12, filter: "blur(4px)" }}
                      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                      transition={SPRING_LAND}
                      className="flex w-full flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-6"
                    >
                      <span className="shrink-0 text-[15px] font-medium text-tide sm:w-52">
                        {t.message}
                      </span>
                      <span className="flex flex-col text-[15px] leading-[21px]">
                        <span className="text-ink">
                          <span aria-hidden="true" className="mr-1.5 text-tide">
                            ✓
                          </span>
                          {t.reply.split("\n")[0]}
                        </span>
                        <span className="text-muted">{t.reply.split("\n").slice(1).join(" ")}</span>
                      </span>
                    </motion.div>
                  ) : (
                    <motion.span
                      key="thought"
                      exit={
                        reduce
                          ? { opacity: 0 }
                          : {
                              opacity: 0,
                              x: 16,
                              filter: "blur(4px)",
                              transition: { duration: 0.18 },
                            }
                      }
                      className={cn(
                        "inline-flex min-h-10 items-center rounded-full border border-line bg-raised px-4 text-[15px] text-ink shadow-soft",
                      )}
                      style={{ rotate: `${t.tilt * 0.6}deg` }}
                    >
                      {t.text}
                    </motion.span>
                  )}
                </AnimatePresence>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
