/**
 * Adapted from Kokonut UI "Typewriter" v1.1.0 by @dorianbaffier (MIT)
 * https://kokonutui.com · https://github.com/kokonut-labs/kokonutui
 *
 * Landing page only: types one message into the demo's Telegram composer.
 * Kept from the original: the seeded natural variance between keystrokes and
 * the caret that stays solid while keys are hit and blinks once idle (the
 * `omd-caret` keyframes in styles.css). Changes: a hook instead of a title
 * component, one phrase, no loop or deleting, no typos, and a `done` flag so
 * the demo can send the message when typing ends.
 */
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

const CARET_IDLE_MS = 500;

/** Small seeded generator (Park-Miller), 0 to 1. */
function createRandom(seed: number) {
  let state = (Math.abs(Math.floor(seed)) % 2_147_483_646) + 1;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

function typingDelay(speed: number, random: () => number) {
  const roll = random();
  if (roll < 0.1) return speed * 2;
  if (roll > 0.9) return speed * 0.5;
  return speed * (0.6 + random() * 0.8);
}

export interface Typed {
  shown: string;
  done: boolean;
  /** True for a moment after each keystroke; the caret blinks once it is false. */
  busy: boolean;
}

/**
 * Types `text` while `active`; shows it whole when `complete` (a step already
 * passed) or when the visitor prefers reduced motion, and nothing otherwise.
 */
export function useTypewriter(
  text: string,
  {
    active,
    complete,
    speed = 55,
    seed = 7,
  }: { active: boolean; complete: boolean; speed?: number; seed?: number },
): Typed {
  const reduce = useReducedMotion();
  const [count, setCount] = useState(complete ? text.length : 0);
  const [busy, setBusy] = useState(false);
  const random = useRef(createRandom(seed));

  useEffect(() => {
    if (complete || (active && reduce)) {
      setCount(text.length);
      return;
    }
    if (!active) {
      setCount(0);
      return;
    }
    random.current = createRandom(seed);
    let typed = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    setCount(0);
    const next = () => {
      typed += 1;
      setCount(typed);
      setBusy(true);
      clearTimeout(idle);
      idle = setTimeout(() => setBusy(false), CARET_IDLE_MS);
      if (typed < text.length) timer = setTimeout(next, typingDelay(speed, random.current));
    };
    timer = setTimeout(next, 260);
    return () => {
      clearTimeout(timer);
      clearTimeout(idle);
      setBusy(false);
    };
  }, [active, complete, reduce, seed, speed, text]);

  return { shown: text.slice(0, count), done: count >= text.length, busy };
}
