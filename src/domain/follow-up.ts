import { parseLocalDate, parseWallTime } from "./parse-input";
import type { LocalDate, WallTime } from "./time";

/**
 * Follow-up instructions about one item (spec §4), recognized deterministically
 * from a small fixed grammar. Anything else is not a follow-up.
 */
export type FollowUp =
  | { kind: "move"; date: LocalDate | null; time: WallTime | null }
  | { kind: "rename"; title: string }
  | { kind: "delete" }
  | { kind: "done" };

export function parseFollowUp(input: string, today: LocalDate): FollowUp | null {
  const text = input.trim().replace(/\s+/g, " ");
  let m = /^(?:move|reschedule|change|push)(?: it| this)?(?: to)? (.+)$/i.exec(text);
  if (m) return parseWhen(m[1] ?? "", today);
  m = /^rename(?: it| this)?(?: to)? (.+)$/i.exec(text);
  if (m && (m[1] ?? "").length <= 200) return { kind: "rename", title: (m[1] ?? "").trim() };
  if (/^(?:delete|cancel|remove)(?: it| this)?$/i.test(text)) return { kind: "delete" };
  if (/^(?:done|finished|complete(?: it)?|mark (?:it |this )?(?:as )?done)$/i.test(text)) {
    return { kind: "done" };
  }
  return null;
}

/** "4pm", "9 Oct", "tomorrow 4pm", "9 Oct 16:00". */
function parseWhen(value: string, today: LocalDate): FollowUp | null {
  const time = parseWallTime(value);
  if (time) return { kind: "move", date: null, time };
  const date = parseLocalDate(value, today);
  if (date) return { kind: "move", date, time: null };
  const split = value.lastIndexOf(" ");
  if (split > 0) {
    const d = parseLocalDate(value.slice(0, split), today);
    const t = parseWallTime(value.slice(split + 1));
    if (d && t) return { kind: "move", date: d, time: t };
  }
  return null;
}
