// Motion tokens for the landing page. The curves follow beUI's shared motion
// tokens (beui.dev, lib/ease.ts); springs are tuned for this page.

/** Exponential ease-out: quick to answer, slow to settle. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Content arriving in place: bubbles, rows, calendar blocks. */
export const SPRING_LAND = { type: "spring", stiffness: 380, damping: 32, mass: 0.7 } as const;

/** Press feedback on buttons. */
export const SPRING_PRESS = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } as const;
