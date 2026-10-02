export const OPERATION_STATUSES = [
  "awaiting_confirmation",
  "ready",
  "applying",
  "retry_wait",
  "succeeded",
  "needs_resolution",
  "auth_required",
  "failed",
  "cancelled",
] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

const TRANSITIONS: Record<OperationStatus, readonly OperationStatus[]> = {
  awaiting_confirmation: ["ready", "cancelled"],
  ready: ["applying", "cancelled"],
  applying: [
    "succeeded",
    "retry_wait",
    "needs_resolution",
    "auth_required",
    "failed",
    // Revalidation found that what the user confirmed no longer matches.
    "awaiting_confirmation",
    // A lease expired mid-attempt; another worker reclaims it.
    "applying",
  ],
  retry_wait: ["applying", "cancelled"],
  // Resolution and reauthorization resume through a fresh confirmation or retry.
  needs_resolution: ["ready", "awaiting_confirmation", "cancelled"],
  auth_required: ["ready", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: OperationStatus, to: OperationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: OperationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Statuses from which a worker may claim an operation (subject to due time and leases). */
export const CLAIMABLE_STATUSES = [
  "ready",
  "retry_wait",
] as const satisfies readonly OperationStatus[];

/** The facts about a change that decide whether the user must confirm it first. */
export interface ChangeImpact {
  deletesOrCancels: boolean;
  scope: "single" | "series";
  notifiesAttendees: boolean;
}

/**
 * Spec §4: deletion/cancellation, entire-series changes, and anything that
 * notifies attendees require confirmation. Clear creates and edits do not.
 */
export function requiresConfirmation(impact: ChangeImpact): boolean {
  return impact.deletesOrCancels || impact.scope === "series" || impact.notifiesAttendees;
}
