export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

/**
 * Exponential backoff with full jitter. `attempt` counts completed attempts
 * (1 after the first failure). A provider retry hint is honoured as a minimum.
 */
export function retryDelayMs(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number,
  retryAfterHintMs: number | null = null,
): number {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.floor(random() * ceiling);
  return Math.max(jittered, retryAfterHintMs ?? 0, 1);
}
