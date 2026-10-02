/**
 * Field-level reconciliation between the values an operation was based on, the
 * provider's current values, and the intended values. There is no global
 * last-writer-wins rule: unrelated external edits are preserved, and same-field
 * external edits are surfaced as conflicts for the user to resolve.
 */

/** A record of named field values (e.g. event fields). */
export type FieldValues = object;

function field(values: FieldValues, name: string): unknown {
  return (values as Record<string, unknown>)[name];
}

export interface MergeResult {
  /** Fields that still need writing. Empty with no conflicts means already applied. */
  patch: Record<string, unknown>;
  /** Fields changed externally to a different value since the base was read. */
  conflicts: string[];
}

export function mergeIntended(
  base: FieldValues,
  current: FieldValues,
  intended: FieldValues,
): MergeResult {
  const patch: Record<string, unknown> = {};
  const conflicts: string[] = [];
  for (const name of Object.keys(intended).sort()) {
    const want = field(intended, name);
    const now = field(current, name);
    if (valuesEqual(now, want)) continue;
    if (valuesEqual(now, field(base, name))) patch[name] = want;
    else conflicts.push(name);
  }
  return { patch, conflicts };
}

export interface AppliedChange {
  before: FieldValues;
  after: FieldValues;
}

export type UndoPlan =
  | { eligible: true; patch: Record<string, unknown> }
  | { eligible: false; changedFields: string[] };

/**
 * Undo restores prior values only if every affected field still holds the value
 * this change wrote; it never overwrites a subsequent edit (spec §4).
 */
export function planUndo(change: AppliedChange, current: FieldValues): UndoPlan {
  const changedFields = Object.keys(change.after)
    .sort()
    .filter((name) => !valuesEqual(field(current, name), field(change.after, name)));
  if (changedFields.length > 0) return { eligible: false, changedFields };
  return { eligible: true, patch: { ...change.before } };
}

/** Structural equality for JSON-like values, independent of object key order. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

/** Deterministic JSON: object keys sorted, undefined object members omitted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}
