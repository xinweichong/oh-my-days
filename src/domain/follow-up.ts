import { parseWhen, type When } from "./parse-input";
import type { LocalDate } from "./time";

/**
 * Follow-up instructions about one item (spec §4), recognized deterministically
 * from a small fixed grammar. Anything else is not a follow-up.
 */
export type FollowUp =
  | ({ kind: "move" } & When)
  /** The new date or time is ambiguous ("move it to Friday" on a Friday): ask. */
  | { kind: "choose_move"; options: When[] }
  | { kind: "rename"; title: string }
  | { kind: "delete" }
  | { kind: "done" };

export function parseFollowUp(input: string, today: LocalDate): FollowUp | null {
  const text = input
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^actually,? /i, "");
  let m =
    /^(?:move|reschedule|change|push|make that|make it)(?: it| this)?(?: to)? (.+?)\.?$/i.exec(
      text,
    );
  if (m) {
    const options = parseWhen(m[1] ?? "", today);
    if (!options) return null;
    const [only] = options;
    return options.length === 1 && only
      ? { kind: "move", ...only }
      : { kind: "choose_move", options };
  }
  m = /^rename(?: it| this)?(?: to)? (.+)$/i.exec(text);
  if (m && (m[1] ?? "").length <= 200) return { kind: "rename", title: (m[1] ?? "").trim() };
  if (/^(?:delete|cancel|remove)(?: it| this)?$/i.test(text)) return { kind: "delete" };
  if (/^(?:done|finished|complete(?: it)?|mark (?:it |this )?(?:as )?done)$/i.test(text)) {
    return { kind: "done" };
  }
  return null;
}
