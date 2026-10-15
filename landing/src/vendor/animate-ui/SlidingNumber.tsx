/**
 * Adapted from Animate UI "Sliding Number" (MIT), https://animate-ui.com
 *
 * Landing page only: the count of things left in your head. Kept from the
 * original: each decimal place is a spring-driven roller, with all ten digits
 * stacked and offset from the spring's current value, so a change rolls the
 * shortest way round. Changes: offsets in em instead of a measured height (no
 * react-use-measure), whole numbers only, no in-view trigger, and the value is
 * rendered at rest on first paint, so the prerendered page shows the real count.
 */
import { type MotionValue, motion, useReducedMotion, useSpring, useTransform } from "motion/react";
import { useEffect } from "react";
import { cn } from "../../lib/cn";

const SPRING = { stiffness: 200, damping: 20, mass: 0.4 };
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export function SlidingNumber({ value, className }: { value: number; className?: string }) {
  const text = String(Math.max(0, Math.floor(value)));
  return (
    <span className={cn("inline-flex tabular-nums", className)}>
      <span className="sr-only">{text}</span>
      {text.split("").map((_, i) => {
        const place = 10 ** (text.length - 1 - i);
        return <Roller key={place} value={value} place={place} />;
      })}
    </span>
  );
}

function Roller({ value, place }: { value: number; place: number }) {
  const reduce = useReducedMotion();
  const target = Math.floor(value / place) % 10;
  const spring = useSpring(target, reduce ? { duration: 0 } : SPRING);
  useEffect(() => {
    spring.set(target);
  }, [spring, target]);
  return (
    <span
      aria-hidden="true"
      className="relative inline-block w-[1ch] overflow-y-clip"
      style={{ height: "1em", lineHeight: 1 }}
    >
      <span className="invisible">0</span>
      {DIGITS.map((n) => (
        <Digit key={n} n={n} spring={spring} />
      ))}
    </span>
  );
}

function Digit({ n, spring }: { n: number; spring: MotionValue<number> }) {
  const y = useTransform(spring, (latest) => {
    const offset = (10 + n - (latest % 10)) % 10;
    return `${offset > 5 ? offset - 10 : offset}em`;
  });
  return (
    <motion.span className="absolute inset-0 flex items-center justify-center" style={{ y }}>
      {n}
    </motion.span>
  );
}
