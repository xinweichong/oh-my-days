import type { CalendarDirectory, CalendarPort } from "../calendar/port";
import type { IdGenerator } from "../shared/ids";
import type { ClaimedOperation, OperationRecord } from "../storage/operations";
import type { UserRecord } from "../storage/users";
import type { Reaction } from "./reactions";

/** What the user sees and confirms. `facts` binds the confirmation to exact values. */
export interface Preview {
  text: string;
  confirmLabel: string;
  facts: unknown;
}

export type ExecutionOutcome =
  | { kind: "succeeded"; result: unknown }
  | {
      kind: "retry";
      errorClass: string;
      retryAfterMs?: number | null;
      /** The provider may have applied the change; reconcile before writing again. */
      outcomeUnknown?: boolean;
    }
  | { kind: "needs_resolution"; reason: string; details?: unknown }
  /** What the user confirmed no longer matches the target; ask again. */
  | { kind: "needs_reconfirmation"; intent: unknown; preview: Preview }
  | { kind: "auth_required" }
  | { kind: "failed"; errorClass: string };

/** Events the user is told about. `pending` is sent once, on the first retry. */
export type NoticeEvent =
  | { kind: "pending"; outcomeUnknown: boolean }
  | Exclude<ExecutionOutcome, { kind: "retry" }>;

export interface ExecutionContext {
  op: ClaimedOperation;
  user: UserRecord;
  /** Null when the user has no usable Google connection. */
  calendar: CalendarPort | null;
  directory: CalendarDirectory | null;
  now: number;
}

export interface SucceededContext {
  op: OperationRecord;
  user: UserRecord;
  result: unknown;
  now: number;
  ids: IdGenerator;
  db: D1Database;
}

/** A proposed change entering the shared command pipeline. */
export interface Proposal {
  kind: string;
  /** Unique per user; retries of the same request map to the same operation. */
  idempotencyKey: string;
  intent: unknown;
  /** Present when the change must be confirmed before it runs (spec §4). */
  confirmation: Preview | null;
}

export interface OperationHandler {
  kind: string;
  /**
   * Performs one attempt. Must read current provider state before writing and
   * treat `op.outcomeUnknown` as "a previous attempt may already have applied".
   */
  execute(ctx: ExecutionContext): Promise<ExecutionOutcome>;
  /** User-facing text for an outcome, or null to stay quiet. */
  notice(op: OperationRecord, event: NoticeEvent, user: UserRecord): string | null;
  /**
   * Local state and follow-up messages committed atomically with success, after
   * the result notice (e.g. recording a created calendar and the next setup step).
   */
  onSucceeded?(ctx: SucceededContext): Promise<Reaction>;
  /**
   * The inverse change offered as Undo after success, if any. Undo follows the
   * normal confirmation rules: an inverse that deletes still asks first.
   */
  inverse?(op: OperationRecord, user: UserRecord): Omit<Proposal, "idempotencyKey"> | null;
}

export type HandlerRegistry = ReadonlyMap<string, OperationHandler>;

export function registry(...handlers: OperationHandler[]): HandlerRegistry {
  return new Map(handlers.map((h) => [h.kind, h]));
}
