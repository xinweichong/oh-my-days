import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

/**
 * Plays a short scripted sequence: returns how many of `delays` have elapsed
 * since `active` turned on. A sequence that is `complete` (its step has been
 * scrolled past) shows its end at once, and one that is not active rests at 0.
 * With reduced motion the end shows as soon as the sequence starts. Pass a
 * constant `delays` array, so the sequence does not restart on every render.
 */
export function usePhases(delays: readonly number[], active: boolean, complete: boolean): number {
  const reduce = useReducedMotion();
  const end = delays.length;
  const [phase, setPhase] = useState(complete ? end : 0);

  useEffect(() => {
    if (complete || (active && reduce)) {
      setPhase(end);
      return;
    }
    if (!active) {
      setPhase(0);
      return;
    }
    setPhase(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let at = 0;
    delays.forEach((delay, i) => {
      at += delay;
      timers.push(setTimeout(() => setPhase(i + 1), at));
    });
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [active, complete, reduce, end, delays]);

  return phase;
}
