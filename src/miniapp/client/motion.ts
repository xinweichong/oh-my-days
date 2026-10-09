import { spring } from "motion";
import { animate } from "motion/mini";

/**
 * Motion that explains what happened (design system: motion confirms actions
 * and shows where a screen came from). Everything is short, and under reduced
 * motion movement becomes a brief fade so feedback stays visible.
 */

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type Direction = "push" | "pop" | "swap";

/** A screen arriving: from the right when opened, from the left when going back. */
export function enterScreen(el: HTMLElement, direction: Direction): void {
  // A leftover transform, even an identity one, would widen the page sideways.
  const settle = () => {
    el.style.transform = "";
    el.style.opacity = "";
  };
  if (reducedMotion() || direction === "swap") {
    void Promise.resolve(animate(el, { opacity: [0, 1] }, { duration: 0.16, ease: "linear" })).then(
      settle,
    );
    return;
  }
  const from = direction === "push" ? 32 : -32;
  void Promise.resolve(
    animate(
      el,
      { transform: [`translateX(${from}px)`, "translateX(0px)"], opacity: [0, 1] },
      { duration: 0.24, ease: EASE_OUT },
    ),
  ).then(settle);
}

/** A row leaving the list after it was completed or cancelled. */
export async function collapse(el: HTMLElement): Promise<void> {
  if (reducedMotion()) {
    await animate(el, { opacity: [1, 0] }, { duration: 0.12 });
    return;
  }
  el.style.overflow = "hidden";
  await animate(
    el,
    { height: [`${el.offsetHeight}px`, "0px"], opacity: [1, 0] },
    { duration: 0.2, ease: EASE_OUT },
  );
}

/** Moves an element horizontally with a critically damped spring (no bounce). */
export function slideX(el: HTMLElement, from: number, to: number, velocity = 0): Promise<void> {
  if (reducedMotion()) {
    el.style.transform = to === 0 ? "" : `translateX(${to}px)`;
    return Promise.resolve();
  }
  return Promise.resolve(
    animate(
      el,
      { transform: [`translateX(${from}px)`, `translateX(${to}px)`] },
      { type: spring, bounce: 0, visualDuration: 0.28, velocity },
    ),
  ).then(() => {
    el.style.transform = to === 0 ? "" : `translateX(${to}px)`;
  });
}

/** A bottom sheet rising from, or returning to, the bottom edge. */
export function sheetIn(sheet: HTMLElement, backdrop: HTMLElement): void {
  animate(backdrop, { opacity: [0, 1] }, { duration: 0.2 });
  if (reducedMotion()) return;
  animate(
    sheet,
    { transform: ["translateY(100%)", "translateY(0%)"] },
    { type: spring, bounce: 0, visualDuration: 0.32 },
  );
}

export async function sheetOut(sheet: HTMLElement, backdrop: HTMLElement): Promise<void> {
  const fade = animate(backdrop, { opacity: [1, 0] }, { duration: 0.18 });
  if (!reducedMotion()) {
    const from = getComputedStyle(sheet).transform;
    animate(
      sheet,
      { transform: [from === "none" ? "translateY(0px)" : from, "translateY(100%)"] },
      { duration: 0.18, ease: [0.4, 0, 1, 1] },
    );
  }
  await fade;
}

/** Springs a dragged sheet back into place. */
export function sheetSettle(sheet: HTMLElement, fromY: number): void {
  if (reducedMotion()) {
    sheet.style.transform = "";
    return;
  }
  animate(
    sheet,
    { transform: [`translateY(${fromY}px)`, "translateY(0px)"] },
    { type: spring, bounce: 0, visualDuration: 0.25 },
  );
}

export function toastIn(el: HTMLElement): void {
  if (reducedMotion()) {
    animate(el, { opacity: [0, 1] }, { duration: 0.12 });
    return;
  }
  animate(
    el,
    { transform: ["translateY(12px)", "translateY(0px)"], opacity: [0, 1] },
    { duration: 0.16, ease: EASE_OUT },
  );
}

export async function toastOut(el: HTMLElement): Promise<void> {
  await animate(el, { opacity: [1, 0] }, { duration: 0.12 });
}

/** The check circle filling: the confirmation that a tap registered. */
export function checkPop(el: HTMLElement): void {
  if (reducedMotion()) return;
  animate(el, { transform: ["scale(0.82)", "scale(1)"] }, { duration: 0.12, ease: EASE_OUT });
}
