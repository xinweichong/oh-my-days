/**
 * A boolean SQL expression that must still hold for a statement to take effect.
 *
 * D1 batches run as one transaction but cannot branch on intermediate results.
 * Statements that depend on a lease or version therefore embed the guard in their
 * WHERE clause, and the batch's final statement consumes it. If the guard no
 * longer holds, every statement in the batch is a no-op.
 */
export interface Guard {
  sql: string;
  params: readonly unknown[];
}

export const unguarded: Guard = { sql: "1", params: [] };

export function allOf(...guards: Guard[]): Guard {
  return {
    sql: guards.map((g) => `(${g.sql})`).join(" AND "),
    params: guards.flatMap((g) => g.params),
  };
}
