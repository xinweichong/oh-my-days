import { MAX_BULK_WRITE } from "../limits";

/** Pure (no page or network access), so the Worker tests can run it against the real API. */

/**
 * Sends one bulk change in parts the server accepts (MAX_BULK_WRITE tasks
 * each), one after another, and reports them as one result. A refused part
 * stops the rest, and the summary says so; parts already sent stay done.
 */
export async function inParts<T>(
  items: T[],
  send: (part: T[]) => Promise<{ applied: number }>,
  size = MAX_BULK_WRITE,
): Promise<{ applied: number; error: unknown }> {
  let applied = 0;
  for (let i = 0; i < items.length; i += size) {
    try {
      applied += (await send(items.slice(i, i + size))).applied;
    } catch (error) {
      return { applied, error };
    }
  }
  return { applied, error: null };
}

function count(n: number): string {
  return n === 1 ? "1 task" : `${n} tasks`;
}

/** "Completed 47 tasks. 2 changed elsewhere…", as the server words one part. */
export function bulkSummary(
  verb: string,
  requested: number,
  result: { applied: number; error: unknown },
  note = "",
  describe: (error: unknown) => string = String,
): string {
  const { applied, error } = result;
  if (error) {
    const done = applied ? `${verb} ${count(applied)}.${note} ` : "";
    return `${done}The rest weren't changed: ${describe(error)}`;
  }
  const left = requested - applied;
  const alone =
    left === 0
      ? ""
      : left === 1
        ? " 1 changed elsewhere and was left as it was."
        : ` ${left} changed elsewhere and were left as they were.`;
  return applied === 0
    ? `Nothing was changed.${alone}`
    : `${verb} ${count(applied)}.${note}${alone}`;
}
