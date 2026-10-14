import { countTypingHintStatement, type UserRecord } from "../storage/users";
import { combine, type Reaction } from "./reactions";

/** Guided creations followed by a typing hint, per user. */
export const TYPING_HINT_LIMIT = 3;

const EXAMPLES = { event: "Dinner Fri 7pm", task: "Pay rent by 1 Nov" } as const;

/**
 * Runs a guided creation, passing a one-line hint showing the typed
 * equivalent for the user's first few guided creations.
 */
export async function withTypingHint(
  user: UserRecord,
  kind: keyof typeof EXAMPLES,
  make: (note?: string) => Promise<Reaction>,
): Promise<Reaction> {
  if (user.typingHintsShown >= TYPING_HINT_LIMIT) return make();
  const created = await make(`Next time you can type: ${EXAMPLES[kind]}`);
  return combine(created, {
    replies: [],
    statements: (db) => [countTypingHintStatement(db, user.id, TYPING_HINT_LIMIT)],
  });
}
