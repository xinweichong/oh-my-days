/** Source of the current instant. Injected so behavior tests control time. */
export interface Clock {
  /** Milliseconds since the Unix epoch (UTC instant). */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
