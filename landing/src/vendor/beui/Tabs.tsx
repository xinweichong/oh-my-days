/**
 * Adapted from beUI "Tabs" (beui.dev/components/motion/tabs).
 * Copyright beUI; used under the beUI license, which permits modification and
 * commercial use with this notice kept.
 *
 * Landing page only: switches the Mini App screens. Kept from the original:
 * the shared-layout pill that glides between tabs on a no-overshoot spring,
 * scoped with `layoutRoot` so page scroll never replays as movement. Changes:
 * the pill variant only, no overflow arrows, arrow-key navigation between
 * tabs, and the page's colour tokens.
 */
import { MotionConfig, motion, type Transition, useReducedMotion } from "motion/react";
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useId,
  useMemo,
} from "react";
import { cn } from "../../lib/cn";

interface Ctx {
  value: string;
  setValue: (value: string) => void;
  id: string;
}

const TabsContext = createContext<Ctx | null>(null);

function useTabs(): Ctx {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("Tab must be used inside Tabs");
  return ctx;
}

const glide: Transition = { type: "spring", stiffness: 245, damping: 36, mass: 1.2 };

export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const reduce = useReducedMotion();
  const ctx = useMemo(() => ({ value, setValue: onValueChange, id }), [value, onValueChange, id]);
  return (
    <MotionConfig transition={reduce ? { duration: 0 } : glide}>
      <TabsContext.Provider value={ctx}>
        <motion.div layoutRoot className={className}>
          {children}
        </motion.div>
      </TabsContext.Provider>
    </MotionConfig>
  );
}

export function TabsList({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  // Arrow keys move between tabs, as for any tab list.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    next?.focus();
    next?.click();
    event.preventDefault();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("inline-flex items-center gap-1 rounded-full bg-sunk p-1", className)}
    >
      {children}
    </div>
  );
}

export function Tab({ value, children }: { value: string; children: ReactNode }) {
  const tabs = useTabs();
  const selected = tabs.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${tabs.id}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${tabs.id}-panel`}
      tabIndex={selected ? 0 : -1}
      onClick={() => tabs.setValue(value)}
      className={cn(
        "relative min-h-11 rounded-full px-4 text-sm font-medium transition-colors duration-200",
        selected ? "text-ink" : "text-muted hover:text-ink",
      )}
    >
      {selected ? (
        <motion.span
          layoutId={`${tabs.id}-pill`}
          className="absolute inset-0 rounded-full bg-raised shadow-soft"
          aria-hidden="true"
        />
      ) : null}
      <span className="relative">{children}</span>
    </button>
  );
}

export function TabsPanel({ children, className }: { children: ReactNode; className?: string }) {
  const tabs = useTabs();
  return (
    <div
      role="tabpanel"
      id={`${tabs.id}-panel`}
      aria-labelledby={`${tabs.id}-tab-${tabs.value}`}
      className={className}
    >
      {children}
    </div>
  );
}
